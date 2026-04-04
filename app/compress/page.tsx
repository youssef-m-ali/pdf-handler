import { Metadata } from "next";
import CompressClient from "./CompressClient";

export const metadata: Metadata = {
  title: "Compress PDF — SWFT PDF",
  description:
    "Reduce PDF file size without uploading anything. Choose from lossless or high-compression modes. Runs entirely in your browser.",
};

export default function CompressPage() {
  return <CompressClient />;
}
