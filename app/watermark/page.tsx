import { Metadata } from "next";
import WatermarkClient from "./WatermarkClient";

export const metadata: Metadata = {
  title: "Watermark PDF — Jolt PDF",
  description:
    "Add a text watermark to every page of your PDF. Runs entirely in your browser.",
};

export default function WatermarkPage() {
  return <WatermarkClient />;
}
