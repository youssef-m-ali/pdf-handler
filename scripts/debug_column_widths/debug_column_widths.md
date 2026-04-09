# debug_column_widths.py

Shows the distribution of right-edge (xMax) values for left and right column lines on a two-column PDF page.

## What it does

Groups extracted words into visual lines, then prints statistics (min, median, p75, p90, max) and the top clusters of line right-edges for each column. This reveals whether the advance-width `xMax` we use for column-width detection overshoots the visual glyph boundary.

## Usage

```bash
python3 scripts/debug_column_widths.py <pdf> [page_number]
```

`page_number` defaults to 2.

## Example

```bash
python3 scripts/debug_column_widths.py files/dynamo.pdf 2
```
