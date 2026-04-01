import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { inflate } from "zlib";
import { promisify } from "util";
import { PDFDocument, PDFName, PDFRawStream, PDFNumber } from "pdf-lib";
import sharp from "sharp";

export const maxDuration = 60;

const inflateAsync = promisify(inflate);

// ─── Internal pdf-lib context types ──────────────────────────────────────────

type PdfLibCtx = {
  enumerateIndirectObjects: () => [unknown, unknown][];
  assign: (ref: unknown, obj: PDFRawStream) => void;
};

// ─── Light compression: recompress images in-place via sharp ──────────────────

async function recompressImages(pdfBytes: Uint8Array): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const ctx = (pdfDoc as unknown as { context: PdfLibCtx }).context;

  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;

    const dict = obj.dict;
    if (dict.get(PDFName.of("Subtype"))?.toString() !== "/Image") continue;
    if (dict.get(PDFName.of("ImageMask"))?.toString() === "true") continue;

    const widthObj  = dict.get(PDFName.of("Width"));
    const heightObj = dict.get(PDFName.of("Height"));
    const bpcObj    = dict.get(PDFName.of("BitsPerComponent"));

    if (!(widthObj instanceof PDFNumber) || !(heightObj instanceof PDFNumber)) continue;

    const width  = widthObj.asNumber();
    const height = heightObj.asNumber();
    const bpc    = bpcObj instanceof PDFNumber ? bpcObj.asNumber() : 8;
    const filterVal = dict.get(PDFName.of("Filter"))?.toString() ?? "";
    const csVal     = dict.get(PDFName.of("ColorSpace"))?.toString() ?? "";

    if (csVal.includes("Indexed") || csVal.includes("CMYK") || bpc !== 8) continue;

    const channels = csVal.includes("Gray") ? (1 as const) : (3 as const);

    try {
      let imgBuffer: Buffer;

      if (filterVal === "/FlateDecode") {
        const decoded = await inflateAsync(Buffer.from(obj.contents));
        imgBuffer = await sharp(decoded, { raw: { width, height, channels } })
          .jpeg({ quality: 85 })
          .toBuffer();
      } else if (filterVal === "/DCTDecode") {
        imgBuffer = await sharp(Buffer.from(obj.contents))
          .jpeg({ quality: 85 })
          .toBuffer();
      } else {
        continue;
      }

      dict.set(PDFName.of("Filter"),           PDFName.of("DCTDecode"));
      dict.set(PDFName.of("ColorSpace"),       PDFName.of("DeviceRGB"));
      dict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
      dict.set(PDFName.of("Length"),           PDFNumber.of(imgBuffer.length));
      dict.delete(PDFName.of("DecodeParms"));

      ctx.assign(ref, PDFRawStream.of(dict, new Uint8Array(imgBuffer)));
    } catch {
      // Leave image unchanged if recompression fails
    }
  }

  return pdfDoc.save({ useObjectStreams: true });
}

// ─── Balanced / Extreme: Ghostscript ─────────────────────────────────────────

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
        ? await recompressImages(new Uint8Array(buf))
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
