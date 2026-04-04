import { Metadata } from "next";
import ProtectClient from "./ProtectClient";

export const metadata: Metadata = {
  title: "Protect PDF — SWFT PDF",
  description:
    "Password-protect a PDF with custom permissions. Runs entirely in your browser.",
};

export default function ProtectPage() {
  return <ProtectClient />;
}
