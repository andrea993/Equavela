//! Image regions: model, media sniffing, base64 and the SVG sanitizer.

use roxmltree::{Document, Node};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A single resource above this size is refused.
pub const MAX_RESOURCE_BYTES: usize = 25 * 1024 * 1024;
pub const MIN_IMAGE_SIZE: f64 = 12.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageMedia {
    Png,
    Jpeg,
    Svg,
}

impl ImageMedia {
    pub fn name(self) -> &'static str {
        match self {
            ImageMedia::Png => "png",
            ImageMedia::Jpeg => "jpeg",
            ImageMedia::Svg => "svg",
        }
    }

    pub fn from_name(name: &str) -> Option<ImageMedia> {
        match name {
            "png" => Some(ImageMedia::Png),
            "jpeg" => Some(ImageMedia::Jpeg),
            "svg" => Some(ImageMedia::Svg),
            _ => None,
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            ImageMedia::Png => "image/png",
            ImageMedia::Jpeg => "image/jpeg",
            ImageMedia::Svg => "image/svg+xml",
        }
    }
}

/// The bytes of an image. An SVG holds its sanitized UTF-8 text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageResource {
    pub media: ImageMedia,
    pub data: Vec<u8>,
}

pub type Resources = BTreeMap<String, ImageResource>;

/// An image stored as a project file instead of bytes. The path is
/// project-relative; the bytes are read, validated and sanitized when the image is drawn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetReference {
    pub media: ImageMedia,
    pub path: String,
}

pub type Assets = BTreeMap<String, AssetReference>;

/// Checks an asset reference: a portable path under `assets/` whose extension matches
/// the media. The file itself is not read.
pub fn validate_asset(asset: &AssetReference) -> Result<(), String> {
    crate::project_manifest::validate_portable_path("asset", &asset.path)
        .map_err(|error| error.to_string())?;
    if !asset.path.starts_with("assets/") {
        return Err(format!("asset `{}` must lie under `assets/`", asset.path));
    }
    let extension = asset
        .path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    let matches = match asset.media {
        ImageMedia::Png => extension == "png",
        ImageMedia::Jpeg => extension == "jpg" || extension == "jpeg",
        ImageMedia::Svg => extension == "svg",
    };
    if !matches {
        return Err(format!(
            "the extension of asset `{}` does not match media `{}`",
            asset.path,
            asset.media.name()
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageRegion {
    pub id: String,
    #[serde(default)]
    pub page: u32,
    pub x: f64,
    pub y: f64,
    #[serde(default = "super::project::enabled_by_default")]
    pub enabled: bool,
    /// Id in the document's `resources`.
    pub resource: String,
    /// Width and height in points.
    pub size: [f64; 2],
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ImageError {
    #[error("the file is not a PNG, JPEG or SVG image")]
    UnknownFormat,
    #[error("the image is larger than {} MiB", MAX_RESOURCE_BYTES / 1024 / 1024)]
    TooLarge,
    #[error("invalid SVG: {0}")]
    Svg(String),
    #[error("invalid base64 data")]
    Base64,
    #[error("the data is not a valid {0} image")]
    Mismatch(&'static str),
}

/// The media type of `bytes` by their magic numbers (an SVG by an `<svg` root).
pub fn sniff(bytes: &[u8]) -> Option<ImageMedia> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(ImageMedia::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageMedia::Jpeg)
    } else if let Ok(text) = std::str::from_utf8(bytes) {
        text.contains("<svg").then_some(ImageMedia::Svg)
    } else {
        None
    }
}

/// Validates raw file bytes and returns the resource to store: an SVG is sanitized, a raster is
/// kept byte for byte.
pub fn resource_from_bytes(bytes: &[u8]) -> Result<(ImageResource, Vec<String>), ImageError> {
    if bytes.len() > MAX_RESOURCE_BYTES {
        return Err(ImageError::TooLarge);
    }
    match sniff(bytes).ok_or(ImageError::UnknownFormat)? {
        ImageMedia::Svg => {
            let text = std::str::from_utf8(bytes).map_err(|e| ImageError::Svg(e.to_string()))?;
            let clean = sanitize_svg(text)?;
            Ok((
                ImageResource {
                    media: ImageMedia::Svg,
                    data: clean.text.into_bytes(),
                },
                clean.removed,
            ))
        }
        media => Ok((
            ImageResource {
                media,
                data: bytes.to_vec(),
            },
            Vec::new(),
        )),
    }
}

/// Pixel size of a PNG or JPEG from its header.
pub fn raster_size(media: ImageMedia, bytes: &[u8]) -> Option<(u32, u32)> {
    match media {
        ImageMedia::Png => {
            if bytes.len() < 24 {
                return None;
            }
            let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
            let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
            Some((w, h))
        }
        ImageMedia::Jpeg => {
            let mut i = 2;
            while i + 9 < bytes.len() {
                if bytes[i] != 0xFF {
                    i += 1;
                    continue;
                }
                let marker = bytes[i + 1];
                if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
                    let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
                    let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
                    return Some((w, h));
                }
                if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
                    i += 2;
                } else {
                    let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
                    i += 2 + len;
                }
            }
            None
        }
        ImageMedia::Svg => None,
    }
}

/// Natural size in points of an image resource, `None` when it has no size.
pub fn natural_size_pt(resource: &ImageResource) -> Option<[f64; 2]> {
    match resource.media {
        ImageMedia::Svg => {
            let text = std::str::from_utf8(&resource.data).ok()?;
            let doc = Document::parse(text).ok()?;
            let root = doc.root_element();
            let length = |name: &str| root.attribute(name).and_then(svg_length_pt);
            match (length("width"), length("height")) {
                (Some(w), Some(h)) if w > 0.0 && h > 0.0 => Some([w, h]),
                _ => {
                    let numbers: Vec<f64> = root
                        .attribute("viewBox")?
                        .split(|c: char| c == ',' || c.is_whitespace())
                        .filter(|p| !p.is_empty())
                        .filter_map(|p| p.parse().ok())
                        .collect();
                    (numbers.len() == 4 && numbers[2] > 0.0 && numbers[3] > 0.0)
                        .then(|| [numbers[2] * 0.75, numbers[3] * 0.75])
                }
            }
        }
        media => {
            let (w, h) = raster_size(media, &resource.data)?;
            (w > 0 && h > 0).then_some([w as f64 * 0.75, h as f64 * 0.75])
        }
    }
}

/// The size of a new image: its natural size, scaled down with the aspect ratio kept to fit
/// `printable_width`; an image without a natural size gets 144 x 108 pt. Rounded to 0.01 pt and at
/// least [`MIN_IMAGE_SIZE`].
pub fn initial_size_pt(natural: Option<[f64; 2]>, printable_width: f64) -> [f64; 2] {
    let [w, h] = natural.unwrap_or([144.0, 108.0]);
    let scale = if printable_width > 0.0 && w > printable_width {
        printable_width / w
    } else {
        1.0
    };
    let round = |v: f64| ((v * scale * 100.0).round() / 100.0).max(MIN_IMAGE_SIZE);
    [round(w), round(h)]
}

fn svg_length_pt(value: &str) -> Option<f64> {
    let value = value.trim();
    let split = value
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == 'e'))
        .unwrap_or(value.len());
    let number: f64 = value[..split].parse().ok()?;
    let factor = match value[split..].trim() {
        "" | "px" => 0.75,
        "pt" => 1.0,
        "in" => 72.0,
        "cm" => 72.0 / 2.54,
        "mm" => 72.0 / 25.4,
        _ => return None,
    };
    Some(number * factor)
}

/// Checks a stored resource: size, magic bytes against `media`, and SVG
/// sanitizing (idempotent). Returns the resource to keep.
pub fn validate_resource(resource: ImageResource) -> Result<ImageResource, ImageError> {
    if resource.data.len() > MAX_RESOURCE_BYTES {
        return Err(ImageError::TooLarge);
    }
    match resource.media {
        ImageMedia::Svg => {
            let text =
                std::str::from_utf8(&resource.data).map_err(|e| ImageError::Svg(e.to_string()))?;
            Ok(ImageResource {
                media: ImageMedia::Svg,
                data: sanitize_svg(text)?.text.into_bytes(),
            })
        }
        media => {
            if sniff(&resource.data) == Some(media) {
                Ok(resource)
            } else {
                Err(ImageError::Mismatch(media.name()))
            }
        }
    }
}

// ---- base64 ------------------------------------------------------------------------------

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Decodes base64, ignoring ASCII whitespace.
pub fn base64_decode(text: &str) -> Result<Vec<u8>, ImageError> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut acc, mut bits, mut padding) = (0u32, 0u32, 0usize);
    for c in text.bytes() {
        if c.is_ascii_whitespace() {
            continue;
        }
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => {
                padding += 1;
                continue;
            }
            _ => return Err(ImageError::Base64),
        };
        if padding > 0 {
            return Err(ImageError::Base64);
        }
        acc = acc << 6 | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    if padding > 2 || (bits > 0 && acc != 0) {
        return Err(ImageError::Base64);
    }
    Ok(out)
}

// ---- SVG sanitizer -----------------------------------------------------------------------

const SVG_NS: &str = "http://www.w3.org/2000/svg";
const XLINK_NS: &str = "http://www.w3.org/1999/xlink";

const ALLOWED: &[&str] = &[
    "svg",
    "g",
    "defs",
    "symbol",
    "use",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "textPath",
    "title",
    "desc",
    "linearGradient",
    "radialGradient",
    "stop",
    "clipPath",
    "marker",
    "pattern",
    "style",
];

/// A sanitized SVG and what was removed to get there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SanitizedSvg {
    pub text: String,
    /// One entry per removed element or attribute kind, with a count, e.g. `<script> x2`.
    pub removed: Vec<String>,
}

fn css_is_safe(css: &str) -> bool {
    let lower = css.to_ascii_lowercase();
    if [
        "@import",
        "javascript:",
        "expression(",
        "behavior",
        "-moz-binding",
    ]
    .iter()
    .any(|bad| lower.contains(bad))
    {
        return false;
    }
    let mut rest = lower.as_str();
    while let Some(i) = rest.find("url(") {
        let after = rest[i + 4..].trim_start_matches([' ', '"', '\'']);
        if !after.starts_with('#') {
            return false;
        }
        rest = &rest[i + 4..];
    }
    true
}

fn value_is_safe(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if lower.contains("javascript:") {
        return false;
    }
    css_is_safe(value) || !lower.contains("url(")
}

fn escape(text: &str, attribute: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' if attribute => out.push_str("&quot;"),
            '\n' if attribute => out.push_str("&#10;"),
            '\r' if attribute => out.push_str("&#13;"),
            '\t' if attribute => out.push_str("&#9;"),
            c => out.push(c),
        }
    }
    out
}

struct Sanitizer {
    out: String,
    removed: BTreeMap<String, usize>,
}

impl Sanitizer {
    fn drop(&mut self, what: String) {
        *self.removed.entry(what).or_default() += 1;
    }

    fn element(&mut self, node: Node, root: bool) {
        let name = node.tag_name().name();
        let in_svg = node.tag_name().namespace() == Some(SVG_NS);
        if !in_svg || !ALLOWED.contains(&name) {
            self.drop(format!("<{name}>"));
            return;
        }
        if name == "style" {
            let css: String = node
                .children()
                .filter_map(|c| c.text())
                .collect::<Vec<_>>()
                .join("");
            if !css_is_safe(&css) {
                self.drop("<style> with unsafe CSS".into());
                return;
            }
            self.out
                .push_str(&format!("<style>{}</style>", escape(&css, false)));
            return;
        }
        self.out.push('<');
        self.out.push_str(name);
        if root {
            self.out
                .push_str(&format!(" xmlns=\"{SVG_NS}\" xmlns:xlink=\"{XLINK_NS}\""));
        }
        for attribute in node.attributes() {
            let local = attribute.name();
            let value = attribute.value();
            let lower = local.to_ascii_lowercase();
            let ns = attribute.namespace();
            if lower.starts_with("on") {
                self.drop(format!("attribute {local}"));
                continue;
            }
            let written = match (ns, local) {
                (None, "href") | (Some(XLINK_NS), "href") => {
                    if value.starts_with('#') {
                        Some(if ns.is_some() { "xlink:href" } else { "href" })
                    } else {
                        self.drop("external href".into());
                        None
                    }
                }
                (None, "style") => {
                    if css_is_safe(value) {
                        Some("style")
                    } else {
                        self.drop("unsafe style attribute".into());
                        None
                    }
                }
                (None, other) => {
                    if value_is_safe(value) {
                        Some(other)
                    } else {
                        self.drop(format!("attribute {other} with an external reference"));
                        None
                    }
                }
                (Some(_), other) => {
                    // `xml:space` and friends are harmless; every other namespace is dropped.
                    if attribute.namespace() == Some("http://www.w3.org/XML/1998/namespace") {
                        Some(if other == "space" { "xml:space" } else { "" })
                    } else {
                        self.drop(format!("attribute {other}"));
                        None
                    }
                }
            };
            if let Some(w) = written.filter(|w| !w.is_empty()) {
                self.out
                    .push_str(&format!(" {w}=\"{}\"", escape(value, true)));
            }
        }
        let children: Vec<Node> = node.children().collect();
        if children.is_empty() {
            self.out.push_str("/>");
            return;
        }
        self.out.push('>');
        for child in children {
            if child.is_element() {
                self.element(child, false);
            } else if child.is_text() {
                self.out
                    .push_str(&escape(child.text().unwrap_or(""), false));
            }
        }
        self.out.push_str(&format!("</{name}>"));
    }
}

/// Sanitizes an SVG source.
pub fn sanitize_svg(source: &str) -> Result<SanitizedSvg, ImageError> {
    let source = source.trim_start_matches('\u{feff}');
    // Entities are never expanded into the output; refuse documents that declare any.
    if source.contains("<!ENTITY") {
        return Err(ImageError::Svg(
            "entity declarations are not allowed".into(),
        ));
    }
    let doc = Document::parse(source).map_err(|e| ImageError::Svg(e.to_string()))?;
    let root = doc.root_element();
    if root.tag_name().name() != "svg" || root.tag_name().namespace() != Some(SVG_NS) {
        return Err(ImageError::Svg(
            "the root element is not an SVG `svg` element".into(),
        ));
    }
    let mut s = Sanitizer {
        out: String::new(),
        removed: BTreeMap::new(),
    };
    s.element(root, true);
    let removed = s
        .removed
        .into_iter()
        .map(|(what, n)| if n > 1 { format!("{what} x{n}") } else { what })
        .collect();
    Ok(SanitizedSvg {
        text: s.out,
        removed,
    })
}
