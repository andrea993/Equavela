//! Image regions: the `.eqv` round trip and the SVG sanitizer.

use equavela_core::image::{
    base64_decode, base64_encode, natural_size_pt, resource_from_bytes, sanitize_svg, ImageMedia,
    ImageResource,
};
use equavela_core::project::{DocumentId, DocumentRegion};
use equavela_core::worksheet_file::parse_document;
use equavela_core::worksheet_writer::write_document;

/// A valid 2x1 PNG (a real file, 69 bytes).
fn png() -> Vec<u8> {
    base64_decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEElEQVR4nGP4z8Dwn4EBDAAZ+wP9PKaI+AAAAABJRU5ErkJggg==",
    )
    .unwrap()
}

fn jpeg() -> Vec<u8> {
    // SOI, APP0-less SOF0 with 3 x 2 pixels, EOI: enough for the header reader.
    vec![
        0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0x01, 0x11, 0x00,
        0xFF, 0xD9,
    ]
}

const SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>"#;

fn worksheet() -> String {
    let (svg, _) = resource_from_bytes(SVG.as_bytes()).unwrap();
    let png = ImageResource {
        media: ImageMedia::Png,
        data: png(),
    };
    let jpeg = ImageResource {
        media: ImageMedia::Jpeg,
        data: jpeg(),
    };
    let id = DocumentId::new("Untitled-1.eqv").unwrap();
    let mut loaded = parse_document(id, "format: equavela-worksheet/3\nregions: []\n").unwrap();
    let doc = &mut loaded.document;
    doc.resources.insert("img1".into(), png);
    doc.resources.insert("img2".into(), svg);
    doc.resources.insert("img3".into(), jpeg);
    doc.resources.insert(
        "unused".into(),
        ImageResource {
            media: ImageMedia::Png,
            data: self::png(),
        },
    );
    for (n, (resource, size)) in [
        ("img1", [30.0, 15.0]),
        ("img2", [80.0, 40.0]),
        ("img3", [12.5, 12.5]),
    ]
    .into_iter()
    .enumerate()
    {
        doc.regions.push(std::sync::Arc::new(DocumentRegion::Image(
            equavela_core::image::ImageRegion {
                id: format!("r{}", n + 1),
                page: 1,
                x: 54.0,
                y: 72.0 + 100.0 * n as f64,
                enabled: true,
                resource: resource.into(),
                size,
            },
        )));
    }
    write_document(doc).unwrap()
}

#[test]
fn image_regions_round_trip_byte_for_byte() {
    let text = worksheet();
    assert!(
        text.contains("image:\n      resource: img1\n      size: [30, 15]"),
        "{text}"
    );
    assert!(text.contains("\nresources:\n"), "{text}");
    assert!(
        !text.contains("unused"),
        "an unreferenced resource is dropped"
    );
    assert!(
        text.contains("    media: svg\n    text: |\n      <svg xmlns="),
        "{text}"
    );
    let id = DocumentId::new("Untitled-1.eqv").unwrap();
    let loaded = parse_document(id, &text).unwrap();
    assert_eq!(loaded.document.regions.len(), 3);
    assert_eq!(loaded.document.resources["img1"].data, png());
    assert_eq!(loaded.document.resources["img3"].data, jpeg());
    assert_eq!(write_document(&loaded.document).unwrap(), text);
}

#[test]
fn a_bad_resource_or_reference_is_a_load_error() {
    let id = || DocumentId::new("x.eqv").unwrap();
    let head = "format: equavela-worksheet/3\nregions:\n  - id: r1\n    at: [0, 0]\n    image:\n      resource: a\n      size: [10, 10]\n";
    let missing = parse_document(id(), head).err().unwrap().to_string();
    assert!(missing.contains("resource `a` does not exist"), "{missing}");
    let bad_media = format!("{head}resources:\n  a:\n    media: gif\n    base64: AAAA\n");
    assert!(parse_document(id(), &bad_media).is_err());
    let mismatch = format!("{head}resources:\n  a:\n    media: png\n    base64: AAAA\n");
    let error = parse_document(id(), &mismatch).err().unwrap().to_string();
    assert!(error.contains("not a valid png"), "{error}");
    let bad_b64 = format!("{head}resources:\n  a:\n    media: png\n    base64: '!!!!'\n");
    assert!(parse_document(id(), &bad_b64).is_err());
}

#[test]
fn base64_round_trips_all_lengths() {
    for len in 0..40usize {
        let data: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
        assert_eq!(base64_decode(&base64_encode(&data)).unwrap(), data);
    }
    assert_eq!(base64_encode(b"Man"), "TWFu");
    assert!(base64_decode("TWF").is_err() || base64_decode("TWF").unwrap() == b"Ma");
}

#[test]
fn natural_sizes_are_in_points() {
    let (svg, _) = resource_from_bytes(SVG.as_bytes()).unwrap();
    assert_eq!(natural_size_pt(&svg), Some([30.0, 15.0]));
    let png = ImageResource {
        media: ImageMedia::Png,
        data: png(),
    };
    assert_eq!(natural_size_pt(&png), Some([1.5, 0.75]));
    let jpeg = ImageResource {
        media: ImageMedia::Jpeg,
        data: jpeg(),
    };
    assert_eq!(natural_size_pt(&jpeg), Some([2.25, 1.5]));
}

#[test]
fn the_sanitizer_removes_scripts_references_and_handlers() {
    let evil = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)" viewBox="0 0 10 10">
<script>alert(1)</script>
<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>
<image href="http://evil.example/x.png" width="5" height="5"/>
<a href="javascript:alert(1)"><rect width="1" height="1"/></a>
<style>@import url(http://evil.example/x.css); rect { fill: red }</style>
<style>rect { fill: blue }</style>
<use xlink:href="http://evil.example/a.svg#x"/>
<use xlink:href="#ok"/>
<rect id="ok" width="3" height="3" style="fill:url(http://evil.example/p)" onclick="x()" fill="url(#g)"/>
<circle r="2" fill="url(http://evil.example/q)"/>
<animate attributeName="x"/>
<set attributeName="href" to="javascript:alert(1)"/>
</svg>"##;
    let clean = sanitize_svg(evil).unwrap();
    let t = &clean.text;
    for bad in [
        "script",
        "foreignObject",
        "<image",
        "onload",
        "onclick",
        "evil.example",
        "javascript",
        "@import",
        "<animate",
        "<set",
        "<a ",
    ] {
        assert!(!t.contains(bad), "`{bad}` survived: {t}");
    }
    assert!(t.contains("xlink:href=\"#ok\""), "{t}");
    assert!(t.contains("fill=\"url(#g)\""), "{t}");
    assert!(t.contains("rect { fill: blue }"), "{t}");
    assert!(!clean.removed.is_empty());
    // Idempotent: sanitizing the result changes nothing.
    assert_eq!(sanitize_svg(t).unwrap().text, *t);
    assert!(sanitize_svg(t).unwrap().removed.is_empty());
}

#[test]
fn the_sanitizer_refuses_non_svg_and_entities() {
    assert!(sanitize_svg("<html/>").is_err());
    assert!(sanitize_svg("not xml").is_err());
    let bomb =
        r#"<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>"#;
    assert!(sanitize_svg(bomb).is_err());
    assert!(resource_from_bytes(b"GIF89a").is_err());
}

const ASSET_HEAD: &str = "format: equavela-worksheet/3\nregions:\n  - id: r1\n    at: [0, 0]\n    image:\n      resource: a\n      size: [10, 10]\n  - id: r2\n    at: [0, 100]\n    image:\n      resource: b\n      size: [10, 10]\n";

#[test]
fn project_asset_resources_round_trip_beside_embedded_ones() {
    // an asset resource names a project file; it shares the id order with bytes.
    let text = format!(
        "{ASSET_HEAD}resources:\n  a:\n    media: png\n    asset: assets/images/beam.png\n  b:\n    media: png\n    base64: |\n      {}\n",
        base64_encode(&png())
    );
    let id = DocumentId::new("x.eqv").unwrap();
    let loaded = parse_document(id, &text).unwrap();
    let document = &loaded.document;
    assert_eq!(document.assets["a"].path, "assets/images/beam.png");
    assert_eq!(document.assets["a"].media, ImageMedia::Png);
    assert!(!document.resources.contains_key("a"));
    assert_eq!(document.resources["b"].data, png());
    assert_eq!(document.image_media("a"), Some(ImageMedia::Png));
    let written = write_document(document).unwrap();
    assert!(
        written.contains(
            "resources:\n  a:\n    media: png\n    asset: assets/images/beam.png\n  b:\n"
        ),
        "{written}"
    );
    let id = DocumentId::new("x.eqv").unwrap();
    let reread = parse_document(id, &written).unwrap();
    assert_eq!(reread.document.assets, document.assets);
    assert_eq!(write_document(&reread.document).unwrap(), written);
}

#[test]
fn a_bad_asset_resource_is_a_load_error() {
    let id = || DocumentId::new("x.eqv").unwrap();
    let b = format!(
        "  b:\n    media: png\n    base64: |\n      {}\n",
        base64_encode(&png())
    );
    let error = |asset: &str| {
        parse_document(id(), &format!("{ASSET_HEAD}resources:\n  a:\n{asset}{b}"))
            .err()
            .map(|error| error.to_string())
    };
    assert!(error("    media: png\n    asset: assets/images/a.png\n").is_none());
    assert!(error("    media: jpeg\n    asset: assets/images/A.JPG\n").is_none());
    for (asset, expected) in [
        (
            "    media: png\n    asset: images/a.png\n",
            "under `assets/`",
        ),
        ("    media: png\n    asset: assets/../a.png\n", "`..`"),
        ("    media: png\n    asset: /assets/a.png\n", "relative"),
        (
            "    media: png\n    asset: assets/images/a.svg\n",
            "does not match",
        ),
        (
            "    media: png\n    base64: AAAA\n    asset: assets/images/a.png\n",
            "exactly one of",
        ),
    ] {
        let message = error(asset).unwrap_or_default();
        assert!(message.contains(expected), "{asset}: {message}");
    }
}
