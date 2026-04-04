import { Metadata } from "next";
import ExtractImagesClient from "./ExtractImagesClient";

export const metadata: Metadata = {
  title: "Extract Images — SWFT PDF",
  description:
    "Pull all embedded images out of a PDF and download them as a ZIP. Runs entirely in your browser.",
};

export default function ExtractImagesPage() {
  return <ExtractImagesClient />;
}
