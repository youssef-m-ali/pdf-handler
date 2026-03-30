import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;

    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const buf = await file.arrayBuffer();

    // ── Extract text per page with pdfjs-dist ─────────────────────────────
    const pdfjsLib = await import("pdfjs-dist");
    // Disable the web worker — not available in Node.js
    pdfjsLib.GlobalWorkerOptions.workerSrc = "";

    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const pages: { pageNum: number; text: string }[] = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((item: any) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/ {2,}/g, " ")
        .trim();
      pages.push({ pageNum: i, text });
    }

    // ── Build DOCX ────────────────────────────────────────────────────────
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");
    const totalPages = pages.length;
    const children: InstanceType<typeof Paragraph>[] = [];

    for (const { pageNum, text } of pages) {
      if (totalPages > 1) {
        children.push(
          new Paragraph({ text: `Page ${pageNum}`, heading: HeadingLevel.HEADING_2 })
        );
      }
      children.push(
        text
          ? new Paragraph({ children: [new TextRun(text)] })
          : new Paragraph({
              children: [
                new TextRun({
                  text: "[No text on this page]",
                  italics: true,
                  color: "999999",
                }),
              ],
            })
      );
      if (pageNum < totalPages) {
        children.push(new Paragraph({ pageBreakBefore: true, text: "" }));
      }
    }

    const doc = new Document({ sections: [{ children }] });
    const docxBuffer = await Packer.toBuffer(doc);

    const baseName = file.name.replace(/\.pdf$/i, "");
    return new NextResponse(docxBuffer, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(`${baseName}.docx`)}"`,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Conversion failed" },
      { status: 500 }
    );
  }
}
