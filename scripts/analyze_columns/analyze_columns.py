"""
Analyze column geometry: compare PDF-detected columns vs DOCX output.

Usage:
    python3 scripts/analyze_columns.py <pdf> <docx> [<docx2> ...]

Example:
    python3 scripts/analyze_columns.py files/dynamo.pdf files/dynamo.docx files/dynamo_ilp.docx
"""

import sys, zipfile, re
import pdfplumber

PT_TWIP = 20

def pdf_columns(pdf_path):
    """Extract column geometry from the first two-column page of a PDF."""
    with pdfplumber.open(pdf_path) as pdf:
        for page_num, page in enumerate(pdf.pages):
            W = page.width
            words = page.extract_words(x_tolerance=2, y_tolerance=3, keep_blank_chars=False)
            if not words:
                continue

            # Split into rough left/right halves
            left  = [w for w in words if w['x0'] < W * 0.5]
            right = [w for w in words if w['x0'] >= W * 0.5]

            if len(left) < 10 or len(right) < 10:
                continue  # not a two-column page

            left_x0   = min(w['x0']  for w in left)
            left_xmax = max(w['x1']  for w in left)
            right_x0  = min(w['x0']  for w in right)
            right_xmax= max(w['x1']  for w in right)

            gap = right_x0 - left_xmax
            if gap < 2:
                continue  # not really two columns

            left_col_width  = left_xmax  - left_x0
            right_col_width = right_xmax - right_x0

            print(f"\nPDF page {page_num+1}  (W={W:.1f}pt)")
            print(f"  Left  col:  x0={left_x0:.1f}  xmax={left_xmax:.1f}  width={left_col_width:.1f}pt  ({left_col_width*PT_TWIP:.0f} twips)")
            print(f"  Right col:  x0={right_x0:.1f}  xmax={right_xmax:.1f}  width={right_col_width:.1f}pt  ({right_col_width*PT_TWIP:.0f} twips)")
            print(f"  Gap:        {gap:.1f}pt  ({gap*PT_TWIP:.0f} twips)")
            print(f"  Left margin:  {left_x0:.1f}pt  ({left_x0*PT_TWIP:.0f} twips)")
            print(f"  Right margin: {W - right_xmax:.1f}pt  ({(W - right_xmax)*PT_TWIP:.0f} twips)")
            return  # just first two-column page


def docx_columns(docx_path):
    """Extract column geometry from all sections in a DOCX."""
    with zipfile.ZipFile(docx_path) as z:
        xml = z.read('word/document.xml').decode()

    # Find all sectPr blocks
    sect_blocks = re.findall(r'<w:sectPr\b.*?</w:sectPr>', xml, re.DOTALL)
    if not sect_blocks:
        # Also look for inline sectPr (inside paragraphs)
        sect_blocks = re.findall(r'<w:sectPr[^>]*>.*?</w:sectPr>', xml, re.DOTALL)

    print(f"\nDOCX: {docx_path}  ({len(sect_blocks)} sections)")
    for i, sect in enumerate(sect_blocks):
        sec_type = re.search(r'<w:type w:val="([^"]+)"', sect)
        pgSz     = re.search(r'<w:pgSz[^/]*/>', sect)
        pgMar    = re.search(r'<w:pgMar[^/]*/>', sect)
        cols_tag = re.search(r'<w:cols\b[^>]*(?:/>|>.*?</w:cols>)', sect, re.DOTALL)

        sec_type_val = sec_type.group(1) if sec_type else "nextPage"
        print(f"\n  Section {i+1}  type={sec_type_val}")

        if pgSz:
            w = int(re.search(r'w:w="(\d+)"', pgSz.group()).group(1))
            h = int(re.search(r'w:h="(\d+)"', pgSz.group()).group(1))
            print(f"    page size:  {w}x{h} twips  ({w/PT_TWIP:.1f}x{h/PT_TWIP:.1f}pt)")

        if pgMar:
            m = pgMar.group()
            left  = int(re.search(r'w:left="(\d+)"',  m).group(1)) if re.search(r'w:left="(\d+)"',  m) else 0
            right = int(re.search(r'w:right="(\d+)"', m).group(1)) if re.search(r'w:right="(\d+)"', m) else 0
            print(f"    margins:    left={left} right={right} twips  ({left/PT_TWIP:.1f}/{right/PT_TWIP:.1f}pt)")
            text_area = w - left - right if pgSz else None
            if text_area:
                print(f"    text area:  {text_area} twips  ({text_area/PT_TWIP:.1f}pt)")

        if cols_tag:
            ct = cols_tag.group()
            num   = re.search(r'w:num="(\d+)"', ct)
            space = re.search(r'w:space="(\d+)"', ct)
            eq    = re.search(r'w:equalWidth="([^"]+)"', ct)
            col_w = re.findall(r'<w:col w:w="(\d+)"', ct)
            print(f"    cols num:   {num.group(1) if num else '?'}")
            if space:
                sp = int(space.group(1))
                print(f"    col space:  {sp} twips  ({sp/PT_TWIP:.2f}pt)")
            if eq:
                print(f"    equalWidth: {eq.group(1)}")
            if col_w:
                for j, cw in enumerate(col_w):
                    print(f"    col {j+1} width: {cw} twips  ({int(cw)/PT_TWIP:.1f}pt)")
            if num and int(num.group(1)) == 2 and pgSz and pgMar:
                # Compute effective column width when equalWidth=true and no explicit col widths
                if not col_w:
                    sp_val = int(space.group(1)) if space else 0
                    left_m  = int(re.search(r'w:left="(\d+)"',  pgMar.group()).group(1))
                    right_m = int(re.search(r'w:right="(\d+)"', pgMar.group()).group(1))
                    total_text = w - left_m - right_m
                    col_width_each = (total_text - sp_val) // 2
                    print(f"    (computed) col width: {col_width_each} twips  ({col_width_each/PT_TWIP:.1f}pt) each")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    pdf_path  = sys.argv[1]
    docx_paths = sys.argv[2:]

    pdf_columns(pdf_path)
    for dp in docx_paths:
        docx_columns(dp)
