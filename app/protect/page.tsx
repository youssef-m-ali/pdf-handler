import { Metadata } from "next";
import ProtectClient from "./ProtectClient";

export const metadata: Metadata = {
  title: "Protect PDF — Jolt PDF",
  description:
    "Password-protect a PDF with custom permissions. Runs entirely in your browser.",
};

export default function ProtectPage() {
  return <ProtectClient />;
}
