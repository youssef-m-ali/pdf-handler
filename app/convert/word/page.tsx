import { Metadata } from "next";
import WordClient from "./WordClient";

export const metadata: Metadata = {
  title: "PDF to Word — SWFT PDF",
  description:
    "Convert a PDF to a Word document (.docx). Text is extracted per page. Processed securely on the server.",
};

export default function PdfToWordPage() {
  return <WordClient />;
}
