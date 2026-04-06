import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { pathToFileURL } from "url";
import sharp from "sharp";

export const maxDuration = 60;

// ─── Types ────────────────────────────────────────────────────────────────────

type M6 = [number, number, number, number, number, number];

interface RichItem {
  str: string;
  x: number; y: number;   // PDF user space: x from left, y from TOP (top-down)
  width: number;           // actual rendered width in PDF user space points
  fontSize: number;        // in PDF points
  bold: boolean; italic: boolean;
  color: string;           // 6-char hex
}

interface DocImg {
  x: number; y: number;   // PDF user space top-down (top-left of image)
  widthPt: number; heightPt: number;
  buf: Buffer;
}

// ─── Matrix helpers ───────────────────────────────────────────────────────────

/** Concatenate two PDF matrices: C = A × B */
function mmul(A: M6, B: M6): M6 {
  return [
    A[0]*B[0] + A[2]*B[1],
    A[1]*B[0] + A[3]*B[1],
    A[0]*B[2] + A[2]*B[3],
    A[1]*B[2] + A[3]*B[3],
    A[0]*B[4] + A[2]*B[5] + A[4],
    A[1]*B[4] + A[3]*B[5] + A[5],
  ];
}

// ─── Color ────────────────────────────────────────────────────────────────────
// pdfjs stores color op args as 0-255 integers, NOT 0-1 floats.

const ch  = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
const rgb = (r: number, g: number, b: number) => `${ch(r)}${ch(g)}${ch(b)}`;
const cmyk = (c: number, m: number, y: number, k: number) => rgb(
  (1 - c / 255) * (1 - k / 255) * 255,
  (1 - m / 255) * (1 - k / 255) * 255,
  (1 - y / 255) * (1 - k / 255) * 255,
);
const isNearWhite = (hex: string) =>
  parseInt(hex.slice(0, 2), 16) > 230 &&
  parseInt(hex.slice(2, 4), 16) > 230 &&
  parseInt(hex.slice(4, 6), 16) > 230;

// ─── Image data → PNG ─────────────────────────────────────────────────────────

async function imgDataToPng(d: {
  data: Uint8Array | Uint8ClampedArray; width: number; height: number; kind: number;
}): Promise<Buffer> {
  const { width: w, height: h, kind } = d;
  const raw = Buffer.from(d.data.buffer instanceof ArrayBuffer ? d.data.buffer : d.data);
  if (raw[0] === 0xff && raw[1] === 0xd8) return sharp(raw).png().toBuffer();
  if (kind === 1) {
    const bpr = Math.ceil(w / 8);
    const exp = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        exp[y * w + x] = (raw[y * bpr + Math.floor(x / 8)] >> (7 - (x % 8))) & 1 ? 255 : 0;
    return sharp(Buffer.from(exp), { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
  }
  if (kind === 2) return sharp(raw.slice(0, w * h * 3), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  return sharp(raw.slice(0, w * h * 4), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

// ─── Extract page ─────────────────────────────────────────────────────────────

async function extractPage(
  page: any, OPS: any, pageH: number, pageW: number,
): Promise<{ items: RichItem[]; images: DocImg[] }> {

  const [tc, opList] = await Promise.all([
    page.getTextContent({ includeMarkedContent: false }),
    page.getOperatorList(),
  ]);

  const styles: Record<string, any> = tc.styles ?? {};
  const fn: number[] = opList.fnArray;
  const ar: any[][] = opList.argsArray;

  // ── Full CTM stack ─────────────────────────────────────────────────────────
  // We track the complete CTM at every point, so text/image positions
  // are correctly mapped to PDF user space.
  let ctmStack: M6[] = [[1, 0, 0, 1, 0, 0]];

  let tm: M6  = [1, 0, 0, 1, 0, 0]; // text matrix
  let tlm: M6 = [1, 0, 0, 1, 0, 0]; // text line matrix
  let fc = "000000";                  // current fill colour

  // Color observations in PDF user space (x from left, y from BOTTOM)
  const colorPts: { x: number; y: number; col: string }[] = [];

  // Images: CTM at time of paint + resource name
  const imgOps: { ctm: M6; name: string }[] = [];
  const seenImgs = new Set<string>();

  const IMAGE_OPS = new Set([
    OPS.paintImageXObject, OPS.paintImageMaskXObject,
    OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat, OPS.paintJpegXObject,
  ].filter(Boolean));

  const TEXT_DRAW_OPS = new Set([
    OPS.showText, OPS.showSpacedText,
    OPS.nextLineShowText, OPS.nextLineSetSpacingShowText,
  ].filter(Boolean));

  for (let i = 0; i < fn.length; i++) {
    const op = fn[i], a = ar[i];
    const ctm = ctmStack[ctmStack.length - 1];

    switch (op) {
      case OPS.save:
        ctmStack.push([...ctm] as M6);
        break;
      case OPS.restore:
        if (ctmStack.length > 1) ctmStack.pop();
        break;
      case OPS.transform:
        // PDF matrices concatenate: new = current × incoming
        ctmStack[ctmStack.length - 1] = mmul(ctm, a as M6);
        break;

      // Fill colour
      case OPS.setFillRGBColor:  fc = rgb(a[0], a[1], a[2]); break;
      case OPS.setFillGray:      fc = rgb(a[0], a[0], a[0]); break;
      case OPS.setFillCMYKColor: fc = cmyk(a[0], a[1], a[2], a[3]); break;
      case OPS.setFillColor:
        if (a.length >= 3) fc = rgb(a[0], a[1], a[2]);
        else if (a.length === 1) fc = rgb(a[0], a[0], a[0]);
        break;
      case OPS.setFillColorN:
        if (typeof a[0] === "number") {
          if (a.length >= 4)      fc = cmyk(a[0], a[1], a[2], a[3]);
          else if (a.length >= 3) fc = rgb(a[0], a[1], a[2]);
          else                    fc = rgb(a[0], a[0], a[0]);
        }
        break;

      // Text matrix
      case OPS.setTextMatrix:
        tm = [a[0], a[1], a[2], a[3], a[4], a[5]] as M6;
        tlm = [...tm] as M6;
        break;
      case OPS.moveText:
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4] + a[0], tlm[5] + a[1]] as M6;
        tm  = [...tlm] as M6;
        break;
      case OPS.setLeadingMoveText:
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4] + a[0], tlm[5] + a[1]] as M6;
        tm  = [...tlm] as M6;
        break;
      case OPS.nextLine:
        tm = [...tlm] as M6;
        break;
    }

    if (TEXT_DRAW_OPS.has(op)) {
      // Actual PDF position = CTM × TM origin
      const C = ctmStack[ctmStack.length - 1];
      const xPdf = C[0]*tm[4] + C[2]*tm[5] + C[4];
      const yPdf = C[1]*tm[4] + C[3]*tm[5] + C[5];
      colorPts.push({ x: xPdf, y: yPdf, col: fc });
    }

    if (IMAGE_OPS.has(op)) {
      const name = a[0] as string;
      if (typeof name === "string" && !seenImgs.has(name)) {
        seenImgs.add(name);
        // Snapshot the full CTM at image-paint time
        imgOps.push({ ctm: [...ctmStack[ctmStack.length - 1]] as M6, name });
      }
    }
  }

  // ── Assign colour to each text item ───────────────────────────────────────
  // Color points and text items are both in PDF user space — compare directly.
  // Use a tight threshold (20 pt) to avoid cross-contamination.

  const getColor = (xPdf: number, yPdf: number): string => {
    let best = "000000", bestD = Infinity;
    for (const p of colorPts) {
      const d = Math.abs(p.x - xPdf) + Math.abs(p.y - yPdf);
      if (d < bestD) { bestD = d; best = p.col; }
    }
    return bestD < 20 ? best : "000000";
  };

  // ── Build text items ───────────────────────────────────────────────────────

  const rawItems: RichItem[] = [];
  for (const raw of tc.items as any[]) {
    if (!("str" in raw) || !raw.str?.trim()) continue;
    const [a0, b0, , , xPdf, yPdf] = raw.transform as number[];
    const fontSize   = Math.sqrt(a0 ** 2 + b0 ** 2);
    const fontName   = raw.fontName ?? "";
    const fontFamily = styles[fontName]?.fontFamily ?? "";
    const col        = getColor(xPdf, yPdf);
    rawItems.push({
      str:      raw.str,
      x:        xPdf,
      y:        pageH - yPdf,          // flip to top-down
      width:    raw.width ?? 0,        // actual rendered width from pdfjs
      fontSize: Math.max(fontSize, 4),
      bold:     /bold/i.test(fontName + fontFamily),
      italic:   /italic|oblique/i.test(fontName + fontFamily),
      color:    isNearWhite(col) ? "000000" : col,
    });
  }

  // Remove duplicate renders (shadow/stroke layers some PDFs use)
  const items = rawItems.filter((item, i) =>
    !rawItems.some((o, j) =>
      j < i && o.str === item.str &&
      Math.abs(o.x - item.x) < 3 && Math.abs(o.y - item.y) < 3
    )
  );

  // ── Convert image CTM → PDF bounding box ──────────────────────────────────
  // The image unit square [0,1]×[0,1] is transformed by the full CTM.
  // Compute the axis-aligned bounding box of the four corners.

  const images: DocImg[] = [];
  for (const { ctm: C, name } of imgOps) {
    try {
      const imgData: any = await Promise.race<any>([
        new Promise<any>(res => page.objs.get(name, res)),
        new Promise<any>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
      ]).catch(() => new Promise<any>(res => page.commonObjs.get(name, res)));

      if (!imgData?.data || !imgData.width || !imgData.height) continue;

      // Four corners of the image unit square in PDF user space
      const corners = [
        [C[4],              C[5]],
        [C[0]+C[4],         C[1]+C[5]],
        [C[2]+C[4],         C[3]+C[5]],
        [C[0]+C[2]+C[4],    C[1]+C[3]+C[5]],
      ];
      const xs = corners.map(c => c[0]);
      const ys = corners.map(c => c[1]);
      const xMin = Math.min(...xs), xMax = Math.max(...xs);
      const yMin = Math.min(...ys), yMax = Math.max(...ys); // PDF y-up

      const widthPt  = xMax - xMin;
      const heightPt = yMax - yMin;

      if (widthPt < 4 || heightPt < 4) continue;
      if (widthPt > pageW * 1.05)      continue; // skip full-page backgrounds

      const yTopdown = pageH - yMax; // convert: PDF y-up → top-down

      const pngBuf = await imgDataToPng(imgData);
      images.push({ x: xMin, y: yTopdown, widthPt, heightPt, buf: pngBuf });
    } catch { /* skip */ }
  }

  return { items, images };
}

// ─── Flow-based reconstruction ────────────────────────────────────────────────

interface Line { items: RichItem[]; yTop: number; fontSize: number; colIndex: number }

// ─── Step 1: Cluster items into visual lines ──────────────────────────────────
// Items sharing the same y (± tolerance) form a line group.
// Lines are then split at large horizontal gaps so that left-column and
// right-column items are always in separate line groups — even before we
// know whether the page is single- or multi-column.

function clusterLines(items: RichItem[], pageW: number): RichItem[][] {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);

  // Group by y proximity
  const yGroups: RichItem[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const tol = Math.max(sorted[i - 1].fontSize, sorted[i].fontSize) * 0.55;
    if (Math.abs(sorted[i].y - sorted[i - 1].y) <= tol)
      yGroups[yGroups.length - 1].push(sorted[i]);
    else
      yGroups.push([sorted[i]]);
  }
  for (const g of yGroups) g.sort((a, b) => a.x - b.x);

  // Split each y-group at horizontal gaps ≥ 2% of page width (~12pt on US Letter).
  // This must be small enough to catch narrow academic column gaps (~20pt)
  // but large enough to not split word spacing (~3-5pt).
  const colGap = pageW * 0.02;
  const result: RichItem[][] = [];
  for (const g of yGroups) {
    let cur: RichItem[] = [g[0]];
    for (let i = 1; i < g.length; i++) {
      const prev      = g[i - 1];
      const prevRight = prev.x + (prev.width > 0 ? prev.width : prev.str.length * prev.fontSize * 0.55);
      if (g[i].x - prevRight > colGap) { result.push(cur); cur = [g[i]]; }
      else cur.push(g[i]);
    }
    result.push(cur);
  }
  return result;
}

// ─── Step 2: Detect page layout ───────────────────────────────────────────────

interface Layout {
  columns:        number;   // 1 or 2
  colBoundary:    number;   // x split point (pt), 0 if single-column
  colGapPt:       number;   // gap between columns (pt)
  leftMargin:     number;   // inferred left page margin (pt)
  rightMargin:    number;   // inferred right page margin (pt)
  topMargin:      number;   // inferred top page margin (pt)
  bottomMargin:   number;   // inferred bottom page margin (pt)
  headerLineIdxs: Set<number>; // line-group indices that are header (span full width)
}

function detectLayout(lineGroups: RichItem[][], pageW: number, pageH: number): Layout {
  // Compute xMin/xMax per line
  const lineSpans = lineGroups.map(lg => ({
    xMin: Math.min(...lg.map(i => i.x)),
    xMax: Math.max(...lg.map(i => i.x + (i.width > 0 ? i.width : i.str.length * i.fontSize * 0.5))),
  }));

  // Header lines: span > 50% of page width (title, authors, etc.)
  const headerLineIdxs = new Set<number>();
  for (let i = 0; i < lineSpans.length; i++) {
    if (lineSpans[i].xMax - lineSpans[i].xMin > pageW * 0.5)
      headerLineIdxs.add(i);
  }

  // Body lines: everything else
  const bodySpans = lineSpans.filter((_, i) => !headerLineIdxs.has(i));

  // Infer margins from body text extents
  const allXMins = bodySpans.map(s => s.xMin).filter(x => x > 0);
  const allXMaxs = bodySpans.map(s => s.xMax).filter(x => x < pageW);
  const allYTops = lineGroups.flatMap(lg => lg.map(i => i.y)).filter(y => y > 0);
  const allYBots = lineGroups.flatMap(lg => lg.map(i => i.y + i.fontSize)).filter(y => y < pageH);

  const leftMargin   = allXMins.length ? Math.min(...allXMins) : 72;
  const rightMargin  = allXMaxs.length ? pageW - Math.max(...allXMaxs) : 72;
  const topMargin    = allYTops.length ? Math.min(...allYTops) : 72;
  const bottomMargin = allYBots.length ? pageH - Math.max(...allYBots) : 72;

  // Two-column detection: find the largest gap in body xMin values in center 30–70% of page
  if (bodySpans.length < 4) {
    return { columns: 1, colBoundary: 0, colGapPt: 0, leftMargin, rightMargin, topMargin, bottomMargin, headerLineIdxs };
  }

  // Collect all body xMins, sort, find biggest gap in the center zone
  const xMins = [...new Set(bodySpans.map(s => Math.round(s.xMin)))].sort((a, b) => a - b);
  let maxGap = 0, gapAt = 0, gapEnd = 0;
  for (let i = 1; i < xMins.length; i++) {
    const gap = xMins[i] - xMins[i - 1];
    const pos = (xMins[i - 1] + xMins[i]) / 2;
    if (gap > maxGap && pos > pageW * 0.3 && pos < pageW * 0.7) {
      maxGap = gap; gapAt = xMins[i - 1]; gapEnd = xMins[i];
    }
  }

  if (maxGap >= pageW * 0.15) {
    const colBoundary = (gapAt + gapEnd) / 2;
    return { columns: 2, colBoundary, colGapPt: maxGap, leftMargin, rightMargin, topMargin, bottomMargin, headerLineIdxs };
  }

  return { columns: 1, colBoundary: 0, colGapPt: 0, leftMargin, rightMargin, topMargin, bottomMargin, headerLineIdxs };
}

// ─── Step 3: Sort items into reading order ────────────────────────────────────

function sortInReadingOrder(lineGroups: RichItem[][], layout: Layout): Line[] {
  const lines: Line[] = [];

  for (let gi = 0; gi < lineGroups.length; gi++) {
    const lg = lineGroups[gi];
    const isHeader = layout.headerLineIdxs.has(gi);
    const yTop     = Math.min(...lg.map(i => i.y));
    const fontSize = Math.max(...lg.map(i => i.fontSize));

    if (layout.columns === 1 || isHeader) {
      lines.push({ items: lg, yTop, fontSize, colIndex: isHeader ? -1 : 0 });
    } else {
      // Split line items into left/right column groups
      const left  = lg.filter(i => i.x < layout.colBoundary);
      const right = lg.filter(i => i.x >= layout.colBoundary);
      if (left.length)  lines.push({ items: left,  yTop, fontSize, colIndex: 0 });
      if (right.length) lines.push({ items: right, yTop, fontSize, colIndex: 1 });
    }
  }

  // Sort: header first (-1), then left col (0) top-down, then right col (1) top-down
  lines.sort((a, b) => {
    if (a.colIndex !== b.colIndex) return a.colIndex - b.colIndex;
    return a.yTop - b.yTop;
  });

  return lines;
}

// ─── Step 4: Build paragraphs from lines ─────────────────────────────────────

function linesToParagraphs(
  lines: Line[],
  colLeftEdge: number,
  Paragraph: any, TextRun: any,
): any[] {
  const PT_TWIP = 20;
  const paragraphs: any[] = [];

  let prevBottom  = -1;
  let prevColIdx  = -99;

  for (const line of lines) {
    // Only add extra space before when the gap is a real paragraph break —
    // i.e. significantly larger than normal line spacing (> 0.5× fontSize).
    // Reset when switching columns (y-gap is meaningless across columns).
    let spaceBefore = 0;
    const sameCol = line.colIndex === prevColIdx;
    if (prevBottom >= 0 && sameCol) {
      const gap = line.yTop - prevBottom;          // in PDF points
      const normalLineGap = line.fontSize * 0.5;   // what Word already renders
      if (gap > normalLineGap) {
        // Only encode the *extra* gap beyond normal line spacing, capped at 20pt
        const extraPt = Math.min(gap - normalLineGap, 20);
        spaceBefore = Math.round(extraPt * PT_TWIP);
      }
    }
    prevBottom = line.yTop + line.fontSize;
    prevColIdx = line.colIndex;

    // Indent relative to column left edge
    const lineX = Math.min(...line.items.map(i => i.x));
    const indentLeft = Math.max(0, Math.round((lineX - colLeftEdge) * PT_TWIP));

    // Merge runs with same style
    const runs: any[] = [];
    let rbuf = "", rcur: RichItem | null = null;

    const flush = () => {
      if (!rcur || !rbuf) return;
      runs.push(new TextRun({
        text:    rbuf,
        bold:    rcur.bold,
        italics: rcur.italic,
        color:   rcur.color !== "000000" ? rcur.color : undefined,
        size:    Math.max(16, Math.round(rcur.fontSize * 2)),
      }));
      rbuf = ""; rcur = null;
    };

    for (let ii = 0; ii < line.items.length; ii++) {
      const item = line.items[ii];
      const same = rcur !== null &&
        rcur.bold === item.bold && rcur.italic === item.italic &&
        rcur.color === item.color && Math.abs(rcur.fontSize - item.fontSize) < 0.5;
      if (!same) { flush(); rcur = item; rbuf = item.str; }
      else rbuf += item.str;

      // Auto-space between items with a visible gap
      if (ii < line.items.length - 1) {
        const nxt = line.items[ii + 1];
        const approxRight = item.x + item.str.length * item.fontSize * 0.5;
        if (!rbuf.endsWith(" ") && !nxt.str.startsWith(" ") &&
            nxt.x > approxRight + item.fontSize * 0.1)
          rbuf += " ";
      }
    }
    flush();
    if (!runs.length) continue;

    paragraphs.push(new Paragraph({
      children: runs,
      spacing:  { before: spaceBefore, after: 0, line: 276, lineRule: "auto" },
      indent:   indentLeft > 0 ? { left: indentLeft } : undefined,
    }));
  }

  return paragraphs;
}

// ─── Build DOCX ───────────────────────────────────────────────────────────────

async function buildDocx(
  pages: { items: RichItem[]; images: DocImg[]; pageW: number; pageH: number }[],
): Promise<Buffer> {
  const {
    Document, Packer, Paragraph, TextRun, ImageRun,
    HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom,
    TextWrappingType, PageOrientation, SectionType,
  } = await import("docx");

  const PT_TWIP = 20;
  const PT_EMU  = 12700;
  const sections: any[] = [];

  for (let pi = 0; pi < pages.length; pi++) {
    const { items, images, pageW, pageH } = pages[pi];
    const isFirstPage = pi === 0;

    // Cluster into lines, detect layout, sort into reading order
    const lineGroups = clusterLines(items, pageW);
    const layout     = detectLayout(lineGroups, pageW, pageH);
    const lines      = sortInReadingOrder(lineGroups, layout);

    // Clamp margins to sensible range
    const marginTop    = Math.min(Math.max(Math.round(layout.topMargin    * PT_TWIP), 360), 1440);
    const marginBottom = Math.min(Math.max(Math.round(layout.bottomMargin * PT_TWIP), 360), 1440);
    const marginLeft   = Math.min(Math.max(Math.round(layout.leftMargin   * PT_TWIP), 360), 1440);
    const marginRight  = Math.min(Math.max(Math.round(layout.rightMargin  * PT_TWIP), 360), 1440);

    const pageProps = {
      size: {
        width:  Math.round(pageW * PT_TWIP),
        height: Math.round(pageH * PT_TWIP),
        orientation: pageW > pageH ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
      },
      margin: { top: marginTop, right: marginRight, bottom: marginBottom, left: marginLeft },
    };

    // Floating images (same for all layout types)
    const imageParagraphs = images.map(img => {
      const scale = Math.min(1, (pageW * 0.98) / img.widthPt);
      const wPt   = img.widthPt  * scale;
      const hPt   = img.heightPt * scale;
      const wPx   = Math.round((wPt / 72) * 96);
      const hPx   = Math.round((hPt / 72) * 96);
      return new Paragraph({
        children: [new ImageRun({
          type: "png", data: img.buf,
          transformation: { width: wPx, height: hPx },
          floating: {
            horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: Math.round(img.x * PT_EMU) },
            verticalPosition:   { relative: VerticalPositionRelativeFrom.PAGE,   offset: Math.round(img.y * PT_EMU) },
            wrap: { type: TextWrappingType.NONE }, allowOverlap: true, behindDocument: true,
          },
        })],
      });
    });

    if (layout.columns === 1) {
      // ── Single-column section ────────────────────────────────────────────────
      const textParas = linesToParagraphs(lines, layout.leftMargin, Paragraph, TextRun);
      sections.push({
        properties: {
          type: isFirstPage ? undefined : SectionType.NEXT_PAGE,
          page: pageProps,
          column: { count: 1 },
        },
        children: [...imageParagraphs, ...textParas, new Paragraph({ children: [] })],
      });

    } else {
      // ── Two-column: header section + body section ────────────────────────────
      const headerLines = lines.filter(l => l.colIndex === -1);
      const bodyLines   = lines.filter(l => l.colIndex >= 0);

      const headerParas = linesToParagraphs(headerLines, layout.leftMargin, Paragraph, TextRun);
      const bodyParas   = linesToParagraphs(bodyLines,   layout.leftMargin, Paragraph, TextRun);

      const colGapTwips = Math.round(layout.colGapPt * PT_TWIP);

      // Section A: single-column header (or first page marker)
      sections.push({
        properties: {
          type: isFirstPage ? undefined : SectionType.NEXT_PAGE,
          page: pageProps,
          column: { count: 1 },
        },
        children: [
          ...imageParagraphs,
          ...headerParas,
          new Paragraph({ children: [] }),
        ],
      });

      // Section B: two-column body, continuous (no page break)
      sections.push({
        properties: {
          type: SectionType.CONTINUOUS,
          column: { count: 2, space: colGapTwips, equalWidth: true },
        },
        children: [...bodyParas, new Paragraph({ children: [] })],
      });
    }
  }

  const doc = new Document({ sections });
  return Packer.toBuffer(doc);
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const buf = await file.arrayBuffer();
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
      path.join(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")
    ).href;

    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const OPS = pdfjsLib.OPS;
    const pages: { items: RichItem[]; images: DocImg[]; pageW: number; pageH: number }[] = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const { items, images } = await extractPage(page, OPS, vp.height, vp.width);
      pages.push({ items, images, pageW: vp.width, pageH: vp.height });
    }

    const docxBuf  = await buildDocx(pages);
    const baseName = file.name.replace(/\.pdf$/i, "");

    return new NextResponse(docxBuf, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(`${baseName}.docx`)}"`,
      },
    });
  } catch (e) {
    console.error("[pdf-to-word]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Conversion failed" },
      { status: 500 }
    );
  }
}
