//! Printing to PDF.
//!
//! The web view prints its own DOM (the print view that the frontend has put in place). The platform
//! adapters here only turn that DOM into a PDF file: WebView2 `PrintToPdf` on Windows, the WebKitGTK
//! print operation on Linux. Both then go through
//! [`crop_to_page`], which sets the exact page size.

use lopdf::{Document, Object};
use serde::Serialize;
use std::path::Path;

/// Extra size requested from the print engine, points. The engine quantizes the page size (steps of
/// about 0.24 pt) and shrinks content that is wider than its page, so the page is requested larger
/// than the content and cropped afterwards.
pub const PAGE_SLACK_PT: f64 = 1.0;

/// Tolerance when comparing page sizes, points.
const SIZE_TOLERANCE_PT: f64 = 0.01;

/// What an export produced.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportedPdf {
    pub path: String,
    pub pages: usize,
    pub width_pt: f64,
    pub height_pt: f64,
}

/// The page size to request from the print engine for a page of `width_pt` x `height_pt`, in portrait
/// terms (short side first) with the orientation: `(width_in, height_in, landscape)`.
pub fn request_size(width_pt: f64, height_pt: f64) -> (f64, f64, bool) {
    let landscape = width_pt > height_pt;
    let (short, long) = if landscape {
        (height_pt, width_pt)
    } else {
        (width_pt, height_pt)
    };
    (
        (short + PAGE_SLACK_PT) / 72.0,
        (long + PAGE_SLACK_PT) / 72.0,
        landscape,
    )
}

/// WebKitGTK fits the content width to the requested paper. A quarter point covers its page-size
/// quantization with much less horizontal scaling; extra height prevents a trailing blank page.
#[cfg(target_os = "linux")]
pub fn request_linux_size(width_pt: f64, height_pt: f64) -> (f64, f64, bool) {
    let width = width_pt + 0.25;
    let height = height_pt + 4.0;
    let landscape = width_pt > height_pt;
    if landscape {
        (height, width, true)
    } else {
        (width, height, false)
    }
}

fn number(object: &Object) -> Option<f64> {
    match object {
        Object::Integer(value) => Some(*value as f64),
        Object::Real(value) => Some(f64::from(*value)),
        _ => None,
    }
}

/// The `MediaBox` of a page, looked up through the parents (it is inheritable).
fn media_box(document: &Document, page: lopdf::ObjectId) -> Result<[f64; 4], String> {
    let mut current = page;
    for _ in 0..32 {
        let dictionary = document
            .get_dictionary(current)
            .map_err(|error| error.to_string())?;
        if let Ok(object) = dictionary.get(b"MediaBox") {
            let object = match object {
                Object::Reference(id) => document
                    .get_object(*id)
                    .map_err(|error| error.to_string())?,
                other => other,
            };
            let values = object
                .as_array()
                .map_err(|_| "MediaBox is not an array".to_string())?;
            let numbers: Vec<f64> = values.iter().filter_map(number).collect();
            if let [x0, y0, x1, y1] = numbers[..] {
                return Ok([x0, y0, x1, y1]);
            }
            return Err("MediaBox does not hold four numbers".to_string());
        }
        match dictionary.get(b"Parent") {
            Ok(Object::Reference(parent)) => current = *parent,
            _ => break,
        }
    }
    Err("page without a MediaBox".to_string())
}

/// The size in points of every page (the `MediaBox`).
pub fn page_sizes(path: &Path) -> Result<Vec<(f64, f64)>, String> {
    let document = Document::load(path).map_err(|error| format!("cannot read the PDF: {error}"))?;
    let mut sizes = Vec::new();
    for (_, id) in document.get_pages() {
        let [x0, y0, x1, y1] = media_box(&document, id)?;
        sizes.push((x1 - x0, y1 - y0));
    }
    Ok(sizes)
}

/// Sets the `MediaBox` and `CropBox` of every page to exactly `width_pt` x `height_pt`, keeping the
/// top-left corner of the page the engine produced (PDF space has its origin at the bottom left, so
/// the box is `[x0, y1 - height, x0 + width, y1]`). Fails when there is no page or a page is smaller
/// than the requested size (the content would be cut). Returns the page count.
pub fn crop_to_page(path: &Path, width_pt: f64, height_pt: f64) -> Result<usize, String> {
    let mut document =
        Document::load(path).map_err(|error| format!("cannot read the PDF: {error}"))?;
    let pages = document.get_pages();
    if pages.is_empty() {
        return Err("the PDF has no page".to_string());
    }
    for (number_of_page, id) in &pages {
        let [x0, y0, x1, y1] = media_box(&document, *id)?;
        if x1 - x0 < width_pt - SIZE_TOLERANCE_PT || y1 - y0 < height_pt - SIZE_TOLERANCE_PT {
            return Err(format!(
                "page {number_of_page} is {:.2} x {:.2} pt, smaller than the requested {width_pt:.2} x {height_pt:.2} pt",
                x1 - x0,
                y1 - y0
            ));
        }
        let new_box = Object::Array(vec![
            Object::Real(x0 as f32),
            Object::Real((y1 - height_pt) as f32),
            Object::Real((x0 + width_pt) as f32),
            Object::Real(y1 as f32),
        ]);
        let _ = y0;
        let dictionary = document
            .get_dictionary_mut(*id)
            .map_err(|error| error.to_string())?;
        dictionary.set("MediaBox", new_box.clone());
        dictionary.set("CropBox", new_box);
    }
    document
        .save(path)
        .map_err(|error| format!("cannot write the PDF: {error}"))?;
    Ok(pages.len())
}

/// A private output beside the destination, published only after printing and cropping succeed.
pub struct PendingPdf {
    directory: tempfile::TempDir,
    destination: std::path::PathBuf,
}

impl PendingPdf {
    pub fn new(path: &Path) -> Result<Self, String> {
        let destination = std::path::absolute(path).map_err(|error| error.to_string())?;
        let parent = destination
            .parent()
            .ok_or("PDF destination has no parent directory")?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let directory = tempfile::Builder::new()
            .prefix(".equavela-pdf-")
            .tempdir_in(parent)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            directory,
            destination,
        })
    }

    pub fn path(&self) -> std::path::PathBuf {
        self.directory.path().join("output.pdf")
    }

    pub fn publish(self) -> Result<std::path::PathBuf, String> {
        std::fs::rename(self.path(), &self.destination)
            .map_err(|error| format!("cannot replace the PDF: {error}"))?;
        Ok(self.destination.clone())
    }
}

/// WebView2 wants a plain Win32 path, not the `\\?\` form.
pub fn plain_path(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_string()
}

#[cfg(windows)]
pub mod windows_adapter {
    //! WebView2 `PrintToPdf` (spike E, `spikes/e-wysiwyg/src-tauri/src/lib.rs`).

    use std::sync::mpsc;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_2, ICoreWebView2_7,
        COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING};

    /// Starts `PrintToPdf` on the UI thread; the outcome is delivered through `tx`. WebView2 takes the
    /// page size in portrait terms and swaps it for landscape.
    pub fn print_to_pdf(
        webview: tauri::webview::PlatformWebview,
        path: String,
        width_in: f64,
        height_in: f64,
        landscape: bool,
        tx: mpsc::Sender<Result<(), String>>,
    ) {
        let result = (|| -> Result<(), String> {
            let error = |e: windows::core::Error| e.to_string();
            let controller = webview.controller();
            let core = unsafe { controller.CoreWebView2() }.map_err(error)?;
            let core7: ICoreWebView2_7 = core.cast().map_err(error)?;
            let core2: ICoreWebView2_2 = core.cast().map_err(error)?;
            let environment = unsafe { core2.Environment() }.map_err(error)?;
            let environment6: ICoreWebView2Environment6 = environment.cast().map_err(error)?;
            let settings = unsafe { environment6.CreatePrintSettings() }.map_err(error)?;
            unsafe {
                settings
                    .SetOrientation(if landscape {
                        COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
                    } else {
                        COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
                    })
                    .map_err(error)?;
                settings.SetScaleFactor(1.0).map_err(error)?;
                settings.SetPageWidth(width_in).map_err(error)?;
                settings.SetPageHeight(height_in).map_err(error)?;
                settings.SetMarginTop(0.0).map_err(error)?;
                settings.SetMarginBottom(0.0).map_err(error)?;
                settings.SetMarginLeft(0.0).map_err(error)?;
                settings.SetMarginRight(0.0).map_err(error)?;
                settings.SetShouldPrintBackgrounds(true).map_err(error)?;
                settings.SetShouldPrintSelectionOnly(false).map_err(error)?;
                settings
                    .SetShouldPrintHeaderAndFooter(false)
                    .map_err(error)?;
            }
            let done = tx.clone();
            let handler = PrintToPdfCompletedHandler::create(Box::new(move |outcome, ok| {
                let reported = match outcome {
                    Ok(()) if ok => Ok(()),
                    Ok(()) => Err("PrintToPdf reported failure".to_string()),
                    Err(e) => Err(e.to_string()),
                };
                let _ = done.send(reported);
                Ok(())
            }));
            unsafe { core7.PrintToPdf(&HSTRING::from(path), &settings, &handler) }.map_err(error)
        })();
        if let Err(message) = result {
            let _ = tx.send(Err(message));
        }
    }
}

#[cfg(target_os = "linux")]
pub mod linux_adapter {
    //! WebKitGTK print operation to a PDF file. written without a Linux machine;
    //! the regression driver must be run on Linux before this is trusted.

    use std::sync::mpsc;
    use webkit2gtk::{PrintOperation, PrintOperationExt, SettingsExt, WebViewExt};

    fn output_uri(path: &std::path::Path) -> Result<String, String> {
        gtk::glib::filename_to_uri(path, None)
            .map(|uri| uri.to_string())
            .map_err(|error| error.to_string())
    }

    /// Starts the print operation on the UI thread; the outcome is delivered through `tx`. The page
    /// size is given in portrait terms (GTK rotates it for landscape).
    pub fn print_to_pdf(
        webview: tauri::webview::PlatformWebview,
        path: &std::path::Path,
        width_pt: f64,
        height_pt: f64,
        landscape: bool,
        tx: mpsc::Sender<Result<(), String>>,
    ) {
        print_view(&webview.inner(), path, width_pt, height_pt, landscape, tx);
    }

    fn print_view(
        view: &webkit2gtk::WebView,
        path: &std::path::Path,
        width_pt: f64,
        height_pt: f64,
        landscape: bool,
        tx: mpsc::Sender<Result<(), String>>,
    ) {
        let uri = match output_uri(path) {
            Ok(uri) => uri,
            Err(error) => {
                let _ = tx.send(Err(error));
                return;
            }
        };
        if let Some(settings) = view.settings() {
            settings.set_print_backgrounds(true);
        }
        let operation = PrintOperation::new(view);

        let settings = gtk::PrintSettings::new();
        settings.set("printer", Some("Print to File"));
        settings.set("output-file-format", Some("pdf"));
        settings.set("output-uri", Some(&uri));

        let paper = gtk::PaperSize::new_custom(
            "Equavela",
            "Equavela",
            width_pt,
            height_pt,
            gtk::Unit::Points,
        );
        let setup = gtk::PageSetup::new();
        setup.set_paper_size(&paper);
        setup.set_orientation(if landscape {
            gtk::PageOrientation::Landscape
        } else {
            gtk::PageOrientation::Portrait
        });
        setup.set_top_margin(0.0, gtk::Unit::Points);
        setup.set_bottom_margin(0.0, gtk::Unit::Points);
        setup.set_left_margin(0.0, gtk::Unit::Points);
        setup.set_right_margin(0.0, gtk::Unit::Points);

        operation.set_print_settings(&settings);
        operation.set_page_setup(&setup);
        let finished = tx.clone();
        operation.connect_finished(move |_| {
            let _ = finished.send(Ok(()));
        });
        operation.connect_failed(move |_, error| {
            let _ = tx.send(Err(error.to_string()));
        });
        operation.print();
    }

    #[cfg(test)]
    mod tests {
        use super::{output_uri, print_view};
        use gtk::prelude::*;
        use std::path::Path;
        use std::sync::mpsc;
        use webkit2gtk::{LoadEvent, WebView, WebViewExt};

        #[test]
        fn output_uri_escapes_special_filename_characters() {
            assert_eq!(
                output_uri(Path::new("/tmp/a #1% é.pdf")).unwrap(),
                "file:///tmp/a%20%231%25%20%C3%A9.pdf"
            );
            assert!(output_uri(Path::new("relative.pdf")).is_err());
        }

        /// Run explicitly under Xvfb: this exercises WebKitGTK and GTK's Print to File backend.
        #[test]
        #[ignore = "requires a graphical display and GTK Print to File backend"]
        fn webkit_prints_portrait_and_landscape_pdf() {
            gtk::init().expect("GTK display");
            let directory = tempfile::Builder::new()
                .prefix("equavela print # ")
                .tempdir()
                .unwrap();
            for (width, height) in [(595.28, 841.89), (792.0, 612.0)] {
                let path = directory.path().join(format!("{width} # test.pdf"));
                let window = gtk::Window::new(gtk::WindowType::Toplevel);
                let view = WebView::new();
                window.add(&view);
                window.show_all();
                let (tx, rx) = mpsc::channel();
                let (short, long, landscape) = super::super::request_linux_size(width, height);
                let print_path = path.clone();
                view.connect_load_changed(move |view, event| {
                    if event == LoadEvent::Finished {
                        print_view(view, &print_path, short, long, landscape, tx.clone());
                    }
                });
                let main_loop = gtk::glib::MainLoop::new(None, false);
                let complete = main_loop.clone();
                let result = std::rc::Rc::new(std::cell::RefCell::new(None));
                let received = result.clone();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
                gtk::glib::timeout_add_local(std::time::Duration::from_millis(20), move || {
                    match rx.try_recv() {
                        Ok(value) => *received.borrow_mut() = Some(value),
                        Err(mpsc::TryRecvError::Disconnected) => {
                            *received.borrow_mut() = Some(Err("print channel closed".into()))
                        }
                        Err(mpsc::TryRecvError::Empty) if std::time::Instant::now() >= deadline => {
                            *received.borrow_mut() = Some(Err("print timed out".into()))
                        }
                        Err(mpsc::TryRecvError::Empty) => return gtk::glib::ControlFlow::Continue,
                    }
                    complete.quit();
                    gtk::glib::ControlFlow::Break
                });
                view.load_html(
                    "<!doctype html><style>@page { margin: 0 } html, body { margin: 0 } div { width: 72pt; height: 72pt; background: red }</style><div></div><p>WebKit PDF test</p>",
                    None,
                );
                main_loop.run();
                result
                    .borrow_mut()
                    .take()
                    .expect("completion")
                    .expect("print PDF");
                assert_eq!(super::super::crop_to_page(&path, width, height).unwrap(), 1);
                let size = super::super::page_sizes(&path).unwrap()[0];
                assert!((size.0 - width).abs() < 0.01 && (size.1 - height).abs() < 0.01);
                let pdf = lopdf::Document::load(&path).unwrap();
                let page = *pdf.get_pages().values().next().unwrap();
                let content = lopdf::content::Content::decode(&pdf.get_page_content(page)).unwrap();
                assert!(content
                    .operations
                    .iter()
                    .any(|op| op.operator == "rg"
                        && op.operands == vec![1.into(), 0.into(), 0.into()]));
                assert!(content.operations.iter().any(|op| op.operator == "Tj"));
                window.close();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_request_adds_width_and_height_slack_before_orientation() {
        assert_eq!(request_linux_size(595.28, 841.89), (595.53, 845.89, false));
        assert_eq!(request_linux_size(792.0, 612.0), (616.0, 792.25, true));
    }

    /// A PDF with `pages` pages of `width` x `height` points (MediaBox on the Pages node when
    /// `inherited`, else on every page).
    fn make_pdf(path: &Path, pages: usize, width: f64, height: f64, inherited: bool) {
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let mut kids = Vec::new();
        let boxed = vec![
            Object::Integer(0),
            Object::Integer(0),
            Object::Real(width as f32),
            Object::Real(height as f32),
        ];
        for _ in 0..pages {
            let content =
                document.add_object(Stream::new(dictionary! {}, b"0 0 1 1 re f".to_vec()));
            let mut page = dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "Contents" => content,
            };
            if !inherited {
                page.set("MediaBox", Object::Array(boxed.clone()));
            }
            kids.push(Object::Reference(document.add_object(page)));
        }
        let mut node = dictionary! {
            "Type" => "Pages",
            "Count" => pages as i64,
            "Kids" => kids,
        };
        if inherited {
            node.set("MediaBox", Object::Array(boxed));
        }
        document.objects.insert(pages_id, Object::Dictionary(node));
        let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        document.trailer.set("Root", catalog);
        document.save(path).unwrap();
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("equavela-print-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn the_requested_page_is_one_point_larger_in_portrait_terms() {
        let (w, h, landscape) = request_size(595.28, 841.89);
        assert!(!landscape);
        assert!((w * 72.0 - 596.28).abs() < 1e-9 && (h * 72.0 - 842.89).abs() < 1e-9);
        // Landscape Letter: short side first, orientation set.
        let (w, h, landscape) = request_size(792.0, 612.0);
        assert!(landscape);
        assert!((w * 72.0 - 613.0).abs() < 1e-9 && (h * 72.0 - 793.0).abs() < 1e-9);
    }

    #[test]
    fn crop_sets_the_exact_size_and_keeps_the_top_left_corner() {
        let path = temp("crop.pdf");
        make_pdf(&path, 3, 595.92, 841.92, false);
        assert_eq!(crop_to_page(&path, 595.28, 841.89).unwrap(), 3);
        let sizes = page_sizes(&path).unwrap();
        assert_eq!(sizes.len(), 3);
        for (w, h) in sizes {
            assert!((w - 595.28).abs() < 0.01, "width {w}");
            assert!((h - 841.89).abs() < 0.01, "height {h}");
        }
        // The top edge stays where the engine put it (841.92): the box is [0, 0.03, 595.28, 841.92].
        let document = Document::load(&path).unwrap();
        let (_, id) = document.get_pages().into_iter().next().unwrap();
        let [x0, y0, x1, y1] = media_box(&document, id).unwrap();
        assert!((x0 - 0.0).abs() < 1e-3 && (y0 - 0.03).abs() < 1e-3);
        assert!((x1 - 595.28).abs() < 1e-3 && (y1 - 841.92).abs() < 1e-3);
        let crop = document
            .get_dictionary(id)
            .unwrap()
            .get(b"CropBox")
            .unwrap();
        assert_eq!(crop.as_array().unwrap().len(), 4);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn crop_finds_an_inherited_media_box() {
        let path = temp("inherited.pdf");
        make_pdf(&path, 2, 612.5, 792.5, true);
        assert_eq!(crop_to_page(&path, 612.0, 792.0).unwrap(), 2);
        for (w, h) in page_sizes(&path).unwrap() {
            assert!((w - 612.0).abs() < 0.01 && (h - 792.0).abs() < 0.01);
        }
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn crop_refuses_a_page_smaller_than_requested() {
        let path = temp("small.pdf");
        make_pdf(&path, 1, 594.96, 841.92, false);
        let error = crop_to_page(&path, 595.28, 841.89).unwrap_err();
        assert!(error.contains("smaller than the requested"), "{error}");
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn crop_refuses_a_file_that_is_not_a_pdf() {
        let path = temp("not.pdf");
        std::fs::write(&path, b"hello").unwrap();
        assert!(crop_to_page(&path, 595.0, 842.0).is_err());
        assert!(page_sizes(&path).is_err());
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn pending_output_preserves_existing_file_until_publish() {
        let dir = temp("nested");
        let path = dir.join("deeper").join("out.pdf");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"old").unwrap();
        let pending = PendingPdf::new(&path).unwrap();
        let temporary = pending.path();
        std::fs::write(&temporary, b"invalid PDF").unwrap();
        assert!(crop_to_page(&temporary, 100.0, 100.0).is_err());
        drop(pending);
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        assert!(!temporary.exists());
        let pending = PendingPdf::new(&path).unwrap();
        std::fs::write(pending.path(), b"new").unwrap();
        assert_eq!(pending.publish().unwrap(), path);
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        let _ = std::fs::remove_dir_all(dir);
    }
}
