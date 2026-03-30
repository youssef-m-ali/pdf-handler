import { NextRequest, NextResponse } from "next/server";

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
    const gs = await Module();

    gs.FS.writeFile("/input.pdf", new Uint8Array(buf));

    const pdfsettings =
      level === "light" ? "/printer" : level === "balanced" ? "/ebook" : "/screen";

    gs.callMain([
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.4",
      `-dPDFSETTINGS=${pdfsettings}`,
      "-dNOPAUSE",
      "-dQUIET",
      "-dBATCH",
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
