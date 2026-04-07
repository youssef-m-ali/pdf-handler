import { NextRequest, NextResponse } from "next/server";
import { convertPdfToDocx } from "@/lib/convert";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const buf      = Buffer.from(await file.arrayBuffer());
    const docxBuf  = await convertPdfToDocx(buf);
    const baseName = file.name.replace(/\.pdf$/i, "");

    return new NextResponse(new Uint8Array(docxBuf), {
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
