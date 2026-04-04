import { Metadata } from "next";
import ConvertClient from "./ConvertClient";

export const metadata: Metadata = {
  title: "PDF to Image — SWFT PDF",
  description:
    "Convert PDF pages to PNG or JPEG images. Choose resolution and format. Runs entirely in your browser.",
};

export default function PdfToImagePage() {
  return <ConvertClient />;
}
