//! The pictures of copied regions on the Linux clipboard.
//!
//! The frontend builds the pictures itself, an SVG with outlined text and a PNG drawn from it
//!; on Linux they are offered through the GTK clipboard, beside the regions snippet.

/// The GTK clipboard with the regions snippet, a PNG and an SVG beside it.
/// On Linux the clipboard is written natively: WebKitGTK refused the web
/// clipboard item that carries a picture, so the snippet arrived alone. Must run on the GTK main
/// thread; the app keeps the data and serves it to whichever application pastes, in the form it asks.
#[cfg(target_os = "linux")]
pub fn write_clipboard_linux(
    text: String,
    png: Vec<u8>,
    svg: Option<String>,
) -> Result<(), String> {
    use gtk::{gdk, TargetEntry, TargetFlags};
    const PNG: u32 = 0;
    const TEXT: u32 = 1;
    const SVG: u32 = 2;
    let mut targets = Vec::new();
    // A vector picture first: an application that takes both prefers what is offered first.
    if svg.is_some() {
        targets.push(TargetEntry::new("image/svg+xml", TargetFlags::empty(), SVG));
    }
    targets.extend([
        TargetEntry::new("image/png", TargetFlags::empty(), PNG),
        TargetEntry::new("text/plain;charset=utf-8", TargetFlags::empty(), TEXT),
        TargetEntry::new("UTF8_STRING", TargetFlags::empty(), TEXT),
        TargetEntry::new("text/plain", TargetFlags::empty(), TEXT),
        TargetEntry::new("STRING", TargetFlags::empty(), TEXT),
        TargetEntry::new("TEXT", TargetFlags::empty(), TEXT),
    ]);
    let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
    let written = clipboard.set_with_data(&targets, move |_, selection, info| match info {
        PNG => selection.set(&gdk::Atom::intern("image/png"), 8, &png),
        SVG => {
            if let Some(svg) = &svg {
                selection.set(&gdk::Atom::intern("image/svg+xml"), 8, svg.as_bytes());
            }
        }
        _ => {
            selection.set_text(&text);
        }
    });
    if written {
        Ok(())
    } else {
        Err("the clipboard could not be taken".to_string())
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>"#;

    /// Needs a desktop session (run with `--ignored` under Wayland or X11).
    #[test]
    #[ignore]
    fn the_linux_clipboard_offers_the_pictures_and_the_text() {
        gtk::init().expect("a display");
        let png = equavela_core::image::base64_decode(PNG).unwrap();
        write_clipboard_linux("- id: p1\n".to_string(), png.clone(), Some(SVG.to_string()))
            .unwrap();
        let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
        let targets: Vec<String> = clipboard
            .wait_for_targets()
            .unwrap_or_default()
            .iter()
            .map(|t| t.name().to_string())
            .collect();
        assert!(targets.contains(&"image/png".to_string()), "{targets:?}");
        assert!(
            targets.contains(&"image/svg+xml".to_string()),
            "{targets:?}"
        );
        assert!(
            targets.iter().any(|t| t.starts_with("text/plain")),
            "{targets:?}"
        );
        assert_eq!(clipboard.wait_for_text().as_deref(), Some("- id: p1\n"));
        let data = clipboard
            .wait_for_contents(&gtk::gdk::Atom::intern("image/png"))
            .expect("the PNG");
        assert_eq!(data.data(), png);
        let data = clipboard
            .wait_for_contents(&gtk::gdk::Atom::intern("image/svg+xml"))
            .expect("the SVG");
        assert_eq!(data.data(), SVG.as_bytes());
    }

    /// Serves the clipboard for `EQUAVELA_SERVE_SECONDS` so another application can paste from it.
    #[test]
    #[ignore]
    fn serve_the_linux_clipboard_for_a_while() {
        gtk::init().expect("a display");
        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        gtk::prelude::WidgetExt::show_all(&window);
        let png = equavela_core::image::base64_decode(PNG).unwrap();
        let seconds: u64 = std::env::var("EQUAVELA_SERVE_SECONDS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(20);
        let start = std::time::Instant::now();
        let mut written = false;
        while start.elapsed().as_secs() < seconds {
            gtk::main_iteration_do(false);
            if !written && start.elapsed().as_millis() > 1500 {
                eprintln!(
                    "WRITE {:?}",
                    write_clipboard_linux(
                        "- id: p1\n".to_string(),
                        png.clone(),
                        Some(SVG.to_string())
                    )
                );
                written = true;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}
