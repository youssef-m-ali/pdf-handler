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

// ─── Group text items into absolutely-positioned frames ───────────────────────

interface Line { items: RichItem[]; y: number; fs: number }

function buildTextFrames(items: RichItem[], pageW: number) {
  if (!items.length) return [];

  const sorted = [...items].sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);

  // Cluster into visual lines
  const lineGroups: RichItem[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const tol = Math.max(sorted[i - 1].fontSize, sorted[i].fontSize) * 0.55;
    if (Math.abs(sorted[i].y - sorted[i - 1].y) <= tol)
      lineGroups[lineGroups.length - 1].push(sorted[i]);
    else
      lineGroups.push([sorted[i]]);
  }
  for (const lg of lineGroups) lg.sort((a, b) => a.x - b.x);

  // Split lines at large column gaps
  const colGap = pageW * 0.12;
  const subLines: RichItem[][] = [];
  for (const lg of lineGroups) {
    let cur: RichItem[] = [lg[0]];
    for (let i = 1; i < lg.length; i++) {
      const prev = lg[i - 1];
      const prevRight = prev.x + prev.str.length * prev.fontSize * 0.55;
      if (lg[i].x - prevRight > colGap) { subLines.push(cur); cur = [lg[i]]; }
      else cur.push(lg[i]);
    }
    subLines.push(cur);
  }

  // Group sub-lines into frames (same rough x-origin + small vertical gap)
  const avgFs  = (g: RichItem[]) => g.reduce((s, x) => s + x.fontSize, 0) / g.length;
  const minX   = (g: RichItem[]) => Math.min(...g.map(i => i.x));
  const minY   = (g: RichItem[]) => Math.min(...g.map(i => i.y));

  type Frame = { lines: RichItem[][] };
  const frames: Frame[] = [];
  let curLines: RichItem[][] = [subLines[0]];

  for (let i = 1; i < subLines.length; i++) {
    const prev = subLines[i - 1];
    const curr = subLines[i];
    const gap    = minY(curr) - minY(prev) - avgFs(prev);
    const xDiff  = Math.abs(minX(curr) - minX(curLines[0]));
    const nearby = gap >= 0 && gap < avgFs(prev) * 1.2 && xDiff < pageW * 0.08;
    if (nearby) curLines.push(curr);
    else { frames.push({ lines: curLines }); curLines = [curr]; }
  }
  frames.push({ lines: curLines });

  return frames.map(f => {
    const all     = f.lines.flat();
    const x       = Math.min(...all.map(i => i.x));
    const y       = Math.min(...all.map(i => i.y));
    const maxFs   = Math.max(...all.map(i => i.fontSize));
    const maxRight = Math.max(...all.map(i => i.x + i.str.length * i.fontSize * 0.6));
    const maxY    = Math.max(...all.map(i => i.y));
    return {
      x, y,
      width:  Math.max(maxRight - x + maxFs, 40),
      height: Math.max(maxY - y + maxFs * 1.5, maxFs * 1.2),
      lines:  f.lines,
    };
  });
}

// ─── Build DOCX ───────────────────────────────────────────────────────────────

async function buildDocx(
  pages: { items: RichItem[]; images: DocImg[]; pageW: number; pageH: number }[],
): Promise<Buffer> {
  const {
    Document, Packer, Paragraph, TextRun, ImageRun,
    FrameAnchorType, FrameWrap,
    HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom,
    TextWrappingType, PageOrientation,
  } = await import("docx");

  const PT_TWIP = 20;
  const PT_EMU  = 12700;

  const sections: any[] = [];

  for (const { items, images, pageW, pageH } of pages) {
    const children: any[] = [];

    // ── Text frames ──────────────────────────────────────────────────────────
    for (const frame of buildTextFrames(items, pageW)) {
      const framePr = {
        position: {
          x: Math.round(frame.x * PT_TWIP),
          y: Math.round(frame.y * PT_TWIP),
        },
        width:  Math.round(frame.width  * PT_TWIP),
        height: Math.round(frame.height * PT_TWIP),
        anchor: { horizontal: FrameAnchorType.PAGE, vertical: FrameAnchorType.PAGE },
        wrap:   FrameWrap.NONE,
        allowOverlap: true,
      };

      for (const lineItems of frame.lines) {
        const runs: any[] = [];
        let rbuf = ""; let rcur: RichItem | null = null;

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

        for (let ii = 0; ii < lineItems.length; ii++) {
          const item = lineItems[ii];
          const same = rcur !== null &&
            rcur.bold === item.bold && rcur.italic === item.italic &&
            rcur.color === item.color && Math.abs(rcur.fontSize - item.fontSize) < 0.5;
          if (!same) { flush(); rcur = item; rbuf = item.str; }
          else rbuf += item.str;

          if (ii < lineItems.length - 1) {
            const nxt = lineItems[ii + 1];
            const approxRight = item.x + item.str.length * item.fontSize * 0.5;
            if (!rbuf.endsWith(" ") && !nxt.str.startsWith(" ") &&
                nxt.x > approxRight + item.fontSize * 0.1)
              rbuf += " ";
          }
        }
        flush();
        if (!runs.length) continue;

        children.push(new Paragraph({
          children: runs,
          frame:    framePr,
          spacing:  { line: 240 },
        }));
      }
    }

    // ── Floating images ───────────────────────────────────────────────────────
    for (const img of images) {
      const scale = Math.min(1, (pageW * 0.98) / img.widthPt);
      const wPt   = img.widthPt  * scale;
      const hPt   = img.heightPt * scale;
      const wPx   = Math.round((wPt / 72) * 96);
      const hPx   = Math.round((hPt / 72) * 96);

      children.push(new Paragraph({
        children: [new ImageRun({
          type: "png",
          data: img.buf,
          transformation: { width: wPx, height: hPx },
          floating: {
            horizontalPosition: {
              relative: HorizontalPositionRelativeFrom.PAGE,
              offset:   Math.round(img.x * PT_EMU),
            },
            verticalPosition: {
              relative: VerticalPositionRelativeFrom.PAGE,
              offset:   Math.round(img.y * PT_EMU),
            },
            wrap:         { type: TextWrappingType.NONE },
            allowOverlap: true,
            behindDocument: false,
          },
        })],
      }));
    }

    children.push(new Paragraph({ children: [] }));

    sections.push({
      properties: {
        page: {
          size: {
            width:  Math.round(pageW * PT_TWIP),
            height: Math.round(pageH * PT_TWIP),
            orientation: pageW > pageH ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
          },
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
        },
      },
      children,
    });
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
