import { NextRequest, NextResponse } from "next/server";
import { compressLight, compressBalanced, compressExtreme } from "@/lib/compress";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const form  = await req.formData();
    const file  = form.get("file") as File | null;
    const level = (form.get("level") as string) ?? "balanced";

    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const pdfBytes    = new Uint8Array(await file.arrayBuffer());
    const originalSize = pdfBytes.byteLength;

    const output =
      level === "light"    ? await compressLight(pdfBytes)    :
      level === "balanced" ? await compressBalanced(pdfBytes) :
                             await compressExtreme(pdfBytes);

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
