# analyze_columns.py

Compares column geometry between a source PDF and one or more DOCX files.

## What it does

- Detects the first two-column page in the PDF and prints:
  - Left/right column x-positions, widths, and gap (in both points and twips)
  - Page margins (left/right)
- For each DOCX, prints every section's:
  - Page size and margins
  - Text area width
  - Column count, spacing, and per-column widths

Use this to verify that a DOCX's column widths and gap match the source PDF.

## Usage

```bash
python3 scripts/analyze_columns.py <pdf> <docx> [<docx2> ...]
```

## Example

```bash
python3 scripts/analyze_columns.py files/dynamo.pdf files/dynamo.docx files/dynamo_ilp.docx
```
