"""
Show the distribution of right-edge (xMax) values for left and right column
body lines in a two-column PDF page. Helps diagnose why column widths detected
from advance widths may not match visual line-break behaviour in Word.

Usage:
    python3 scripts/debug_column_widths.py <pdf> [page_number]

    page_number defaults to 2 (first two-column page of dynamo.pdf).

Example:
    python3 scripts/debug_column_widths.py files/dynamo.pdf 2
"""

import sys
import pdfplumber
from collections import Counter

def main():
    pdf_path   = sys.argv[1]
    page_num   = int(sys.argv[2]) if len(sys.argv) > 2 else 2

    with pdfplumber.open(pdf_path) as pdf:
        page = pdf.pages[page_num - 1]
        W    = page.width
        words = page.extract_words(x_tolerance=2, y_tolerance=3)

    # Split into left / right halves
    left_words  = [w for w in words if w['x0'] < W * 0.5]
    right_words = [w for w in words if w['x0'] >= W * 0.5]

    print(f"\nPage {page_num}  width={W:.1f}pt")

    for label, col_words in [("LEFT", left_words), ("RIGHT", right_words)]:
        if not col_words:
            print(f"\n{label} column: no words")
            continue

        # Group words into lines (same y within 2pt)
        from itertools import groupby
        col_words_sorted = sorted(col_words, key=lambda w: round(w['top']))
        lines = []
        for y, grp in groupby(col_words_sorted, key=lambda w: round(w['top'])):
            line_words = list(grp)
            x1_max = max(w['x1'] for w in line_words)
            x0_min = min(w['x0'] for w in line_words)
            lines.append({'y': y, 'x0': x0_min, 'x1': x1_max, 'n': len(line_words)})

        xmaxes = sorted(w['x1'] for w in lines)
        n = len(xmaxes)
        print(f"\n{label} column  ({n} lines)")
        print(f"  xMin of lines: min={min(w['x0'] for w in lines):.1f}  max={max(w['x0'] for w in lines):.1f}")
        print(f"  xMax of lines: min={min(xmaxes):.1f}  median={xmaxes[n//2]:.1f}  p75={xmaxes[int(n*0.75)]:.1f}  p90={xmaxes[int(n*0.90)]:.1f}  max={xmaxes[-1]:.1f}")

        # Cluster xMax values into buckets of width 3pt and show top buckets
        buckets: dict[int, int] = {}
        for v in xmaxes:
            k = round(v)
            buckets[k] = buckets.get(k, 0) + 1

        # Merge nearby buckets (within 3pt)
        merged: list[tuple[float, int]] = []
        for val in sorted(buckets):
            if merged and abs(val - merged[-1][0]) <= 3:
                merged[-1] = (merged[-1][0], merged[-1][1] + buckets[val])
            else:
                merged.append((val, buckets[val]))

        top = sorted(merged, key=lambda x: -x[1])[:8]
        print(f"  Top xMax clusters (value, count):")
        for v, c in top:
            pct = c / n * 100
            print(f"    x={v:.0f}pt  count={c}  ({pct:.0f}%)")

if __name__ == "__main__":
    main()
