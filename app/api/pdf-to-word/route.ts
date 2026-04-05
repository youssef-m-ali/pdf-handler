import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { pathToFileURL } from "url";
import sharp from "sharp";

export const maxDuration = 60;

// ─── Types ────────────────────────────────────────────────────────────────────

type M6 = [number, number, number, number, number, number];

interface RichItem {
  str: string;
  x: number;
  y: number;        // top-down (flipped from PDF bottom-up)
  fontSize: number; // in points
  bold: boolean;
  italic: boolean;
  color: string;    // 6-char hex
}

interface DocImg {
  y: number;
  widthPt: number;
  heightPt: number;
  buf: Buffer;
}

// ─── Matrix math ──────────────────────────────────────────────────────────────

const mulM = (a: M6, b: M6): M6 => [
  a[0]*b[0] + a[1]*b[2],       a[0]*b[1] + a[1]*b[3],
  a[2]*b[0] + a[3]*b[2],       a[2]*b[1] + a[3]*b[3],
  a[4]*b[0] + a[5]*b[2] + b[4], a[4]*b[1] + a[5]*b[3] + b[5],
];

// ─── Color helpers ─────────────────────────────────────────────────────────────

const ch = (v: number) =>
  Math.round(Math.max(0, Math.min(255, v * 255))).toString(16).padStart(2, "0");
const toHex = (r: number, g: number, b: number) => `${ch(r)}${ch(g)}${ch(b)}`;

// ─── Image data → PNG buffer ───────────────────────────────────────────────────

async function imgDataToPng(imgData: {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  kind: number;
}): Promise<Buffer> {
  const { data, width, height, kind } = imgData;
  const raw = Buffer.from(data.buffer instanceof ArrayBuffer ? data.buffer : data);

  // Raw JPEG bytes — pass through sharp to get PNG
  if (raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) {
    return sharp(raw).png().toBuffer();
  }

  // kind: 1 = GRAYSCALE_1BPP, 2 = RGB_24BPP, 3 = RGBA_32BPP
  if (kind === 1) {
    const bytesPerRow = Math.ceil(width / 8);
    const expanded = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = raw[y * bytesPerRow + Math.floor(x / 8)];
        expanded[y * width + x] = (byte >> (7 - (x % 8))) & 1 ? 255 : 0;
      }
    }
    return sharp(Buffer.from(expanded), { raw: { width, height, channels: 1 } }).png().toBuffer();
  }
  if (kind === 2) {
    return sharp(raw.slice(0, width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer();
  }
  // kind === 3 (RGBA) or fallback
  return sharp(raw.slice(0, width * height * 4), { raw: { width, height, channels: 4 } }).png().toBuffer();
}

// ─── Extract one page ─────────────────────────────────────────────────────────

async function extractPage(
  page: any,
  OPS: any,
  pageH: number,
  pageW: number,
): Promise<{ items: RichItem[]; images: DocImg[] }> {
  const [tc, opList] = await Promise.all([
    page.getTextContent({ includeMarkedContent: false }),
    page.getOperatorList(),
  ]);

  const styles: Record<string, any> = tc.styles ?? {};

  // ── Walk operator list: track CTM, text matrix, fill color, images ──────────

  const ctmStack: M6[] = [[1, 0, 0, 1, 0, 0]];
  let tm: M6 = [1, 0, 0, 1, 0, 0];
  let tlm: M6 = [1, 0, 0, 1, 0, 0];
  let fc = "000000";

  const colorPts: { tx: number; ty: number; col: string }[] = [];
  const imgOps: { ctm: M6; name: string }[] = [];
  const seenImgs = new Set<string>();

  const IMAGE_OPS = new Set([
    OPS.paintImageXObject,
    OPS.paintImageMaskXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageXObjectRepeat,
    OPS.paintJpegXObject,
  ].filter(Boolean));

  const TEXT_DRAW_OPS = new Set([
    OPS.showText,
    OPS.showSpacedText,
    OPS.nextLineShowText,
    OPS.nextLineSetSpacingShowText,
  ].filter(Boolean));

  const fn: number[] = opList.fnArray;
  const ar: any[][] = opList.argsArray;

  for (let i = 0; i < fn.length; i++) {
    const op = fn[i];
    const a = ar[i];

    switch (op) {
      case OPS.save:
        ctmStack.push([...ctmStack[ctmStack.length - 1]] as M6); break;
      case OPS.restore:
        if (ctmStack.length > 1) ctmStack.pop(); break;
      case OPS.transform:
        ctmStack[ctmStack.length - 1] = mulM(ctmStack[ctmStack.length - 1], a as M6); break;
      case OPS.setFillRGBColor:
        fc = toHex(a[0], a[1], a[2]); break;
      case OPS.setFillGray:
        fc = toHex(a[0], a[0], a[0]); break;
      case OPS.setFillCMYKColor:
        fc = toHex((1-a[0])*(1-a[3]), (1-a[1])*(1-a[3]), (1-a[2])*(1-a[3])); break;
      case OPS.setFillColor:
        if (a.length >= 3) fc = toHex(a[0], a[1], a[2]);
        else if (a.length === 1) fc = toHex(a[0], a[0], a[0]);
        break;
      case OPS.setFillColorN:
        if (typeof a[0] === "number") {
          if (a.length >= 4) fc = toHex((1-a[0])*(1-a[3]), (1-a[1])*(1-a[3]), (1-a[2])*(1-a[3]));
          else if (a.length >= 3) fc = toHex(a[0], a[1], a[2]);
          else if (a.length >= 1) fc = toHex(a[0], a[0], a[0]);
        }
        break;
      case OPS.setTextMatrix:
        tm = [a[0], a[1], a[2], a[3], a[4], a[5]]; tlm = [...tm] as M6; break;
      case OPS.moveText:
        tlm = mulM(tlm, [1, 0, 0, 1, a[0], a[1]]); tm = [...tlm] as M6; break;
      case OPS.setLeadingMoveText:
        tlm = mulM(tlm, [1, 0, 0, 1, a[0], a[1]]); tm = [...tlm] as M6; break;
      case OPS.nextLine:
        tm = [...tlm] as M6; break;
    }

    if (TEXT_DRAW_OPS.has(op)) {
      colorPts.push({ tx: tm[4], ty: tm[5], col: fc });
    }

    if (IMAGE_OPS.has(op)) {
      const name = a[0] as string;
      if (typeof name === "string" && !seenImgs.has(name)) {
        seenImgs.add(name);
        imgOps.push({ ctm: [...ctmStack[ctmStack.length - 1]] as M6, name });
      }
    }
  }

  // ── Find nearest color for a text item ────────────────────────────────────

  const getColor = (tx: number, ty: number): string => {
    let best = "000000";
    let bestD = Infinity;
    for (const p of colorPts) {
      const d = Math.abs(p.tx - tx) + Math.abs(p.ty - ty);
      if (d < bestD) { bestD = d; best = p.col; }
    }
    return bestD < 300 ? best : "000000";
  };

  // ── Build rich text items ──────────────────────────────────────────────────

  const rawItems: RichItem[] = [];

  for (const raw of tc.items as any[]) {
    if (!("str" in raw) || !raw.str?.trim()) continue;
    const [a0, b0, , , tx, ty] = raw.transform as number[];
    const fontSize = Math.sqrt(a0 ** 2 + b0 ** 2);
    const fontName: string = raw.fontName ?? "";
    const fontFamily: string = styles[fontName]?.fontFamily ?? "";

    rawItems.push({
      str: raw.str,
      x: tx,
      y: pageH - ty,   // flip to top-down
      fontSize: Math.max(fontSize, 4),
      bold: /bold/i.test(fontName + fontFamily),
      italic: /italic|oblique/i.test(fontName + fontFamily),
      color: getColor(tx, ty),
    });
  }

  // Deduplicate items with same str at nearly the same position (duplicate layers)
  const items = rawItems.filter((item, i) =>
    !rawItems.some((other, j) =>
      j < i &&
      other.str === item.str &&
      Math.abs(other.x - item.x) < 3 &&
      Math.abs(other.y - item.y) < 3
    )
  );

  // ── Extract images ─────────────────────────────────────────────────────────

  const images: DocImg[] = [];

  for (const { ctm, name } of imgOps) {
    try {
      const imgData: any = await Promise.race<any>([
        new Promise<any>(res => page.objs.get(name, res)),
        new Promise<any>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
      ]).catch(() =>
        new Promise<any>(res => page.commonObjs.get(name, res))
      );

      if (!imgData?.data || !imgData.width || !imgData.height) continue;

      const widthPt  = Math.abs(ctm[0]);
      const heightPt = Math.abs(ctm[3]);

      // Skip tiny images (borders, bullets, artefacts) and images wider than the page
      if (widthPt < 8 || heightPt < 8) continue;
      if (widthPt > pageW * 1.05) continue;

      // Convert PDF bottom-up to top-down.
      // ctm[5] = bottom-left Y of the image in PDF coordinates.
      // When ctm[3] > 0 (non-flipped): top of image in PDF = ctm[5] + heightPt
      //   → top in top-down = pageH - (ctm[5] + heightPt)
      // When ctm[3] < 0 (flipped):    ctm[5] is already the top in PDF coordinates
      //   → top in top-down = pageH - ctm[5]
      const imgY = pageH - ctm[5] - (ctm[3] >= 0 ? heightPt : 0);

      const pngBuf = await imgDataToPng(imgData);
      images.push({ y: imgY, widthPt, heightPt, buf: pngBuf });
    } catch {
      // Image extraction failed — skip gracefully
    }
  }

  return { items, images };
}

// ─── Group items → lines → paragraphs ─────────────────────────────────────────

interface Line { items: RichItem[]; y: number; fs: number }
interface Para { lines: Line[] }

function buildParagraphs(items: RichItem[], pageW: number): Para[] {
  if (!items.length) return [];

  const sorted = [...items].sort((a, b) =>
    a.y !== b.y ? a.y - b.y : a.x - b.x
  );

  // Group into lines by Y proximity
  const lines: Line[] = [];
  let cur: RichItem[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const tol = Math.max(sorted[i - 1].fontSize, sorted[i].fontSize) * 0.6;
    if (Math.abs(sorted[i].y - sorted[i - 1].y) <= tol) {
      cur.push(sorted[i]);
    } else {
      const fs = cur.reduce((s, x) => s + x.fontSize, 0) / cur.length;
      lines.push({ items: cur.sort((a, b) => a.x - b.x), y: cur[0].y, fs });
      cur = [sorted[i]];
    }
  }
  {
    const fs = cur.reduce((s, x) => s + x.fontSize, 0) / cur.length;
    lines.push({ items: cur.sort((a, b) => a.x - b.x), y: cur[0].y, fs });
  }

  // Split lines with large column gaps into two separate lines.
  // A "column gap" is a horizontal gap > 15% of page width between adjacent items.
  const colGapThreshold = pageW * 0.15;
  const splitLines: Line[] = [];
  for (const line of lines) {
    if (line.items.length < 2) { splitLines.push(line); continue; }

    const groups: RichItem[][] = [[line.items[0]]];
    for (let i = 1; i < line.items.length; i++) {
      const prev = line.items[i - 1];
      const curr = line.items[i];
      // Approximate right edge of previous item
      const prevRight = prev.x + prev.str.length * prev.fontSize * 0.55;
      if (curr.x - prevRight > colGapThreshold) {
        groups.push([curr]);
      } else {
        groups[groups.length - 1].push(curr);
      }
    }

    for (const g of groups) {
      const fs = g.reduce((s, x) => s + x.fontSize, 0) / g.length;
      splitLines.push({ items: g, y: g[0].y, fs });
    }
  }

  // Measure inter-line gaps to detect paragraph breaks
  const gaps = splitLines.slice(1).map((l, i) => l.y - splitLines[i].y - splitLines[i].fs);
  const posGaps = gaps.filter(g => g >= 0).sort((a, b) => a - b);
  const medGap = posGaps[Math.floor(posGaps.length / 2)] ?? 0;
  const paraThresh = Math.max(medGap * 1.8, (splitLines[0]?.fs ?? 10) * 0.7);

  const paras: Para[] = [];
  let para: Para = { lines: [splitLines[0]] };

  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i] > paraThresh) {
      paras.push(para);
      para = { lines: [splitLines[i + 1]] };
    } else {
      para.lines.push(splitLines[i + 1]);
    }
  }
  paras.push(para);

  return paras;
}

// ─── Build DOCX ────────────────────────────────────────────────────────────────

async function buildDocx(
  pages: { items: RichItem[]; images: DocImg[]; pageW: number }[]
): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun, ImageRun, PageBreak } =
    await import("docx");

  // Determine body font size as 40th percentile across all pages
  const allSizes = pages
    .flatMap(p => p.items.filter(i => i.str.trim()).map(i => i.fontSize))
    .sort((a, b) => a - b);
  const bodyPt = allSizes[Math.floor(allSizes.length * 0.4)] ?? 11;

  // Heading threshold: 30% larger than body
  const headingThreshold = bodyPt * 1.3;

  const docChildren: any[] = [];

  for (let pi = 0; pi < pages.length; pi++) {
    if (pi > 0) {
      docChildren.push(new Paragraph({ children: [new PageBreak()] }));
    }

    const { items, images, pageW } = pages[pi];
    const paras = buildParagraphs(items, pageW);

    // Interleave paragraphs and images sorted by Y position
    type Block =
      | { kind: "para"; para: Para; y: number }
      | { kind: "img"; img: DocImg; y: number };

    const blocks: Block[] = [
      ...paras.map(p => ({ kind: "para" as const, para: p, y: p.lines[0].y })),
      ...images.map(img => ({ kind: "img" as const, img, y: img.y })),
    ].sort((a, b) => a.y - b.y);

    for (const block of blocks) {

      // ── Image block ─────────────────────────────────────────────────────────
      if (block.kind === "img") {
        const { widthPt, heightPt, buf } = block.img;
        // Max usable width = 6.5" at 96 DPI = 624px
        const maxWPx = 624;
        const wPx = (widthPt / 72) * 96;
        const hPx = (heightPt / 72) * 96;
        const scale = Math.min(1, maxWPx / wPx);
        docChildren.push(
          new Paragraph({
            children: [
              new ImageRun({
                type: "png",
                data: buf,
                transformation: {
                  width: Math.round(wPx * scale),
                  height: Math.round(hPx * scale),
                },
              }),
            ],
            spacing: { before: 80, after: 80 },
          })
        );
        continue;
      }

      // ── Text paragraph block ────────────────────────────────────────────────
      const { para } = block;
      const allItems = para.lines.flatMap(l => l.items);
      if (!allItems.some(i => i.str.trim())) continue;

      const avgFs = allItems.reduce((s, i) => s + i.fontSize, 0) / allItems.length;
      const isHeading = avgFs > headingThreshold;
      // docx size is in half-points
      const halfPt = (fs: number) => Math.max(16, Math.round(fs * 2));

      // Build TextRuns, merging runs with identical style
      const runs: any[] = [];
      let rbuf = "";
      let rcur: RichItem | null = null;

      const flushRun = () => {
        if (!rcur || !rbuf) return;
        runs.push(
          new TextRun({
            text: rbuf,
            bold: rcur.bold || isHeading,
            italics: rcur.italic,
            color: rcur.color !== "000000" ? rcur.color : undefined,
            size: halfPt(rcur.fontSize),
          })
        );
        rbuf = "";
        rcur = null;
      };

      for (let li = 0; li < para.lines.length; li++) {
        const lineItems = para.lines[li].items;

        for (let ii = 0; ii < lineItems.length; ii++) {
          const item = lineItems[ii];
          const sameStyle =
            rcur !== null &&
            rcur.bold === item.bold &&
            rcur.italic === item.italic &&
            rcur.color === item.color &&
            Math.abs(rcur.fontSize - item.fontSize) < 1;

          if (!sameStyle) {
            flushRun();
            rcur = item;
            rbuf = item.str;
          } else {
            rbuf += item.str;
          }

          // Insert space if there is a visible gap to the next item
          if (ii < lineItems.length - 1) {
            const nxt = lineItems[ii + 1];
            const approxRight = item.x + item.str.length * item.fontSize * 0.5;
            if (
              !rbuf.endsWith(" ") &&
              !nxt.str.startsWith(" ") &&
              nxt.x > approxRight + item.fontSize * 0.1
            ) {
              rbuf += " ";
            }
          }
        }

        // Soft newline between lines in the same paragraph
        if (li < para.lines.length - 1 && rbuf && !rbuf.endsWith(" ")) {
          rbuf += " ";
        }
      }
      flushRun();

      if (!runs.length) continue;

      docChildren.push(
        new Paragraph({
          children: runs,
          spacing: {
            // before/after in twentieths of a point
            before: isHeading ? 240 : 0,
            after: isHeading ? 100 : 80,
            // line in twentieths of a point: 240 = single, 276 = 1.15×
            line: 276,
          },
        })
      );
    }
  }

  const doc = new Document({ sections: [{ children: docChildren }] });
  return Packer.toBuffer(doc);
}

// ─── Route ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const buf = await file.arrayBuffer();

    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const workerPath = path.join(
      process.cwd(),
      "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"
    );
    pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;

    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const OPS = pdfjsLib.OPS;

    const pages: { items: RichItem[]; images: DocImg[]; pageW: number }[] = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const { items, images } = await extractPage(page, OPS, viewport.height, viewport.width);
      pages.push({ items, images, pageW: viewport.width });
    }

    const docxBuf = await buildDocx(pages);
    const baseName = file.name.replace(/\.pdf$/i, "");

    return new NextResponse(docxBuf, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
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
