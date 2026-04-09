# run_conversion.ts

CLI runner for the PDF-to-Word conversion library. Converts a single PDF to a DOCX file in the same directory.

## Usage

```bash
node --experimental-strip-types scripts/run_conversion.ts <path-to-pdf>
```

## Output

Writes `<basename>.docx` alongside the input PDF. Prints input path, output path, and output file size.

## Example

```bash
node --experimental-strip-types scripts/run_conversion.ts files/dynamo.pdf
# Output: files/dynamo.docx
```
