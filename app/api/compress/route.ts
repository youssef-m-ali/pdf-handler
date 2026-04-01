import { NextRequest, NextResponse } from "next/server";
import path from "path";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const level = (form.get("level") as string) ?? "balanced";

    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const buf = Buffer.from(await file.arrayBuffer());
    const originalSize = buf.byteLength;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: Module } = await import("@jspawn/ghostscript-wasm");
    const wasmPath = path.join(process.cwd(), "node_modules/@jspawn/ghostscript-wasm/gs.wasm");
    const wasmBuffer = await import("fs").then(fs => fs.promises.readFile(wasmPath));
    const gs = await Module({
      instantiateWasm(
        imports: WebAssembly.Imports,
        successCallback: (instance: WebAssembly.Instance) => void
      ) {
        WebAssembly.instantiate(wasmBuffer, imports).then(r => successCallback(r.instance));
        return {};
      },
    });

    gs.FS.writeFile("/input.pdf", new Uint8Array(buf));

    const pdfsettings =
      level === "light" ? "/printer" : level === "balanced" ? "/ebook" : "/screen";

    // Common args shared across all levels
    const commonArgs = [
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
      // Force GS to re-encode images instead of passing through DCT streams untouched
      "-dAutoFilterColorImages=false",
      "-dColorImageFilter=/DCTEncode",
      "-dAutoFilterGrayImages=false",
      "-dGrayImageFilter=/DCTEncode",
      "-dDownsampleColorImages=true",
      "-dColorImageDownsampleType=/Bicubic",
      "-dDownsampleGrayImages=true",
      "-dGrayImageDownsampleType=/Bicubic",
      "-dDownsampleMonoImages=true",
      "-dMonoImageDownsampleType=/Subsample",
    ];

    // Light: printer quality (300 DPI), strip fonts — biggest gap vs ILP was fonts + image passthrough
    const lightArgs = [
      "-dColorImageResolution=300",
      "-dGrayImageResolution=300",
      "-dMonoImageResolution=600",
      "-dEmbedAllFonts=false",
    ];

    const extraArgs = level === "light" ? lightArgs : [];

    gs.callMain([
      ...commonArgs,
      ...extraArgs,
      "-sOutputFile=/output.pdf",
      "/input.pdf",
    ]);

    const output: Uint8Array = gs.FS.readFile("/output.pdf");

    return new NextResponse(output, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(file.name)}"`,
        "X-Original-Size": String(originalSize),
        "X-Compressed-Size": String(output.byteLength),
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Compression failed" },
      { status: 500 }
    );
  }
}
