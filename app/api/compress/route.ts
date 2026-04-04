import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { inflate, deflate } from "zlib";
import { promisify } from "util";
import { PDFDocument, PDFName, PDFRawStream, PDFNumber } from "pdf-lib";
import sharp from "sharp";

export const maxDuration = 60;

const inflateAsync = promisify(inflate);
const deflateAsync = promisify(deflate);

// ─── Internal pdf-lib context types ──────────────────────────────────────────

type PdfLibCtx = {
  enumerateIndirectObjects: () => [unknown, unknown][];
  assign: (ref: unknown, obj: PDFRawStream) => void;
};

// ─── Sharp-based in-place image recompression ────────────────────────────────

async function recompressImages(
  pdfBytes: Uint8Array,
  quality: number,
  maxDim: number
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const ctx = (pdfDoc as unknown as { context: PdfLibCtx }).context;

  // Build a lookup map: ref string → [ref, obj]
  const allStreams = new Map<string, [unknown, PDFRawStream]>();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) allStreams.set(String(ref), [ref, obj]);
  }

  // Pre-pass: collect SMask refs so we can skip them in main loop,
  // and track which SMasks need resizing when their parent gets downsampled.
  const smaskRefs = new Set<string>();
  for (const [, obj] of allStreams.values()) {
    const smask = obj.dict.get(PDFName.of("SMask"));
    if (smask) smaskRefs.add(String(smask));
  }

  // Main pass: recompress non-SMask images
  const smaskResizeTargets = new Map<string, { newW: number; newH: number }>();

  for (const [refStr, [ref, obj]] of allStreams) {
    if (smaskRefs.has(refStr)) continue; // handled separately below

    const dict = obj.dict;
    if (dict.get(PDFName.of("Subtype"))?.toString() !== "/Image") continue;
    if (dict.get(PDFName.of("ImageMask"))?.toString() === "true") continue;

    const widthObj  = dict.get(PDFName.of("Width"));
    const heightObj = dict.get(PDFName.of("Height"));
    const bpcObj    = dict.get(PDFName.of("BitsPerComponent"));

    if (!(widthObj instanceof PDFNumber) || !(heightObj instanceof PDFNumber)) continue;

    const width     = widthObj.asNumber();
    const height    = heightObj.asNumber();
    const bpc       = bpcObj instanceof PDFNumber ? bpcObj.asNumber() : 8;
    const filterVal = dict.get(PDFName.of("Filter"))?.toString() ?? "";
    const csVal     = dict.get(PDFName.of("ColorSpace"))?.toString() ?? "";

    if (csVal.includes("Indexed") || csVal.includes("CMYK") || bpc !== 8) continue;
    if (filterVal !== "/FlateDecode" && filterVal !== "/DCTDecode") continue;

    const isGray   = csVal.includes("Gray");
    const channels: 1 | 3 = isGray ? 1 : 3;

    try {
      let pipeline: sharp.Sharp;
      if (filterVal === "/FlateDecode") {
        const decoded = await inflateAsync(Buffer.from(obj.contents));
        pipeline = sharp(decoded, { raw: { width, height, channels } });
      } else {
        pipeline = sharp(Buffer.from(obj.contents));
      }

      let newW = width;
      let newH = height;
      let resized = false;

      if (isFinite(maxDim)) {
        const longest = Math.max(width, height);
        if (longest > maxDim) {
          const scale = maxDim / longest;
          newW = Math.round(width * scale);
          newH = Math.round(height * scale);
          pipeline = pipeline.resize(newW, newH, { fit: "inside", withoutEnlargement: true });
          resized = true;
        }
      }

      let imgBuffer: Buffer;
      let newColorSpace: PDFName;
      if (isGray) {
        imgBuffer = await pipeline.grayscale().jpeg({ quality, mozjpeg: true }).toBuffer();
        newColorSpace = PDFName.of("DeviceGray");
      } else {
        imgBuffer = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
        newColorSpace = PDFName.of("DeviceRGB");
      }

      dict.set(PDFName.of("Filter"),           PDFName.of("DCTDecode"));
      dict.set(PDFName.of("ColorSpace"),       newColorSpace);
      dict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
      dict.set(PDFName.of("Length"),           PDFNumber.of(imgBuffer.length));
      dict.delete(PDFName.of("DecodeParms"));
      if (resized) {
        dict.set(PDFName.of("Width"),  PDFNumber.of(newW));
        dict.set(PDFName.of("Height"), PDFNumber.of(newH));
        // Record that this image's SMask must be resized to match
        const smask = dict.get(PDFName.of("SMask"));
        if (smask) smaskResizeTargets.set(String(smask), { newW, newH });
      }

      ctx.assign(ref, PDFRawStream.of(dict, new Uint8Array(imgBuffer)));
    } catch {
      // Leave image unchanged if recompression fails
    }
  }

  // SMask pass: resize soft masks to match their parent's new dimensions.
  // Must stay lossless (FlateDecode) — JPEG artifacts on an alpha channel
  // cause "Insufficient data for an image" errors in Acrobat.
  for (const [refStr, { newW, newH }] of smaskResizeTargets) {
    const entry = allStreams.get(refStr);
    if (!entry) continue;
    const [ref, smaskObj] = entry;

    const dict = smaskObj.dict;
    const w = (dict.get(PDFName.of("Width"))  as PDFNumber)?.asNumber();
    const h = (dict.get(PDFName.of("Height")) as PDFNumber)?.asNumber();
    if (!w || !h) continue;

    const smaskFilter = dict.get(PDFName.of("Filter"))?.toString();
    if (smaskFilter !== "/FlateDecode" && smaskFilter !== "/DCTDecode") continue;

    try {
      // Decode the SMask (FlateDecode = raw pixels, DCTDecode = JPEG grayscale)
      let pipeline: sharp.Sharp;
      if (smaskFilter === "/FlateDecode") {
        const decoded = await inflateAsync(Buffer.from(smaskObj.contents));
        pipeline = sharp(decoded, { raw: { width: w, height: h, channels: 1 } });
      } else {
        pipeline = sharp(Buffer.from(smaskObj.contents)).grayscale();
      }

      // Resize and re-encode losslessly — JPEG artifacts on alpha cause rendering errors
      const resized  = await pipeline
        .resize(newW, newH, { fit: "inside", withoutEnlargement: true })
        .raw()
        .toBuffer();
      const deflated = await deflateAsync(resized);

      dict.set(PDFName.of("Filter"),  PDFName.of("FlateDecode"));
      dict.set(PDFName.of("Width"),   PDFNumber.of(newW));
      dict.set(PDFName.of("Height"),  PDFNumber.of(newH));
      dict.set(PDFName.of("Length"),  PDFNumber.of(deflated.length));
      dict.delete(PDFName.of("DecodeParms"));

      ctx.assign(ref, PDFRawStream.of(dict, new Uint8Array(deflated)));
    } catch {
      // Leave SMask unchanged if resize fails
    }
  }

  return pdfDoc.save({ useObjectStreams: true });
}

// ─── Extreme: Ghostscript ─────────────────────────────────────────────────────

async function compressWithGS(buf: Buffer, level: string): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { default: Module } = await import("@jspawn/ghostscript-wasm");
  const wasmPath   = path.join(process.cwd(), "node_modules/@jspawn/ghostscript-wasm/gs.wasm");
  const wasmBuffer = await import("fs").then((fs) => fs.promises.readFile(wasmPath));

  const gs = await (Module as (opts: unknown) => Promise<{
    FS: { writeFile: (p: string, d: Uint8Array) => void; readFile: (p: string) => Uint8Array };
    callMain: (args: string[]) => void;
  }>)({
    instantiateWasm(
      imports: WebAssembly.Imports,
      successCallback: (instance: WebAssembly.Instance) => void
    ) {
      WebAssembly.instantiate(wasmBuffer, imports).then((r) => successCallback(r.instance));
      return {};
    },
  });

  gs.FS.writeFile("/input.pdf", new Uint8Array(buf));

  const pdfsettings = level === "balanced" ? "/ebook" : "/screen";

  gs.callMain([
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    `-dPDFSETTINGS=${pdfsettings}`,
    "-dNOPAUSE",
    "-dQUIET",
    "-dBATCH",
    "-dOptimize=true",
    "-dDetectDuplicateImages=true",
    "-dSubsetFonts=true",
    "-dCompressFonts=true",
    "-sOutputFile=/output.pdf",
    "/input.pdf",
  ]);

  return gs.FS.readFile("/output.pdf");
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const form  = await req.formData();
    const file  = form.get("file")  as File | null;
    const level = (form.get("level") as string) ?? "balanced";

    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const buf          = Buffer.from(await file.arrayBuffer());
    const originalSize = buf.byteLength;

    const output =
      level === "light"
        ? await recompressImages(new Uint8Array(buf), 85, Infinity)
        : level === "balanced"
        ? await recompressImages(new Uint8Array(buf), 65, 1200)
        : await compressWithGS(buf, level);

    return new NextResponse(Buffer.from(output), {
      headers: {
        "Content-Type":        "application/pdf",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(file.name)}"`,
        "X-Original-Size":     String(originalSize),
        "X-Compressed-Size":   String(output.byteLength),
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Compression failed" },
      { status: 500 }
    );
  }
}
