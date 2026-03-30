import { Metadata } from "next";
import ExtractClient from "./ExtractClient";

export const metadata: Metadata = {
  title: "PDF to Word — Jolt PDF",
  description:
    "Convert a PDF to an editable Word document (.docx). Runs entirely in your browser.",
};

export default function ExtractPage() {
  return <ExtractClient />;
}
