import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SWFT PDF — Free PDF tools, right in your browser",
  description:
    "Merge, split, reorder, compress, and convert PDFs for free. Everything runs in your browser — your files never leave your device.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-white text-gray-900">{children}</body>
    </html>
  );
}
