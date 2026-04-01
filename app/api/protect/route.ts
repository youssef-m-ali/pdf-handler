import { NextRequest, NextResponse } from "next/server";
import path from "path";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const userPassword = (form.get("userPassword") as string) ?? "";
    const ownerPassword = (form.get("ownerPassword") as string) || userPassword;
    const allowPrinting = form.get("allowPrinting") === "true";
    const allowCopying = form.get("allowCopying") === "true";

    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
    if (!userPassword) return NextResponse.json({ error: "Password is required" }, { status: 400 });

    const buf = Buffer.from(await file.arrayBuffer());

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

    // PDF permission bits: 4 = print, 2048 = high-res print, 16 = copy
    let permissions = 0;
    if (allowPrinting) permissions |= 4 | 2048;
    if (allowCopying) permissions |= 16;

    gs.callMain([
      "-sDEVICE=pdfwrite",
      "-dNOPAUSE",
      "-dQUIET",
      "-dBATCH",
      `-sOwnerPassword=${ownerPassword}`,
      `-sUserPassword=${userPassword}`,
      "-dEncryptionR=3",
      "-dKeyLength=128",
      `-dPermissions=${permissions}`,
      "-sOutputFile=/output.pdf",
      "/input.pdf",
    ]);

    const output: Uint8Array = gs.FS.readFile("/output.pdf");
    const baseName = file.name.replace(/\.pdf$/i, "");

    return new NextResponse(output, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(`${baseName}_protected.pdf`)}"`,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Protection failed" },
      { status: 500 }
    );
  }
}
