import { readFileSync, writeFileSync } from "fs";
import { createRequire } from "module";
import path from "path";
import { inflate, deflate } from "zlib";
import { promisify } from "util";
import { PDFDocument, PDFName, PDFRawStream, PDFNumber, PDFArray } from "pdf-lib";
import sharp from "sharp";

const inflateAsync = promisify(inflate);
const deflateAsync = promisify(deflate);

// ─── CLI ──────────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2).filter(a => !a.startsWith("--"));
const flags    = process.argv.slice(2).filter(a => a.startsWith("--"));
const inputArg = args[0];
const levelArg = flags.find(f => f.startsWith("--level="))?.split("=")[1] ?? null;

const VALID_LEVELS = ["light", "balanced", "extreme"];
if (!inputArg) {
  console.error("Usage: node scripts/run_compressions.mjs <path-to-pdf> [--level=light|balanced|extreme]");
  process.exit(1);
}
if (levelArg && !VALID_LEVELS.includes(levelArg)) {
  console.error(`Unknown level "${levelArg}". Choose from: ${VALID_LEVELS.join(", ")}`);
  process.exit(1);
}

const inputPath  = path.resolve(inputArg);
const baseName   = path.basename(inputPath, ".pdf");
const outputDir  = path.join(path.dirname(inputPath), "../files");
const outLight    = path.join(outputDir, `${baseName}_jolt_light.pdf`);
const outBalanced = path.join(outputDir, `${baseName}_jolt_balanced.pdf`);
const outExtreme  = path.join(outputDir, `${baseName}_jolt_extreme.pdf`);

// ─── Float precision reduction ───────────────────────────────────────────────
function reducePrecision(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] === "(") {
      let depth = 1, j = i + 1;
      while (j < n && depth > 0) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === "(") depth++;
        else if (text[j] === ")") depth--;
        j++;
      }
      out.push(text.slice(i, j));
      i = j;
      continue;
    }
    const m = text.slice(i).match(/^(-?\d*\.\d+)/);
    if (m) {
      const s = m[1];
      const decimals = s.length - s.indexOf(".") - 1;
      if (decimals > 2) {
        const val = parseFloat(s);
        let formatted = val.toFixed(decimals - 1);
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

// ─── recompressImages (light + balanced) ─────────────────────────────────────

async function recompressImages(pdfBytes, quality, maxDim) {
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const ctx = pdfDoc.context;

  const allStreams = new Map();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) allStreams.set(String(ref), [ref, obj]);
  }

  const smaskRefs = new Set();
  for (const [, obj] of allStreams.values()) {
    const smask = obj.dict.get(PDFName.of("SMask"));
    if (smask) smaskRefs.add(String(smask));
  }

  const smaskResizeTargets = new Map();

  for (const [refStr, [ref, obj]] of allStreams) {
    if (smaskRefs.has(refStr)) continue;

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
    const channels = isGray ? 1 : 3;

    try {
      let pipeline;
      if (filterVal === "/FlateDecode") {
        const decoded = await inflateAsync(Buffer.from(obj.contents));
        pipeline = sharp(decoded, { raw: { width, height, channels } });
      } else {
        pipeline = sharp(Buffer.from(obj.contents));
      }

      let newW = width, newH = height, resized = false;
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

      let imgBuffer, newColorSpace;
      if (isGray) {
        const { data, info } = await pipeline.grayscale().jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
        imgBuffer = data; newW = info.width; newH = info.height;
        newColorSpace = PDFName.of("DeviceGray");
      } else {
        const { data, info } = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
        imgBuffer = data; newW = info.width; newH = info.height;
        newColorSpace = PDFName.of("DeviceRGB");
      }

      // Never inflate: skip if re-encoded result is larger than the original stream
      if (!resized && imgBuffer.length >= obj.contents.byteLength) continue;

      dict.set(PDFName.of("Filter"),           PDFName.of("DCTDecode"));
      dict.set(PDFName.of("ColorSpace"),       newColorSpace);
      dict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
      dict.set(PDFName.of("Length"),           PDFNumber.of(imgBuffer.length));
      dict.delete(PDFName.of("DecodeParms"));
      // Always write actual sharp output dims — sharp may round differently
      // than our pre-calculation, causing Acrobat "Insufficient data" errors.
      dict.set(PDFName.of("Width"),  PDFNumber.of(newW));
      dict.set(PDFName.of("Height"), PDFNumber.of(newH));
      if (resized) {
        const smask = dict.get(PDFName.of("SMask"));
        if (smask) smaskResizeTargets.set(String(smask), { newW, newH });
      }

      ctx.assign(ref, PDFRawStream.of(dict, new Uint8Array(imgBuffer)));
    } catch {
      // Leave image unchanged
    }
  }

  for (const [refStr, { newW, newH }] of smaskResizeTargets) {
    const entry = allStreams.get(refStr);
    if (!entry) continue;
    const [ref, smaskObj] = entry;

    const dict = smaskObj.dict;
    const w = dict.get(PDFName.of("Width"))?.asNumber();
    const h = dict.get(PDFName.of("Height"))?.asNumber();
    if (!w || !h) continue;

    const smaskFilter = dict.get(PDFName.of("Filter"))?.toString();
    if (smaskFilter !== "/FlateDecode" && smaskFilter !== "/DCTDecode") continue;

    try {
      let pipeline;
      if (smaskFilter === "/FlateDecode") {
        const decoded = await inflateAsync(Buffer.from(smaskObj.contents));
        pipeline = sharp(decoded, { raw: { width: w, height: h, channels: 1 } });
      } else {
        pipeline = sharp(Buffer.from(smaskObj.contents)).grayscale();
      }

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
      // Leave SMask unchanged
    }
  }

  // ── Re-deflate non-image streams + reduce float precision ──────────────────
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
      if (redeflated.length >= raw.length) continue;
      dict.set(PDFName.of("Length"), PDFNumber.of(redeflated.length));
      dict.delete(PDFName.of("DecodeParms"));
      ctx.assign(ref, PDFRawStream.of(dict, new Uint8Array(redeflated)));
    } catch {
      // Leave stream unchanged
    }
  }

  // ── Merge per-page content streams ───────────────────────────────────────
  // Pages with N content streams compress worse than pages with 1 because
  // each stream is deflated independently with a small zlib context window.
  // Concatenating and re-deflating as a single stream gives much better ratio.
  const emptyDeflated = await deflateAsync(Buffer.from("\n"), { level: 9 });

  for (const page of pdfDoc.getPages()) {
    const contentsRaw = page.node.get(PDFName.of("Contents"));
    if (!contentsRaw) continue;
    const contentsResolved = ctx.lookup(contentsRaw);
    if (!(contentsResolved instanceof PDFArray)) continue;

    const refs = contentsResolved.asArray();
    if (refs.length <= 1) continue;

    const parts = [];
    let ok = true;
    for (const ref of refs) {
      const entry = allStreams.get(String(ref));
      if (!entry) { ok = false; break; }
      const [, obj] = entry;
      const filter = obj.dict.get(PDFName.of("Filter"))?.toString();
      try {
        let inflated;
        if (filter === "/FlateDecode") {
          inflated = await inflateAsync(Buffer.from(obj.contents));
        } else if (!filter) {
          inflated = Buffer.from(obj.contents);
        } else {
          ok = false; break;
        }
        const text = inflated.toString("latin1");
        parts.push(text.includes(".") ? Buffer.from(reducePrecision(text), "latin1") : inflated);
        parts.push(Buffer.from("\n"));
      } catch {
        ok = false; break;
      }
    }
    if (!ok || parts.length === 0) continue;

    const merged = Buffer.concat(parts);
    const redeflated = await deflateAsync(merged, { level: 9 });

    const [firstRef, firstObj] = allStreams.get(String(refs[0]));
    firstObj.dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
    firstObj.dict.set(PDFName.of("Length"), PDFNumber.of(redeflated.length));
    firstObj.dict.delete(PDFName.of("DecodeParms"));
    ctx.assign(firstRef, PDFRawStream.of(firstObj.dict, new Uint8Array(redeflated)));

    for (let i = 1; i < refs.length; i++) {
      const entry = allStreams.get(String(refs[i]));
      if (!entry) continue;
      const [ref, obj] = entry;
      obj.dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
      obj.dict.set(PDFName.of("Length"), PDFNumber.of(emptyDeflated.length));
      obj.dict.delete(PDFName.of("DecodeParms"));
      ctx.assign(ref, PDFRawStream.of(obj.dict, new Uint8Array(emptyDeflated)));
    }

    page.node.set(PDFName.of("Contents"), refs[0]);
  }

  return pdfDoc.save({ useObjectStreams: true });
}

// ─── compressWithGS (extreme) ────────────────────────────────────────────────

async function compressWithGS(buf) {
  const require   = createRequire(import.meta.url);
  const wasmPath  = path.join(process.cwd(), "node_modules/@jspawn/ghostscript-wasm/gs.wasm");
  const wasmBuffer = readFileSync(wasmPath);
  const { default: Module } = await import("@jspawn/ghostscript-wasm");

  const gs = await Module({
    instantiateWasm(imports, successCallback) {
      WebAssembly.instantiate(wasmBuffer, imports).then((r) => successCallback(r.instance));
      return {};
    },
  });

  gs.FS.writeFile("/input.pdf", new Uint8Array(buf));
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

// ─── Main ─────────────────────────────────────────────────────────────────────

function fmt(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function pct(output, input) {
  const p = ((output - input) / input * 100).toFixed(1);
  return (p > 0 ? "+" : "") + p + "%";
}

const input    = readFileSync(inputPath);
const inputSize = input.byteLength;
console.log(`\nInput:  ${inputPath}`);
console.log(`Size:   ${fmt(inputSize)}\n`);

const allLevels = [
  { name: "light",    out: outLight,    fn: () => recompressImages(new Uint8Array(input), 85, Infinity) },
  { name: "balanced", out: outBalanced, fn: () => recompressImages(new Uint8Array(input), 70, 1600) },
  { name: "extreme",  out: outExtreme,  fn: () => compressWithGS(input) },
];
const levels = levelArg ? allLevels.filter(l => l.name === levelArg) : allLevels;

for (const { name, out, fn } of levels) {
  process.stdout.write(`  [${name}]    compressing... `);
  const output = await fn();
  writeFileSync(out, Buffer.from(output));
  console.log(`${fmt(output.byteLength)} (${pct(output.byteLength, inputSize)})  →  ${path.basename(out)}`);
}

console.log();
