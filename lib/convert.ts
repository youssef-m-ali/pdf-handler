import path from "path";
import { pathToFileURL } from "url";
import sharp from "sharp";

// ─── Types ────────────────────────────────────────────────────────────────────

type M6 = [number, number, number, number, number, number];

interface RichItem {
  str: string;
  x: number; y: number;   // PDF user space: x from left, y from TOP (top-down)
  width: number;           // actual rendered width in PDF user space points
  fontSize: number;        // in PDF points
  bold: boolean; italic: boolean;
  color: string;           // 6-char hex
  fontFamily: string;      // Word-compatible font name, e.g. "Times New Roman"
}

interface DocImg {
  x: number; y: number;   // PDF user space top-down (top-left of image)
  widthPt: number; heightPt: number;
  buf: Buffer;
}

// ─── Matrix helpers ───────────────────────────────────────────────────────────

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

// ─── Font family mapping ──────────────────────────────────────────────────────
// Maps the actual PostScript/TrueType font name (with subset prefix stripped)
// to the closest Word-installed font. Getting this right is critical: if we
// don't specify a font, Word defaults to Aptos whose character widths differ
// from Times New Roman, causing every justified PDF line to overflow by 1-2 words.

function toWordFont(name: string): string {
  const f = name.toLowerCase().replace(/[-_\s]/g, "");
  if (f.includes("arial") || f.includes("helvetica")) return "Arial";
  if (f.includes("timesnewroman") || f.includes("timesnr")) return "Times New Roman";
  if (f.includes("times"))     return "Times New Roman";
  if (f.includes("courier"))   return "Courier New";
  if (f.includes("calibri"))   return "Calibri";
  if (f.includes("georgia"))   return "Georgia";
  if (f.includes("verdana"))   return "Verdana";
  if (f.includes("tahoma"))    return "Tahoma";
  if (f.includes("palatino"))  return "Palatino Linotype";
  if (f.includes("garamond"))  return "Garamond";
  if (f.includes("bookantiqua") || f.includes("bookman")) return "Book Antiqua";
  if (f.includes("centuryschoolbook")) return "Century Schoolbook";
  if (f.includes("symbol"))    return "Symbol";
  // Computer Modern (LaTeX) — map to nearest standard equivalents
  if (/^cmtt|^cmsltt/.test(f)) return "Courier New";
  if (/^cm/.test(f))           return "Times New Roman";
  return "";
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

  // Build ref → actual font name map. pdfjs obfuscates font names in tc.styles
  // (e.g. "g_d0_f1"), but commonObjs holds the real PostScript name with subset
  // prefix stripped: "OGOFEC+Arial-BoldMT" → "Arial-BoldMT".
  const fontNameMap = new Map<string, string>();
  const uniqueFontRefs = new Set<string>();
  for (let i = 0; i < fn.length; i++) {
    if (fn[i] === OPS.setFont && typeof ar[i]?.[0] === "string")
      uniqueFontRefs.add(ar[i][0]);
  }
  await Promise.all([...uniqueFontRefs].map(async ref => {
    try {
      const font: any = await new Promise(res => page.commonObjs.get(ref, res));
      if (font?.name) fontNameMap.set(ref, font.name.replace(/^[A-Z]+\+/, ""));
    } catch { /* skip */ }
  }));

  let ctmStack: M6[] = [[1, 0, 0, 1, 0, 0]];
  let tm: M6  = [1, 0, 0, 1, 0, 0];
  let tlm: M6 = [1, 0, 0, 1, 0, 0];
  let fc = "000000";

  const colorPts: { x: number; y: number; col: string }[] = [];
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
        ctmStack[ctmStack.length - 1] = mmul(ctm, a as M6);
        break;
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
      const C = ctmStack[ctmStack.length - 1];
      const xPdf = C[0]*tm[4] + C[2]*tm[5] + C[4];
      const yPdf = C[1]*tm[4] + C[3]*tm[5] + C[5];
      colorPts.push({ x: xPdf, y: yPdf, col: fc });
    }

    if (IMAGE_OPS.has(op)) {
      const name = a[0] as string;
      if (typeof name === "string" && !seenImgs.has(name)) {
        seenImgs.add(name);
        imgOps.push({ ctm: [...ctmStack[ctmStack.length - 1]] as M6, name });
      }
    }
  }

  const getColor = (xPdf: number, yPdf: number): string => {
    let best = "000000", bestD = Infinity;
    for (const p of colorPts) {
      const d = Math.abs(p.x - xPdf) + Math.abs(p.y - yPdf);
      if (d < bestD) { bestD = d; best = p.col; }
    }
    return bestD < 20 ? best : "000000";
  };

  const rawItems: RichItem[] = [];
  for (const raw of tc.items as any[]) {
    if (!("str" in raw) || !raw.str?.trim()) continue;
    const [a0, b0, , , xPdf, yPdf] = raw.transform as number[];
    const fontSize      = Math.sqrt(a0 ** 2 + b0 ** 2);
    const fontRef       = raw.fontName ?? "";
    const actualFont    = fontNameMap.get(fontRef) ?? styles[fontRef]?.fontFamily ?? fontRef;
    const col           = getColor(xPdf, yPdf);
    rawItems.push({
      str:        raw.str,
      x:          xPdf,
      y:          pageH - yPdf,
      width:      raw.width ?? 0,
      fontSize:   Math.max(fontSize, 4),
      bold:       /bold|black|heavy|demi|semibold/i.test(actualFont),
      italic:     /italic|oblique|slanted/i.test(actualFont),
      color:      isNearWhite(col) ? "000000" : col,
      fontFamily: toWordFont(actualFont),
    });
  }

  const items = rawItems.filter((item, i) =>
    !rawItems.some((o, j) =>
      j < i && o.str === item.str &&
      Math.abs(o.x - item.x) < 3 && Math.abs(o.y - item.y) < 3
    )
  );

  const images: DocImg[] = [];
  for (const { ctm: C, name } of imgOps) {
    try {
      const imgData: any = await Promise.race<any>([
        new Promise<any>(res => page.objs.get(name, res)),
        new Promise<any>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
      ]).catch(() => new Promise<any>(res => page.commonObjs.get(name, res)));

      if (!imgData?.data || !imgData.width || !imgData.height) continue;

      const corners = [
        [C[4],              C[5]],
        [C[0]+C[4],         C[1]+C[5]],
        [C[2]+C[4],         C[3]+C[5]],
        [C[0]+C[2]+C[4],    C[1]+C[3]+C[5]],
      ];
      const xs = corners.map(c => c[0]);
      const ys = corners.map(c => c[1]);
      const xMin = Math.min(...xs), xMax = Math.max(...xs);
      const yMin = Math.min(...ys), yMax = Math.max(...ys);

      const widthPt  = xMax - xMin;
      const heightPt = yMax - yMin;

      if (widthPt < 4 || heightPt < 4) continue;
      if (widthPt > pageW * 1.05)      continue;

      const yTopdown = pageH - yMax;

      const pngBuf = await imgDataToPng(imgData);
      images.push({ x: xMin, y: yTopdown, widthPt, heightPt, buf: pngBuf });
    } catch { /* skip */ }
  }

  return { items, images };
}

// ─── Flow-based reconstruction ────────────────────────────────────────────────

interface Line { items: RichItem[]; yTop: number; fontSize: number; colIndex: number; centered: boolean }

function clusterLines(items: RichItem[], pageW: number): RichItem[][] {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);

  const yGroups: RichItem[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const tol = Math.max(sorted[i - 1].fontSize, sorted[i].fontSize) * 0.55;
    if (Math.abs(sorted[i].y - sorted[i - 1].y) <= tol)
      yGroups[yGroups.length - 1].push(sorted[i]);
    else
      yGroups.push([sorted[i]]);
  }
  for (const g of yGroups) g.sort((a, b) => a.x - b.x);

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

interface Layout {
  columns:        number;
  colBoundary:    number;
  colGapPt:       number;
  leftMargin:     number;
  rightMargin:    number;
  topMargin:      number;
  bottomMargin:   number;
  headerLineIdxs: Set<number>;
}

function detectLayout(lineGroups: RichItem[][], pageW: number, pageH: number): Layout {
  const lineSpans = lineGroups.map(lg => ({
    xMin: Math.min(...lg.map(i => i.x)),
    xMax: Math.max(...lg.map(i => i.x + (i.width > 0 ? i.width : i.str.length * i.fontSize * 0.5))),
  }));

  const headerLineIdxs = new Set<number>();
  for (let i = 0; i < lineSpans.length; i++) {
    const span = lineSpans[i];
    const spanWidth = span.xMax - span.xMin;
    const centerX   = (span.xMin + span.xMax) / 2;
    const yTop      = Math.min(...lineGroups[i].map(item => item.y));
    // Wide span: line stretches across most of the page (title, full-width author line)
    const wideSpan = spanWidth > pageW * 0.5;
    // Page-centered narrow line: e.g. "and Werner Vogels", "Amazon.com" — centered
    // on the page but too short to trigger wideSpan. Only in the top 30% of the page
    // so we don't accidentally pull body section headings into the header zone.
    const pageCentered = Math.abs(centerX - pageW * 0.5) < pageW * 0.1 && yTop < pageH * 0.3;
    if (wideSpan || pageCentered) headerLineIdxs.add(i);
  }

  const bodySpans = lineSpans.filter((_, i) => !headerLineIdxs.has(i));

  const allXMins = bodySpans.map(s => s.xMin).filter(x => x > 0);
  const allXMaxs = bodySpans.map(s => s.xMax).filter(x => x < pageW);
  const allYTops = lineGroups.flatMap(lg => lg.map(i => i.y)).filter(y => y > 0);
  const allYBots = lineGroups.flatMap(lg => lg.map(i => i.y + i.fontSize)).filter(y => y < pageH);

  const leftMargin   = allXMins.length ? Math.min(...allXMins) : 72;
  const rightMargin  = allXMaxs.length ? pageW - Math.max(...allXMaxs) : 72;
  const topMargin    = allYTops.length ? Math.min(...allYTops) : 72;
  const bottomMargin = allYBots.length ? pageH - Math.max(...allYBots) : 72;

  if (bodySpans.length < 6) {
    return { columns: 1, colBoundary: 0, colGapPt: 0, leftMargin, rightMargin, topMargin, bottomMargin, headerLineIdxs };
  }

  const leftBodySpans  = bodySpans.filter(s => s.xMin < pageW * 0.5);
  const rightBodySpans = bodySpans.filter(s => s.xMin >= pageW * 0.5);

  if (leftBodySpans.length >= 5 && rightBodySpans.length >= 5) {
    // Use right edge of left column (max xMax) and left edge of right column (min xMin).
    // This measures the actual white-space gap between columns, not dependent on
    // any specific line's xMin position.
    const leftEdge  = Math.max(...leftBodySpans.map(s => s.xMax));
    const rightEdge = Math.min(...rightBodySpans.map(s => s.xMin));
    const gap = rightEdge - leftEdge;
    if (gap >= 4 && gap <= pageW * 0.3) {
      const colBoundary = (leftEdge + rightEdge) / 2;
      return { columns: 2, colBoundary, colGapPt: gap, leftMargin, rightMargin, topMargin, bottomMargin, headerLineIdxs };
    }
  }

  return { columns: 1, colBoundary: 0, colGapPt: 0, leftMargin, rightMargin, topMargin, bottomMargin, headerLineIdxs };
}

function sortInReadingOrder(lineGroups: RichItem[][], layout: Layout, pageW: number): Line[] {
  const lines: Line[] = [];

  for (let gi = 0; gi < lineGroups.length; gi++) {
    const lg = lineGroups[gi];
    const isHeader = layout.headerLineIdxs.has(gi);
    const yTop     = Math.min(...lg.map(i => i.y));
    const fontSize = Math.max(...lg.map(i => i.fontSize));

    // Detect centering: header lines whose center x is within 8% of the page center.
    // Body lines are never marked centered (they're left-aligned or justified).
    const xMin    = Math.min(...lg.map(i => i.x));
    const xMax    = Math.max(...lg.map(i => i.x + (i.width > 0 ? i.width : i.str.length * i.fontSize * 0.55)));
    const centerX = (xMin + xMax) / 2;
    const centered = isHeader && Math.abs(centerX - pageW * 0.5) < pageW * 0.08;

    if (layout.columns === 1 || isHeader) {
      lines.push({ items: lg, yTop, fontSize, colIndex: isHeader ? -1 : 0, centered });
    } else {
      const left  = lg.filter(i => i.x < layout.colBoundary);
      const right = lg.filter(i => i.x >= layout.colBoundary);
      if (left.length)  lines.push({ items: left,  yTop, fontSize, colIndex: 0, centered: false });
      if (right.length) lines.push({ items: right, yTop, fontSize, colIndex: 1, centered: false });
    }
  }

  lines.sort((a, b) => {
    if (a.colIndex !== b.colIndex) return a.colIndex - b.colIndex;
    return a.yTop - b.yTop;
  });

  return lines;
}

function linesToParagraphs(
  lines: Line[],
  colLeftEdges: Record<number, number>,
  Paragraph: any, TextRun: any, AlignmentType: any,
): any[] {
  const PT_TWIP = 20;

  // ── Step 1: group consecutive lines into paragraph groups ──────────────────
  // A new paragraph starts when:
  //   • the column changes (colIndex differs), or
  //   • there is a vertical gap larger than normal line spacing
  // Grouping lets Word's justification engine reflow the whole paragraph,
  // which compensates for minor font-metric differences between the PDF's
  // embedded font and the system font.
  interface Group { lines: Line[]; spaceBefore: number }
  const groups: Group[] = [];
  let prevBottom = -1;
  let prevColIdx = -99;

  for (const line of lines) {
    let spaceBefore = 0;
    const sameCol = line.colIndex === prevColIdx;
    if (prevBottom >= 0 && sameCol) {
      const gap = line.yTop - prevBottom;
      const normalLineGap = line.fontSize * 0.5;
      if (gap > normalLineGap) {
        const extraPt = Math.min(gap - normalLineGap, 20);
        spaceBefore = Math.round(extraPt * PT_TWIP);
      }
    }
    prevBottom = line.yTop + line.fontSize;
    prevColIdx = line.colIndex;

    if (spaceBefore > 0 || groups.length === 0 || !sameCol) {
      groups.push({ lines: [line], spaceBefore });
    } else {
      groups[groups.length - 1].lines.push(line);
    }
  }

  // ── Step 2: build one Paragraph per group ─────────────────────────────────
  const paragraphs: any[] = [];

  for (const group of groups) {
    const firstLine  = group.lines[0];
    const isCentered = firstLine.centered;
    const colEdge    = colLeftEdges[firstLine.colIndex] ?? colLeftEdges[0] ?? 0;
    const lineX      = Math.min(...firstLine.items.map(i => i.x));
    const indentLeft = isCentered ? 0 : Math.max(0, Math.round((lineX - colEdge) * PT_TWIP));

    const runs: any[] = [];
    let rbuf = "", rcur: RichItem | null = null;
    let needSpace = false; // inject a space at the start of each continuation line

    const flush = () => {
      if (!rcur || !rbuf) return;
      runs.push(new TextRun({
        text:    rbuf,
        bold:    rcur.bold,
        italics: rcur.italic,
        color:   rcur.color !== "000000" ? rcur.color : undefined,
        size:    Math.max(16, Math.round(rcur.fontSize * 2)),
        font:    rcur.fontFamily ? { name: rcur.fontFamily } : undefined,
      }));
      rbuf = ""; rcur = null;
    };

    for (let li = 0; li < group.lines.length; li++) {
      const line = group.lines[li];
      if (li > 0) needSpace = true; // line boundary → need a separator space

      for (let ii = 0; ii < line.items.length; ii++) {
        const item = line.items[ii];
        const sameStyle = rcur !== null &&
          rcur.bold === item.bold && rcur.italic === item.italic &&
          rcur.color === item.color && Math.abs(rcur.fontSize - item.fontSize) < 0.5 &&
          rcur.fontFamily === item.fontFamily;

        if (!sameStyle) {
          flush();
          rcur = item;
          rbuf = (needSpace && !item.str.startsWith(" ")) ? " " + item.str : item.str;
          needSpace = false;
        } else {
          if (needSpace && !rbuf.endsWith(" ") && !item.str.startsWith(" "))
            rbuf += " ";
          needSpace = false;
          rbuf += item.str;
        }

        // Auto-space between items within the same line
        if (ii < line.items.length - 1) {
          const nxt       = line.items[ii + 1];
          const itemRight = item.x + (item.width > 0 ? item.width : item.str.length * item.fontSize * 0.55);
          if (!rbuf.endsWith(" ") && !nxt.str.startsWith(" ") &&
              nxt.x > itemRight + item.fontSize * 0.1)
            rbuf += " ";
        }
      }
    }
    flush();
    if (!runs.length) continue;

    paragraphs.push(new Paragraph({
      children:  runs,
      // Justified for body text: Word stretches each line to fill the column,
      // compensating for any font-metric delta vs the PDF's embedded font.
      // Centred for header lines. Single-line paragraphs with JUSTIFIED are
      // rendered left-aligned by Word (last-line rule), which is correct for
      // section headings and other short lines.
      alignment: isCentered ? AlignmentType.CENTER : AlignmentType.JUSTIFIED,
      spacing:   { before: group.spaceBefore, after: 0 },
      indent:    indentLeft > 0 ? { left: indentLeft } : undefined,
    }));
  }

  return paragraphs;
}

async function buildDocx(
  pages: { items: RichItem[]; images: DocImg[]; pageW: number; pageH: number }[],
): Promise<Buffer> {
  const {
    Document, Packer, Paragraph, TextRun, ImageRun, AlignmentType,
    HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom,
    TextWrappingType, PageOrientation, SectionType,
  } = await import("docx");

  const PT_TWIP = 20;
  const PT_EMU  = 12700;
  const sections: any[] = [];

  for (let pi = 0; pi < pages.length; pi++) {
    const { items, images, pageW, pageH } = pages[pi];
    const isFirstPage = pi === 0;

    const lineGroups = clusterLines(items, pageW);
    const layout     = detectLayout(lineGroups, pageW, pageH);
    const lines      = sortInReadingOrder(lineGroups, layout, pageW);

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
      const textParas = linesToParagraphs(lines, { [-1]: layout.leftMargin, 0: layout.leftMargin }, Paragraph, TextRun, AlignmentType);
      sections.push({
        properties: {
          type: isFirstPage ? undefined : SectionType.NEXT_PAGE,
          page: pageProps,
          column: { count: 1 },
        },
        children: [...imageParagraphs, ...textParas, new Paragraph({ children: [] })],
      });
    } else {
      const headerLines = lines.filter(l => l.colIndex === -1);
      const bodyLines   = lines.filter(l => l.colIndex >= 0);

      const headerParas   = linesToParagraphs(headerLines, { [-1]: layout.leftMargin }, Paragraph, TextRun, AlignmentType);
      const rightColStart = layout.colBoundary + layout.colGapPt / 2;
      const bodyParas     = linesToParagraphs(bodyLines, { 0: layout.leftMargin, 1: rightColStart }, Paragraph, TextRun, AlignmentType);

      const colGapTwips = Math.round(layout.colGapPt * PT_TWIP);

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

// ─── Main export ──────────────────────────────────────────────────────────────

export async function convertPdfToDocx(buf: Buffer | Uint8Array): Promise<Buffer> {
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

  return buildDocx(pages);
}
