# compare_pdf_docx.py

Compares a source PDF against a converted DOCX and produces a JSON quality report.

## What it measures

- **Text coverage**: how many PDF text items are matched in the DOCX (matched / missing / extra)
- **Position fidelity**: average Δx and Δy (in points) between matched items
- **Style fidelity**: font size accuracy, color accuracy, bold accuracy, italic accuracy
- **Image presence**: number of images in PDF vs DOCX

## Usage

```bash
python3 scripts/compare_pdf_docx.py <file.pdf> <file.docx> [output.json]
```

If `output.json` is omitted the report is printed to stdout only.

## Example

```bash
python3 scripts/compare_pdf_docx.py files/dynamo.pdf files/dynamo.docx files/results.json
```

## Requirements

```bash
pip install pdfminer.six
```
