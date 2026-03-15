import { Metadata } from "next";
import MergeClient from "./MergeClient";

export const metadata: Metadata = {
  title: "Merge PDF — PDF Araby",
  description:
    "Combine multiple PDF files into one. Free, private, and runs entirely in your browser.",
};

export default function MergePage() {
  return <MergeClient />;
}
