import { Metadata } from "next";
import SplitClient from "./SplitClient";

export const metadata: Metadata = {
  title: "Split PDF — SWFT PDF",
  description:
    "Extract specific pages or split a PDF into two parts. Free, private, runs entirely in your browser.",
};

export default function SplitPage() {
  return <SplitClient />;
}
