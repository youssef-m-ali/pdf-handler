import path from "path";
import { readFile } from "fs/promises";
import { inflate, deflate } from "zlib";
import { promisify } from "util";
import { PDFDocument, PDFName, PDFRawStream, PDFNumber, PDFArray } from "pdf-lib";
import sharp from "sharp";

const inflateAsync = promisify(inflate);
const deflateAsync = promisify(deflate);

// pdf-lib doesn't expose its internal context type, so we declare what we use.
type PdfLibCtx = {
  enumerateIndirectObjects: () => [unknown, unknown][];
  assign: (ref: unknown, obj: PDFRawStream) => void;
  lookup: (ref: unknown) => unknown;
};

// ─── Float precision reduction ───────────────────────────────────────────────
// PDF content streams often store coordinates/colors with 10+ decimal places.
// Reducing by one decimal place shrinks uncompressed content by ~11% on
// text-heavy PDFs, which meaningfully improves deflate compression ratio.
// String literals (...) are skipped to avoid altering displayed text.
function reducePrecision(text: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    // Skip PDF string literals — content between balanced ( ) parens
    if (text[i] === "(") {
      let depth = 1, j = i + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "\\") { j += 2; continue; } // escaped char
        if (text[j] === "(") depth++;
        else if (text[j] === ")") depth--;
        j++;
      }
      out.push(text.slice(i, j));
      i = j;
      continue;
    }
    // Match a float literal (e.g. 0.96501, -0.00004076958)
    const m = text.slice(i).match(/^(-?\d*\.\d+)/);
    if (m) {
      const s = m[1];
      const decimals = s.length - s.indexOf(".") - 1;
      if (decimals > 2) {
        let formatted = parseFloat(s).toFixed(decimals - 1);
        // Strip trailing zeros, always keep at least one decimal digit
        formatted = formatted.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ".0");
        out.push(formatted);
      } else {
        out.push(s);
      }
      i += s.length;
      continue;
    }
    out.push(text[i]);
    i++;
  }
  return out.join("");
}

// ─── Light / Balanced: in-place image recompression ──────────────────────────
// Recompresses images to JPEG using sharp/mozjpeg, optionally downsampling
// to maxDim pixels on the longest side. Also reduces float precision in content
// streams and re-deflates everything at level 9.
async function recompressImages(
  pdfBytes: Uint8Array,
  quality: number,
  maxDim: number   // Infinity for light (no downsampling), 1600 for balanced
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const ctx = (pdfDoc as unknown as { context: PdfLibCtx }).context;

  // Index all raw streams by ref string for fast lookup throughout the passes
  const allStreams = new Map<string, [unknown, PDFRawStream]>();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) allStreams.set(String(ref), [ref, obj]);
  }

  // ── Pass 1: recompress images ─────────────────────────────────────────────
  // Collect SMask (soft-mask / alpha channel) refs upfront so we can skip them
  // in the main image loop — they're handled separately after their parent.
  const smaskRefs = new Set<string>();
  for (const [, obj] of allStreams.values()) {
    const smask = obj.dict.get(PDFName.of("SMask"));
    if (smask) smaskRefs.add(String(smask));
  }

  // Track which SMasks need resizing to match their downsampled parent image
  const smaskResizeTargets = new Map<string, { newW: number; newH: number }>();

  for (const [refStr, [ref, obj]] of allStreams) {
    if (smaskRefs.has(refStr)) continue; // SMasks handled in pass below

    const dict = obj.dict;
    if (dict.get(PDFName.of("Subtype"))?.toString() !== "/Image") continue;
    if (dict.get(PDFName.of("ImageMask"))?.toString() === "true") continue; // 1-bit mask

    const widthObj  = dict.get(PDFName.of("Width"));
    const heightObj = dict.get(PDFName.of("Height"));
    if (!(widthObj instanceof PDFNumber) || !(heightObj instanceof PDFNumber)) continue;

    const width     = widthObj.asNumber();
    const height    = heightObj.asNumber();
    const bpcObj    = dict.get(PDFName.of("BitsPerComponent"));
    const bpc       = bpcObj instanceof PDFNumber ? bpcObj.asNumber() : 8;
    const filterVal = dict.get(PDFName.of("Filter"))?.toString() ?? "";
    const csVal     = dict.get(PDFName.of("ColorSpace"))?.toString() ?? "";

    // Only handle 8-bit RGB/Gray images in FlateDecode or DCTDecode
    if (bpc !== 8 || csVal.includes("Indexed") || csVal.includes("CMYK")) continue;
    if (filterVal !== "/FlateDecode" && filterVal !== "/DCTDecode") continue;

    const isGray: boolean = csVal.includes("Gray");
    const channels: 1 | 3 = isGray ? 1 : 3;

    try {
      // Decode the image into a raw pixel buffer for sharp
      let pipeline: sharp.Sharp;
      if (filterVal === "/FlateDecode") {
        const decoded = await inflateAsync(Buffer.from(obj.contents));
        pipeline = sharp(decoded, { raw: { width, height, channels } });
      } else {
        pipeline = sharp(Buffer.from(obj.contents)); // already JPEG
      }

      // Downsample if the longest side exceeds maxDim (balanced mode only)
      let newW = width, newH = height, resized = false;
      if (isFinite(maxDim) && Math.max(width, height) > maxDim) {
        const scale = maxDim / Math.max(width, height);
        newW = Math.round(width * scale);
        newH = Math.round(height * scale);
        pipeline = pipeline.resize(newW, newH, { fit: "inside", withoutEnlargement: true });
        resized = true;
      }

      // Re-encode to JPEG with mozjpeg
      const { data: imgBuffer, info } = isGray
        ? await pipeline.grayscale().jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true })
        : await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });

      // Use actual output dimensions — sharp may round differently than our calc
      newW = info.width;
      newH = info.height;

      // Never inflate: skip if the re-encoded result is larger than the original
      if (!resized && imgBuffer.length >= obj.contents.byteLength) continue;

      dict.set(PDFName.of("Filter"),           PDFName.of("DCTDecode"));
      dict.set(PDFName.of("ColorSpace"),       PDFName.of(isGray ? "DeviceGray" : "DeviceRGB"));
      dict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
      dict.set(PDFName.of("Width"),            PDFNumber.of(newW));
      dict.set(PDFName.of("Height"),           PDFNumber.of(newH));
      dict.set(PDFName.of("Length"),           PDFNumber.of(imgBuffer.length));
      dict.delete(PDFName.of("DecodeParms"));

      if (resized) {
        // Queue the SMask for resizing to match the new image dimensions
        const smask = dict.get(PDFName.of("SMask"));
        if (smask) smaskResizeTargets.set(String(smask), { newW, newH });
      }

      ctx.assign(ref, PDFRawStream.of(dict, new Uint8Array(imgBuffer)));
    } catch {
      // Leave image unchanged if recompression fails
    }
  }

  // ── Pass 2: resize SMasks to match their downsampled parent ──────────────
  // SMasks (alpha channels) must stay lossless — JPEG artifacts on alpha cause
  // "Insufficient data for an image" errors in Acrobat.
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
      const decoded = smaskFilter === "/FlateDecode"
        ? await inflateAsync(Buffer.from(smaskObj.contents))
        : Buffer.from(smaskObj.contents);
      const pipeline = smaskFilter === "/FlateDecode"
        ? sharp(decoded, { raw: { width: w, height: h, channels: 1 } })
        : sharp(decoded).grayscale();

      const resizedBuf = await pipeline
        .resize(newW, newH, { fit: "inside", withoutEnlargement: true })
        .raw()
        .toBuffer();
      const deflated = await deflateAsync(resizedBuf);

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

  // ── Pass 3: re-deflate non-image streams + reduce float precision ─────────
  // Content/font streams are often stored with low-effort zlib. We inflate,
  // strip one decimal place from float literals, then re-deflate at level 9.
  for (const [, [ref, obj]] of allStreams) {
    const dict = obj.dict;
    if (dict.get(PDFName.of("Subtype"))?.toString() === "/Image") continue;
    if (dict.get(PDFName.of("Filter"))?.toString() !== "/FlateDecode") continue;

    try {
      const raw      = Buffer.from(obj.contents);
      const inflated = await inflateAsync(raw);
      const text     = inflated.toString("latin1");
      const reduced  = text.includes(".") ? Buffer.from(reducePrecision(text), "latin1") : inflated;
      const redeflated = await deflateAsync(reduced, { level: 9 });
      if (redeflated.length >= raw.length) continue; // keep original if no gain

      dict.set(PDFName.of("Length"), PDFNumber.of(redeflated.length));
      dict.delete(PDFName.of("DecodeParms"));
      ctx.assign(ref, PDFRawStream.of(dict, new Uint8Array(redeflated)));
    } catch {
      // Leave stream unchanged if re-deflation fails
    }
  }

  // ── Pass 4: merge per-page content streams ────────────────────────────────
  // Pages with multiple content streams are deflated in small independent
  // chunks. Concatenating into one stream before deflating gives a larger
  // context window and significantly better compression ratio.
  const emptyDeflated = await deflateAsync(Buffer.from("\n"), { level: 9 });

  for (const page of pdfDoc.getPages()) {
    const contentsRef = page.node.get(PDFName.of("Contents"));
    if (!contentsRef) continue;
    const contentsResolved = ctx.lookup(contentsRef);
    if (!(contentsResolved instanceof PDFArray)) continue; // already a single stream

    const refs = contentsResolved.asArray();
    if (refs.length <= 1) continue;

    // Inflate, precision-reduce, and concatenate all content streams for this page
    const parts: Buffer[] = [];
    let ok = true;
    for (const ref of refs) {
      const entry = allStreams.get(String(ref));
      if (!entry) { ok = false; break; }
      const [, obj] = entry;
      const filter = obj.dict.get(PDFName.of("Filter"))?.toString();
      try {
        const inflated = filter === "/FlateDecode"
          ? await inflateAsync(Buffer.from(obj.contents))
          : !filter ? Buffer.from(obj.contents)
          : (() => { ok = false; throw new Error("unsupported filter"); })();
        const text = inflated.toString("latin1");
        parts.push(text.includes(".") ? Buffer.from(reducePrecision(text), "latin1") : inflated);
        parts.push(Buffer.from("\n")); // stream separator
      } catch {
        ok = false; break;
      }
    }
    if (!ok || parts.length === 0) continue;

    const redeflated = await deflateAsync(Buffer.concat(parts), { level: 9 });

    // Write merged content into the first stream's object
    const [firstRef, firstObj] = allStreams.get(String(refs[0]))!;
    firstObj.dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
    firstObj.dict.set(PDFName.of("Length"), PDFNumber.of(redeflated.length));
    firstObj.dict.delete(PDFName.of("DecodeParms"));
    ctx.assign(firstRef, PDFRawStream.of(firstObj.dict, new Uint8Array(redeflated)));

    // Replace the remaining stream slots with empty placeholders
    for (let i = 1; i < refs.length; i++) {
      const entry = allStreams.get(String(refs[i]));
      if (!entry) continue;
      const [ref, obj] = entry;
      obj.dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
      obj.dict.set(PDFName.of("Length"), PDFNumber.of(emptyDeflated.length));
      obj.dict.delete(PDFName.of("DecodeParms"));
      ctx.assign(ref, PDFRawStream.of(obj.dict, new Uint8Array(emptyDeflated)));
    }

    // Point Contents at the single merged stream instead of the array
    page.node.set(PDFName.of("Contents"), refs[0]);
  }

  return pdfDoc.save({ useObjectStreams: true });
}

// ─── Extreme: Ghostscript ─────────────────────────────────────────────────────
// Delegates to Ghostscript WASM with /screen settings — aggressive image
// downsampling, font subsetting, and full PDF optimisation.
async function compressWithGS(pdfBytes: Uint8Array): Promise<Uint8Array> {
  const { default: Module } = await import("@jspawn/ghostscript-wasm");
  const wasmPath   = path.join(process.cwd(), "node_modules/@jspawn/ghostscript-wasm/gs.wasm");
  const wasmBuffer = await readFile(wasmPath);

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

  gs.FS.writeFile("/input.pdf", pdfBytes);
  gs.callMain([
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    "-dPDFSETTINGS=/screen",
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

// ─── Public API ───────────────────────────────────────────────────────────────

/** Re-encode images to JPEG (Q85). No downsampling. */
export const compressLight    = (pdf: Uint8Array) => recompressImages(pdf, 85, Infinity);

/** Re-encode images to JPEG (Q70) and downsample to max 1600px. */
export const compressBalanced = (pdf: Uint8Array) => recompressImages(pdf, 70, 1600);

/** Ghostscript /screen: maximum compression, font subsetting, image downsampling. */
export const compressExtreme  = (pdf: Uint8Array) => compressWithGS(pdf);
