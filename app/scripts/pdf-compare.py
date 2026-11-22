"""Screen-versus-PDF regression check.

Compares the print-view screenshots of the pages (one PNG per page, `page-<n>.png`, taken by
`e2e-print.mjs` at --ppp pixels per point) with the exported PDF, rasterised with PyMuPDF at the same
scale, and checks the PDF itself (page count, exact page size, embedded bundled fonts, vector text).

PyMuPDF runs on Windows and Linux (`pip install pymupdf numpy pillow`), so this one script is the
rasteriser on both platforms. Run it isolated:

    python -I app/scripts/pdf-compare.py --pdf out.pdf --shots dir --expect-pages 2 \
        --page-size 595.28 841.89 --out dir

Prints one `PASS`/`FAIL` line per check and a JSON report (`report.json` in --out); the exit code is
the number of failed checks.
"""
import argparse
import json
import os
import sys

import fitz  # PyMuPDF
import numpy as np
from PIL import Image

# PDF font names (after the "ABCDEF+" subset prefix) of the bundled fonts (app/src/styles/fonts.ts).
BUNDLED_FONTS = ("NotoSans", "STIXTwo", "MCMath")


def gray(a):
    return a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114


def shifted_minmax(g, r=1):
    """Min and max over the (2r+1)^2 neighbourhood, by padding and shifting."""
    h, w = g.shape
    p = np.pad(g, r, mode="edge")
    mins = np.full_like(g, 1e9)
    maxs = np.full_like(g, -1e9)
    for dy in range(2 * r + 1):
        for dx in range(2 * r + 1):
            s = p[dy:dy + h, dx:dx + w]
            mins = np.minimum(mins, s)
            maxs = np.maximum(maxs, s)
    return mins, maxs


def diff_masks(a, b, tol):
    """(strict, tolerant) masks of differing pixels.

    strict: the largest channel difference exceeds `tol`.
    tolerant: strict AND the pixel is not explained by a one-pixel shift, i.e. its luma lies outside
    the other image's 3x3 neighbourhood range by more than `tol`. Anti-aliasing differences between
    two rasterisers vanish, real geometry and glyph differences stay (spike E).
    """
    strict = np.abs(a.astype(int) - b.astype(int)).max(axis=2) > tol
    ga, gb = gray(a.astype(float)), gray(b.astype(float))
    bmin, bmax = shifted_minmax(gb)
    amin, amax = shifted_minmax(ga)
    dev_a = np.maximum(np.maximum(bmin - ga, ga - bmax), 0)
    dev_b = np.maximum(np.maximum(amin - gb, gb - amax), 0)
    tolerant = (np.maximum(dev_a, dev_b) > tol) & strict
    return strict, tolerant


def rasterise(page, ppp):
    pix = page.get_pixmap(matrix=fitz.Matrix(ppp, ppp), alpha=False)
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)[..., :3]


def font_facts(doc):
    fonts = {}
    for page in doc:
        for (xref, _ext, typ, base, *_rest) in page.get_fonts(full=True):
            try:
                data = doc.extract_font(xref)[3] or b""
            except Exception:
                data = b""
            fonts[xref] = {"base": base, "type": typ, "embedded_bytes": len(data)}
    return sorted(fonts.values(), key=lambda f: f["base"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--shots", required=True, help="directory with page-<n>.png (1-based)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--ppp", type=float, default=2.0, help="pixels per point of the screenshots")
    ap.add_argument("--expect-pages", type=int, required=True)
    ap.add_argument("--page-size", type=float, nargs=2, required=True, metavar=("W_PT", "H_PT"))
    ap.add_argument("--tol", type=int, default=32)
    ap.add_argument("--tol-strong", type=int, default=96)
    ap.add_argument("--max-tolerant", type=float, default=0.3, help="percent of the page at --tol")
    ap.add_argument("--max-strong", type=float, default=0.05, help="percent of the page at --tol-strong")
    ap.add_argument("--expect-images", nargs="*", default=[], metavar="WxH",
                    help="pixel sizes of raster images that the PDF must embed at full resolution (a PNG region)")
    ap.add_argument("--expect-fill", nargs="*", default=[], metavar="RRGGBB",
                    help="fill colours that must exist as vector drawings (an SVG region stays vector)")
    ap.add_argument("--expect-text", nargs="*", default=[], help="words that must be in the PDF text (a result calculated from a hidden region)")
    ap.add_argument("--forbid-text", nargs="*", default=[], help="words that must not be in the PDF text (the members of a collapsed area)")
    ap.add_argument("--max-size-delta", type=float, default=0.01, help="points")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    failures = 0
    report = {"pdf": a.pdf, "pages": []}

    def check(name, ok, detail=""):
        nonlocal failures
        if not ok:
            failures += 1
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  {detail}" if detail else ""))

    doc = fitz.open(a.pdf)
    report["page_count"] = doc.page_count
    check("PDF page count equals the page count of the view", doc.page_count == a.expect_pages,
          f"{doc.page_count} / {a.expect_pages}")

    fonts = font_facts(doc)
    report["fonts"] = fonts
    check("every font is embedded", all(f["embedded_bytes"] > 0 for f in fonts) and len(fonts) > 0,
          ", ".join(f"{f['base']}({f['embedded_bytes']})" for f in fonts))
    foreign = [f["base"] for f in fonts if not any(name in f["base"].replace(" ", "") for name in BUNDLED_FONTS)]
    check("only bundled fonts are used", not foreign, ", ".join(foreign))

    all_images = []
    all_words = []
    all_fills = set()
    for index, page in enumerate(doc):
        n = index + 1
        entry = {"page": n}
        report["pages"].append(entry)
        media, crop = page.mediabox, page.cropbox
        entry["size_pt"] = [media.width, media.height]
        dw, dh = abs(media.width - a.page_size[0]), abs(media.height - a.page_size[1])
        check(f"page {n}: size is the page setup's size", dw <= a.max_size_delta and dh <= a.max_size_delta,
              f"{media.width:.3f} x {media.height:.3f} pt (delta {dw:.3f}, {dh:.3f})")
        check(f"page {n}: CropBox equals MediaBox", abs(crop.width - media.width) < 1e-3 and abs(crop.height - media.height) < 1e-3)
        words = page.get_text("words")
        all_words.extend(w[4] for w in words)
        entry["words"] = len(words)
        page_images = [f"{img[2]}x{img[3]}" for img in page.get_images(full=True)]
        entry["images"] = len(page_images)
        entry["image_sizes"] = page_images
        all_images.extend(page_images)
        drawings = page.get_drawings()
        entry["drawings"] = len(drawings)
        for d in drawings:
            if d.get("fill"):
                all_fills.add("%02x%02x%02x" % tuple(round(c * 255) for c in d["fill"][:3]))
        # Text stays vector: the only bitmaps are the raster images the worksheet has.
        stray = [size for size in page_images if size not in a.expect_images]
        check(f"page {n}: text is vector (extractable words, no bitmap but the expected images)", len(words) > 0 and not stray,
              f"{len(words)} words, {entry['images']} images {page_images}, {entry['drawings']} drawings")

        shot_path = os.path.join(a.shots, f"page-{n}.png")
        if not os.path.exists(shot_path):
            check(f"page {n}: screenshot exists", False, shot_path)
            continue
        screen = np.asarray(Image.open(shot_path).convert("RGB"))
        raster = rasterise(page, a.ppp)
        entry["screen_px"] = [screen.shape[1], screen.shape[0]]
        entry["pdf_px"] = [raster.shape[1], raster.shape[0]]
        size_ok = abs(screen.shape[0] - raster.shape[0]) <= 2 and abs(screen.shape[1] - raster.shape[1]) <= 2
        check(f"page {n}: screenshot and raster have the same size", size_ok,
              f"screen {screen.shape[1]}x{screen.shape[0]}, pdf {raster.shape[1]}x{raster.shape[0]}")
        h, w = min(screen.shape[0], raster.shape[0]), min(screen.shape[1], raster.shape[1])
        s, r = screen[:h, :w], raster[:h, :w]
        total = float(h * w)
        _, tol_mask = diff_masks(s, r, a.tol)
        _, strong_mask = diff_masks(s, r, a.tol_strong)
        ink = float(((gray(s.astype(float)) < 200) | (gray(r.astype(float)) < 200)).sum()) or 1.0
        entry["tolerant_pct_page"] = 100.0 * tol_mask.sum() / total
        entry["tolerant_pct_ink"] = 100.0 * tol_mask.sum() / ink
        entry["strong_pct_page"] = 100.0 * strong_mask.sum() / total
        check(f"page {n}: tolerant diff at {a.tol}/255 <= {a.max_tolerant} % of the page",
              entry["tolerant_pct_page"] <= a.max_tolerant,
              f"{entry['tolerant_pct_page']:.3f} % of the page, {entry['tolerant_pct_ink']:.2f} % of the ink")
        check(f"page {n}: tolerant diff at {a.tol_strong}/255 <= {a.max_strong} % of the page",
              entry["strong_pct_page"] <= a.max_strong, f"{entry['strong_pct_page']:.3f} %")
        # Diff image: grey = identical, orange = anti-aliasing level, red = real difference.
        img = np.stack([s[..., 0] // 2 + 127] * 3, axis=-1).astype(np.uint8)
        strict, _ = diff_masks(s, r, a.tol)
        img[strict] = (255, 170, 60)
        img[tol_mask] = (230, 20, 20)
        Image.fromarray(img).save(os.path.join(a.out, f"diff-{n}.png"))
        Image.fromarray(np.ascontiguousarray(r)).save(os.path.join(a.out, f"pdf-{n}.png"))

    for word in a.expect_text:
        check(f"the PDF text has {word!r}", any(word in w for w in all_words))
    for word in a.forbid_text:
        check(f"the PDF text has no {word!r}", not any(word in w for w in all_words))
    for size in a.expect_images:
        check(f"a raster image keeps its full pixel size ({size}) in the PDF", size in all_images, f"embedded: {all_images}")
    for fill in a.expect_fill:
        check(f"an SVG stays vector (fill #{fill} is a drawing, not an image)", fill.lower() in all_fills,
              f"{len(all_fills)} distinct fills")

    with open(os.path.join(a.out, "report.json"), "w", encoding="utf8") as f:
        json.dump(report, f, indent=2)
    print(f"{'ALL PASSED' if failures == 0 else str(failures) + ' FAILED'}")
    sys.exit(failures)


if __name__ == "__main__":
    main()
