# pdf_compare.py — Agent Usage Guide

This guide is for AI agents invoking or interpreting `pdf_compare.py` as part of PDF compression evaluation workflows.

---

## What the script does

Deep-analyzes one or more PDF files and compares them side-by-side. It extracts per-file, per-page, per-image, and per-font data using `pikepdf`, then renders rich tables to stdout. Primary use case: evaluating what a compression tool did to images (resampling, quality reduction, color space changes, filter changes) and catching integrity bugs like SMask mismatches.

---

## Invocation

```bash
# Single file — full analysis
python3 pdf_compare.py original.pdf

# Comparison — original vs one or more compressed versions
python3 pdf_compare.py original.pdf compressed.pdf
python3 pdf_compare.py original.pdf smallpdf.pdf adobe.pdf ilovepdf.pdf

# Write full structured data to JSON (can combine with any mode)
python3 pdf_compare.py original.pdf compressed.pdf --json out.json
```

**The first positional argument is always treated as the reference/original.** All subsequent files are compared against it.

---

## Output modes

### Single-file mode
Prints four sections:
1. **File Summary** — size, version, producer, object count, XMP, linearization
2. **Per-Page Analysis** — dimensions, image/font/annotation counts, content stream sizes
3. **Per-Image Analysis** — object ID, dimensions, color space, BPC, filter chain, JPEG quality, DPI, compressed/uncompressed sizes, SMask dimensions
4. **⚠ Integrity Warnings** panel — only shown when issues are detected (see below)

### Comparison mode
Prints:
1. **File-Level Summary** — side-by-side with size deltas colored green/red
2. **Per-Page Comparison** — one table per page
3. **Per-Image Comparison** — verbose per-image table for every image across all files
4. **Per-Image Delta Table** — compact table showing only changed images (dims, filter, quality, byte delta, SMask status)
5. **Font Comparison** — embedding status per font
6. **Key Findings** panel per compressed file — narrative summary of what changed, plus any integrity warnings

---

## JSON output schema

Each element of the top-level array corresponds to one input PDF (first = original):

```json
[
  {
    "label": "original.pdf",
    "file": { "path", "size_bytes", "pdf_version", "producer", "creator", ... },
    "pages": [ { "page_num", "width_pts", "height_pts", "num_images", ... } ],
    "images": [
      {
        "object_id": "42:0",
        "pages": [1],
        "page_order": [[1, 0]],
        "width_px": 1840, "height_px": 778,
        "color_space": "DeviceRGB", "num_components": 3,
        "bits_per_component": 8,
        "primary_filter": "DCTDecode",
        "all_filters": ["DCTDecode"],
        "compressed_bytes": 95000, "uncompressed_bytes": 430000,
        "compression_ratio": 0.221,
        "dpi_x": 150.0, "dpi_y": 150.0,
        "jpeg_quality": 88,
        "has_soft_mask": true,
        "smask_width": 1840, "smask_height": 778,
        "smask_dimension_mismatch": false,
        "image_mask": false, "interpolate": false, "inline_count": 0
      }
    ],
    "fonts": [ { "object_id", "name", "font_type", "subtype", "embedded", "subsetted", "stream_bytes", "pages" } ],
    "warnings": [],
    "totals": {
      "image_bytes_compressed": 95000,
      "image_bytes_uncompressed": 430000,
      "font_bytes": 120000,
      "content_bytes_compressed": 8000,
      "content_bytes_uncompressed": 22000
    }
  }
]
```

---

## Key fields for compression evaluation

| Field | Where | What to check |
|---|---|---|
| `smask_dimension_mismatch` | `images[]` | `true` = Acrobat will throw "Insufficient data for an image" |
| `smask_width` / `smask_height` | `images[]` | Must equal `width_px` / `height_px` if SMask present |
| `warnings` | top-level per file | Non-empty = integrity issue detected |
| `jpeg_quality` | `images[]` | Compare orig vs compressed to detect quality reduction |
| `primary_filter` / `all_filters` | `images[]` | Array filters (e.g. iLovePDF) show as `["FlateDecode","DCTDecode"]` |
| `width_px` / `height_px` | `images[]` | Downsampled if smaller than original |
| `compression_ratio` | `images[]` | `> 1.0` = impossible (integrity warning fired) |
| `compressed_bytes == 0` | `images[]` | Zero-byte stream = image was stripped |

---

## Image matching across files

Images are matched between original and compressed files by `(page_number, order_on_page)` — the `page_order` field. Use this key when diffing images programmatically:

```python
import json

data = json.load(open("out.json"))
orig_images = {tuple(po): img for img in data[0]["images"] for po in img["page_order"]}
comp_images = {tuple(po): img for img in data[1]["images"] for po in img["page_order"]}

for key in orig_images:
    if key in comp_images:
        orig = orig_images[key]
        comp = comp_images[key]
        if comp["smask_dimension_mismatch"]:
            print(f"SMask mismatch on page {key[0]} image {key[1]+1}")
        if comp["jpeg_quality"] and orig["jpeg_quality"]:
            print(f"Quality: Q{orig['jpeg_quality']} → Q{comp['jpeg_quality']}")
```

---

## Integrity warnings

The script emits warnings (shown in the panel and in `warnings[]`) for:

- **Impossible compression ratio** — `compressed_bytes > uncompressed_bytes` for images ≥ 1 KB
- **Zero-byte image stream** — stream is empty for a non-mask image with valid dimensions
- **Unusual BitsPerComponent** — value is not 1, 8, or 16
- **SMask dimension mismatch** — SMask pixel dimensions differ from parent image (causes Acrobat rendering failure)

---

## Dependencies

```
pikepdf   pillow   rich
```

All must be installed. The script exits with a clear error if any are missing.

---

## What the script does NOT do

- Does not render or rasterize pages
- Does not validate PDF/A or PDF/X compliance
- Does not read inline images (counts them but does not analyze)
- Does not follow cross-document references
