# pdf_compare.py

Deep PDF analysis and comparison tool. Extracts granular per-page, per-image, and per-font data. In multi-file mode, shows side-by-side deltas to reveal how different compression tools differ in their approach.

## What it measures

- Page count, dimensions, and rotation
- Per-image: format, dimensions, DPI, compression type, file size
- Per-font: name, encoding, embedded vs referenced
- File size deltas across multiple input files

## Usage

```bash
# Analyse a single PDF
python3 scripts/pdf_compare.py document.pdf

# Compare multiple PDFs side by side (e.g. original vs compressed variants)
python3 scripts/pdf_compare.py original.pdf smallpdf.pdf adobe.pdf ilovepdf.pdf

# Compare and export JSON report
python3 scripts/pdf_compare.py original.pdf compressed.pdf --json out.json
```

## Requirements

```bash
pip install pikepdf pillow rich
```
