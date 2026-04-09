# run_compressions.ts

CLI runner for the PDF compression library. Runs one or all compression levels against an input PDF and writes the output files to `files/`.

## Usage

```bash
node --experimental-strip-types scripts/run_compressions.ts <path-to-pdf> [--level=light|balanced|extreme]
```

Omitting `--level` runs all three levels.

## Output files

| Level    | Output filename                  |
|----------|----------------------------------|
| light    | `<basename>_jolt_light.pdf`    |
| balanced | `<basename>_jolt_balanced.pdf` |
| extreme  | `<basename>_jolt_extreme.pdf`  |

Files are written to the `files/` directory at the repo root.

## Example

```bash
# Run all levels
node --experimental-strip-types scripts/run_compressions.ts files/dynamo.pdf

# Run only balanced
node --experimental-strip-types scripts/run_compressions.ts files/dynamo.pdf --level=balanced
```
