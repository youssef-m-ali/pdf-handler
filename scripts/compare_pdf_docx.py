#!/usr/bin/env python3
"""
compare_pdf_docx.py

Compares a PDF to a DOCX and outputs a JSON report covering:
  - text content coverage (matched / missing / extra)
  - position fidelity (Δx, Δy in points per matched item)
  - style fidelity (font size, color, bold, italic)
  - image presence

Usage:
  python3 scripts/compare_pdf_docx.py <file.pdf> <file.docx> [output.json]
"""

import sys
import json
import re
import math
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

# ── pdfminer for PDF extraction ────────────────────────────────────────────────
from pdfminer.high_level import extract_pages
from pdfminer.layout import LTPage, LTTextBox, LTTextLine, LTChar, LTFigure, LTImage, LTAnno
from pdfminer.pdfpage import PDFPage
from pdfminer.pdfinterp import PDFResourceManager, PDFPageInterpreter
from pdfminer.converter import PDFPageAggregator
from pdfminer.layout import LAParams


# ─── PDF extraction ────────────────────────────────────────────────────────────

def hex_color(r, g, b):
    """Convert 0-1 float RGB to #rrggbb."""
    return "#{:02x}{:02x}{:02x}".format(
        max(0, min(255, round(r * 255))),
        max(0, min(255, round(g * 255))),
        max(0, min(255, round(b * 255))),
    )


def extract_pdf(pdf_path: str):
    """
    Extract text items per page from a PDF.
    Each item: { str, x, y (top-down), fontSize, color, bold, italic }
    """
    pages = []

    with open(pdf_path, "rb") as f:
        laparams = LAParams(line_margin=0.5, word_margin=0.1)
        rsrcmgr  = PDFResourceManager()
        device   = PDFPageAggregator(rsrcmgr, laparams=laparams)
        interp   = PDFPageInterpreter(rsrcmgr, device)

        for page_num, pdf_page in enumerate(PDFPage.get_pages(f), start=1):
            interp.process_page(pdf_page)
            layout: LTPage = device.get_result()

            page_h  = layout.height
            page_w  = layout.width
            items   = []
            img_count = 0

            def walk(element, depth=0):
                nonlocal img_count
                if isinstance(element, (LTImage,)):
                    img_count += 1
                if isinstance(element, LTFigure):
                    img_count += 1  # figures often wrap images
                if isinstance(element, LTTextLine):
                    # Collect chars to group into runs by style
                    chars = [c for c in element if isinstance(c, LTChar)]
                    if not chars:
                        return
                    # Merge consecutive chars with same style into runs
                    runs = []
                    run_chars = [chars[0]]
                    for ch in chars[1:]:
                        prev = run_chars[-1]
                        same = (
                            abs(ch.size - prev.size) < 0.5 and
                            ch.fontname == prev.fontname and
                            getattr(ch, "graphicstate", None) is not None and
                            getattr(prev, "graphicstate", None) is not None and
                            getattr(ch.graphicstate, "ncolor", None) == getattr(prev.graphicstate, "ncolor", None)
                        )
                        if same:
                            run_chars.append(ch)
                        else:
                            runs.append(run_chars)
                            run_chars = [ch]
                    runs.append(run_chars)

                    for run in runs:
                        text = "".join(c.get_text() for c in run).strip()
                        if not text:
                            continue
                        first = run[0]
                        x0    = first.x0
                        y0    = first.y0  # bottom-up
                        size  = round(first.size * 10) / 10
                        fname = first.fontname or ""

                        # Color from graphicstate
                        color = "#000000"
                        gs    = getattr(first, "graphicstate", None)
                        if gs:
                            nc = getattr(gs, "ncolor", None)
                            if isinstance(nc, (list, tuple)):
                                if len(nc) == 3:
                                    color = hex_color(nc[0], nc[1], nc[2])
                                elif len(nc) == 1:
                                    color = hex_color(nc[0], nc[0], nc[0])
                                elif len(nc) == 4:  # CMYK
                                    c2,m,y2,k = nc
                                    color = hex_color(
                                        (1-c2)*(1-k), (1-m)*(1-k), (1-y2)*(1-k)
                                    )
                            elif isinstance(nc, float):
                                color = hex_color(nc, nc, nc)

                        bold   = "bold" in fname.lower()
                        italic = "italic" in fname.lower() or "oblique" in fname.lower()

                        items.append({
                            "str":      text,
                            "x":        round(x0, 1),
                            "y":        round(page_h - y0, 1),  # top-down
                            "fontSize": size,
                            "color":    color,
                            "bold":     bold,
                            "italic":   italic,
                            "fontName": fname,
                        })
                elif hasattr(element, "__iter__"):
                    for child in element:
                        walk(child, depth + 1)

            walk(layout)

            pages.append({
                "page":       page_num,
                "width":      round(page_w, 1),
                "height":     round(page_h, 1),
                "items":      items,
                "imageCount": img_count,
            })

    return pages


# ─── DOCX extraction ───────────────────────────────────────────────────────────

NS = {
    "w":  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "v":  "urn:schemas-microsoft-com:vml",
    "wps": "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
    "a":  "http://schemas.openxmlformats.org/drawingml/2006/main",
}

def parse_pt(val: str | None):
    """Parse a CSS-style value like '93.75pt' → 93.75."""
    if not val:
        return None
    m = re.search(r"([\d.]+)pt", val)
    return float(m.group(1)) if m else None


def extract_docx(docx_path: str):
    """
    Extract text items and image count from a DOCX.
    Handles: VML textboxes, framePr paragraphs, flowing text.
    """
    with zipfile.ZipFile(docx_path) as zf:
        xml_bytes = zf.read("word/document.xml")

    raw_xml = xml_bytes.decode("utf-8", errors="replace")

    # Count images
    image_count = len(re.findall(r"<a:blip ", raw_xml)) + \
                  len(re.findall(r"<v:imagedata ", raw_xml))

    root = ET.fromstring(raw_xml)
    body = root.find(".//w:body", NS)
    if body is None:
        return [{"page": 1, "items": [], "imageCount": image_count}]

    items = []

    def run_style(rpr):
        """Extract style info from a w:rPr element."""
        color   = "#000000"
        size    = None
        bold    = False
        italic  = False
        if rpr is not None:
            c = rpr.find("w:color", NS)
            if c is not None:
                val = c.get(f"{{{NS['w']}}}val", "000000")
                if val.lower() not in ("auto", "ffffff"):
                    color = f"#{val.lower()}"
            sz = rpr.find("w:sz", NS)
            if sz is not None:
                v = sz.get(f"{{{NS['w']}}}val")
                if v:
                    size = int(v) / 2
            bold   = rpr.find("w:b", NS) is not None
            italic = rpr.find("w:i", NS) is not None
        return color, size, bold, italic

    def gather_runs(element, x=None, y=None, source="flow"):
        """Walk runs in a paragraph/txbxContent and yield items."""
        for run in element.iter(f"{{{NS['w']}}}r"):
            t = run.find(f"{{{NS['w']}}}t")
            if t is None or not (t.text or "").strip():
                continue
            rpr                      = run.find(f"{{{NS['w']}}}rPr")
            color, size, bold, italic = run_style(rpr)
            items.append({
                "str":    t.text,
                "x":      x,
                "y":      y,
                "fontSize": size,
                "color":  color,
                "bold":   bold,
                "italic": italic,
                "source": source,
            })

    def parse_vml_style(style_str: str):
        """Parse a VML shape style string → dict."""
        d = {}
        for part in style_str.split(";"):
            part = part.strip()
            if ":" in part:
                k, _, v = part.partition(":")
                d[k.strip()] = v.strip()
        return d

    # Walk paragraphs
    for para in body.iter(f"{{{NS['w']}}}p"):
        ppr    = para.find(f"{{{NS['w']}}}pPr")
        frame  = ppr.find(f"{{{NS['w']}}}framePr") if ppr is not None else None

        # ── VML textboxes (our canvas approach) ────────────────────────────────
        for pict in para.iter(f"{{{NS['v']}}}shape"):
            style_str = pict.get("style", "")
            st        = parse_vml_style(style_str)
            x = parse_pt(st.get("left") or st.get("margin-left"))
            y = parse_pt(st.get("margin-top") or st.get("top"))
            for txbx in pict.iter(f"{{{NS['w']}}}txbxContent"):
                for inner_para in txbx.iter(f"{{{NS['w']}}}p"):
                    gather_runs(inner_para, x=x, y=y, source="vml")

        # ── framePr paragraphs ─────────────────────────────────────────────────
        if frame is not None:
            fx = frame.get(f"{{{NS['w']}}}x")
            fy = frame.get(f"{{{NS['w']}}}y")
            x  = int(fx) / 20 if fx else None
            y  = int(fy) / 20 if fy else None
            gather_runs(para, x=x, y=y, source="framePr")
            continue  # don't double-count as flow

        # ── Flowing / inline text ──────────────────────────────────────────────
        # Skip paragraphs that only contain VML (already handled above)
        if para.find(f"{{{NS['v']}}}shape") is None:
            gather_runs(para, x=None, y=None, source="flow")

    return [{"page": 1, "items": items, "imageCount": image_count}]


# ─── String similarity ────────────────────────────────────────────────────────

def normalise(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def similarity(a: str, b: str) -> float:
    """Longest-common-substring ratio (O(n²) — most accurate)."""
    na, nb = normalise(a), normalise(b)
    if na == nb:
        return 1.0
    if not na or not nb:
        return 0.0
    best = 0
    for i in range(len(na)):
        for j in range(len(nb)):
            l = 0
            while i + l < len(na) and j + l < len(nb) and na[i + l] == nb[j + l]:
                l += 1
            if l > best:
                best = l
    return (2 * best) / (len(na) + len(nb))


# ─── Comparison ───────────────────────────────────────────────────────────────

MATCH_THRESHOLD = 0.75


def compare(pdf_pages, docx_pages):
    docx_items = [item for p in docx_pages for item in p["items"]]
    used_docx  = set()

    page_reports = []
    total_pdf = total_matched = total_missing = 0
    total_dx = total_dy = pos_count = 0
    color_matches = color_total = 0
    size_matches  = size_total  = 0
    bold_matches  = italic_matches = style_total = 0
    total_pdf_images  = sum(p["imageCount"] for p in pdf_pages)
    total_docx_images = sum(p["imageCount"] for p in docx_pages)

    for pdf_page in pdf_pages:
        matched_items = []
        missing_items = []
        match_details = []

        for pdf_item in pdf_page["items"]:
            best_idx, best_score = -1, 0.0
            for di, docx_item in enumerate(docx_items):
                if di in used_docx:
                    continue
                score = similarity(pdf_item["str"], docx_item["str"])
                if score > best_score:
                    best_score, best_idx = score, di

            if best_idx >= 0 and best_score >= MATCH_THRESHOLD:
                used_docx.add(best_idx)
                d = docx_items[best_idx]
                matched_items.append(pdf_item["str"])

                detail = {
                    "pdf_str":    pdf_item["str"],
                    "docx_str":   d["str"],
                    "match_score": round(best_score, 2),
                    "source":     d["source"],
                }

                # Position
                if pdf_item["x"] is not None and d["x"] is not None and d["source"] != "flow":
                    dx = round(d["x"] - pdf_item["x"], 1)
                    dy = round(d["y"] - pdf_item["y"], 1)
                    detail["pos_pdf"]    = {"x": pdf_item["x"], "y": pdf_item["y"]}
                    detail["pos_docx"]   = {"x": d["x"], "y": d["y"]}
                    detail["delta_x_pt"] = dx
                    detail["delta_y_pt"] = dy
                    total_dx   += abs(dx)
                    total_dy   += abs(dy)
                    pos_count  += 1

                # Color
                color_total += 1
                pdf_hex  = pdf_item["color"].lstrip("#").lower()
                docx_hex = d["color"].lstrip("#").lower()
                color_ok = pdf_hex == docx_hex or (
                    pdf_hex == "000000" and docx_hex in ("000000", "auto", "")
                )
                detail["color_pdf"]   = pdf_item["color"]
                detail["color_docx"]  = d["color"]
                detail["color_match"] = color_ok
                if color_ok:
                    color_matches += 1

                # Font size
                if pdf_item["fontSize"] is not None and d["fontSize"] is not None:
                    size_total += 1
                    delta = abs(pdf_item["fontSize"] - d["fontSize"])
                    detail["size_pdf"]   = pdf_item["fontSize"]
                    detail["size_docx"]  = d["fontSize"]
                    detail["size_delta"] = round(delta, 1)
                    detail["size_match"] = delta <= 1
                    if delta <= 1:
                        size_matches += 1

                # Bold / italic
                style_total += 1
                detail["bold_match"]   = pdf_item["bold"] == d["bold"]
                detail["italic_match"] = pdf_item["italic"] == d["italic"]
                if detail["bold_match"]:   bold_matches   += 1
                if detail["italic_match"]: italic_matches += 1

                match_details.append(detail)
            else:
                missing_items.append(pdf_item["str"])

        total_pdf     += len(pdf_page["items"])
        total_matched += len(matched_items)
        total_missing += len(missing_items)

        page_reports.append({
            "page":           pdf_page["page"],
            "pdf_item_count": len(pdf_page["items"]),
            "matched":        len(matched_items),
            "missing_count":  len(missing_items),
            "missing_text":   missing_items,
            "matches":        match_details,
        })

    extra_docx = [
        d["str"] for i, d in enumerate(docx_items)
        if i not in used_docx and len(d["str"].strip()) > 1
    ]

    def pct(num, den): return round(num / den * 100, 1) if den else None

    summary = {
        "pdf_text_items":          total_pdf,
        "docx_text_items":         len(docx_items),
        "matched_items":           total_matched,
        "missing_from_docx":       total_missing,
        "extra_in_docx":           len(extra_docx),
        "text_coverage_pct":       pct(total_matched, total_pdf),
        "avg_position_error_x_pt": round(total_dx / pos_count, 1) if pos_count else None,
        "avg_position_error_y_pt": round(total_dy / pos_count, 1) if pos_count else None,
        "color_accuracy_pct":      pct(color_matches, color_total),
        "size_accuracy_pct":       pct(size_matches,  size_total),
        "bold_accuracy_pct":       pct(bold_matches,  style_total),
        "italic_accuracy_pct":     pct(italic_matches, style_total),
        "pdf_image_count":         total_pdf_images,
        "docx_image_count":        total_docx_images,
        "image_coverage_pct":      pct(min(total_docx_images, total_pdf_images), total_pdf_images),
        "extra_docx_text":         extra_docx[:20],
    }

    return {"summary": summary, "pages": page_reports}


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    if len(args) < 2:
        print("Usage: compare_pdf_docx.py <file.pdf> <file.docx> [output.json]", file=sys.stderr)
        sys.exit(1)

    pdf_path  = args[0]
    docx_path = args[1]
    out_path  = args[2] if len(args) > 2 else None

    print(f"Extracting PDF:  {Path(pdf_path).name}", file=sys.stderr)
    pdf_pages = extract_pdf(pdf_path)

    print(f"Extracting DOCX: {Path(docx_path).name}", file=sys.stderr)
    docx_pages = extract_docx(docx_path)

    print("Comparing...", file=sys.stderr)
    result = {
        "pdf":  Path(pdf_path).name,
        "docx": Path(docx_path).name,
        **compare(pdf_pages, docx_pages),
    }

    output = json.dumps(result, indent=2, ensure_ascii=False)

    if out_path:
        Path(out_path).write_text(output, encoding="utf-8")
        print(f"Saved to {out_path}", file=sys.stderr)
    else:
        print(output)

    s = result["summary"]
    print("\n─── Summary ────────────────────────────────────────────────", file=sys.stderr)
    print(f"Text coverage:     {s['text_coverage_pct']}%  ({s['matched_items']}/{s['pdf_text_items']} matched)", file=sys.stderr)
    print(f"Missing from DOCX: {s['missing_from_docx']} items", file=sys.stderr)
    print(f"Extra in DOCX:     {s['extra_in_docx']} items", file=sys.stderr)
    print(f"Avg position Δ:    x={s['avg_position_error_x_pt']}pt  y={s['avg_position_error_y_pt']}pt", file=sys.stderr)
    print(f"Color accuracy:    {s['color_accuracy_pct']}%", file=sys.stderr)
    print(f"Size accuracy:     {s['size_accuracy_pct']}%", file=sys.stderr)
    print(f"Bold accuracy:     {s['bold_accuracy_pct']}%", file=sys.stderr)
    print(f"Images:            PDF={s['pdf_image_count']}  DOCX={s['docx_image_count']}  ({s['image_coverage_pct']}%)", file=sys.stderr)
    print("────────────────────────────────────────────────────────────", file=sys.stderr)


if __name__ == "__main__":
    main()
