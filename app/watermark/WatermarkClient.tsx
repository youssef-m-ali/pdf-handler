"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useDropzone } from "react-dropzone";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import {
  ArrowLeft,
  UploadCloud,
  FileText,
  Download,
  Loader2,
  Stamp,
  CheckCircle2,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Rotation = 0 | 45 | -45 | 90;
type Size = "small" | "medium" | "large";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function triggerDownload(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(
    new Blob([bytes as unknown as BlobPart], { type: "application/pdf" })
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
}

const SIZE_MAP: Record<Size, number> = {
  small: 28,
  medium: 52,
  large: 80,
};

async function applyWatermark(
  file: File,
  text: string,
  size: Size,
  opacity: number,
  rotation: Rotation
): Promise<Uint8Array> {
  const buf = await file.arrayBuffer();
  const pdfDoc = await PDFDocument.load(buf);
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontSize = SIZE_MAP[size];

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    const textHeight = font.heightAtSize(fontSize);

    page.drawText(text, {
      x: width / 2 - textWidth / 2,
      y: height / 2 - textHeight / 2,
      size: fontSize,
      font,
      color: rgb(0.5, 0.5, 0.5),
      opacity: opacity / 100,
      rotate: degrees(rotation),
    });
  }

  return pdfDoc.save();
}

// ─── Config ───────────────────────────────────────────────────────────────────

const SIZE_OPTIONS: { id: Size; label: string }[] = [
  { id: "small",  label: "Small"  },
  { id: "medium", label: "Medium" },
  { id: "large",  label: "Large"  },
];

const ROTATION_OPTIONS: { value: Rotation; label: string }[] = [
  { value:   0, label: "Horizontal" },
  { value:  45, label: "Diagonal ↗" },
  { value: -45, label: "Diagonal ↘" },
  { value:  90, label: "Vertical"   },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function WatermarkClient() {
  const [file, setFile]             = useState<File | null>(null);
  const [text, setText]             = useState("");
  const [size, setSize]             = useState<Size>("medium");
  const [opacity, setOpacity]       = useState(30);
  const [rotation, setRotation]     = useState<Rotation>(45);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult]         = useState<Uint8Array | null>(null);
  const [error, setError]           = useState<string | null>(null);

  const reset = () => { setFile(null); setResult(null); setError(null); };

  const onDrop = useCallback((accepted: File[]) => {
    if (accepted[0]) { setFile(accepted[0]); setResult(null); setError(null); }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: false,
  });

  const handleApply = async () => {
    if (!file || !text.trim()) return;
    setIsProcessing(true);
    setError(null);
    setResult(null);
    try {
      const bytes = await applyWatermark(file, text.trim(), size, opacity, rotation);
      setResult(bytes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply watermark.");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="min-h-screen bg-white text-gray-900 flex flex-col">

      {/* Navbar */}
      <header className="border-b border-gray-100 sticky top-0 z-10 bg-white/90 backdrop-blur">
        <div className="max-w-4xl mx-auto px-6 h-14 flex items-center gap-3 text-sm">
          <Link
            href="/"
            className="flex items-center gap-1.5 transition-colors hover:text-gray-900"
            style={{ color: "#6B7355" }}
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Home
          </Link>
          <span style={{ color: "#C8D4A8" }}>/</span>
          <span className="font-medium text-gray-900">Watermark</span>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-6 py-12 flex flex-col gap-6">

        {/* Title */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: "#EDF0E6" }}>
              <Stamp className="w-4 h-4" style={{ color: "#5C6B3A" }} />
            </div>
            <h1 className="text-xl font-semibold text-gray-900">Watermark PDF</h1>
          </div>
          <p className="text-sm pl-[42px]" style={{ color: "#6B7355" }}>
            Stamp a text watermark on every page of your PDF.
          </p>
        </div>

        {/* Dropzone or file info */}
        {!file ? (
          <div
            {...getRootProps()}
            className="border-2 border-dashed rounded-2xl p-10 flex flex-col items-center gap-3 cursor-pointer transition-colors text-center"
            style={{
              borderColor: isDragActive ? "#5C6B3A" : "#C8D4A8",
              background: isDragActive ? "#F0F2EA" : "#FAFAF8",
            }}
          >
            <input {...getInputProps()} />
            <UploadCloud className="w-8 h-8" style={{ color: isDragActive ? "#5C6B3A" : "#A8BA80" }} />
            <div>
              <p className="text-sm font-medium text-gray-800">
                {isDragActive ? "Drop it here" : "Drop a PDF here"}
              </p>
              <p className="text-xs mt-1" style={{ color: "#A8BA80" }}>or click to browse</p>
            </div>
          </div>
        ) : (
          <div
            className="flex items-center justify-between px-4 py-3 rounded-2xl border border-gray-100"
            style={{ background: "#FAFAF8" }}
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "#EDF0E6" }}>
                <FileText className="w-4 h-4" style={{ color: "#5C6B3A" }} />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900 truncate max-w-[200px]">{file.name}</p>
                <p className="text-xs" style={{ color: "#6B7355" }}>{formatBytes(file.size)}</p>
              </div>
            </div>
            <button onClick={reset} className="text-xs transition-colors hover:text-gray-600" style={{ color: "#A8BA80" }}>
              Change
            </button>
          </div>
        )}

        {/* Settings */}
        {file && !result && (
          <div className="flex flex-col gap-5">

            {/* Text input */}
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "#A8BA80" }}>
                Watermark text
              </p>
              <input
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="e.g. CONFIDENTIAL"
                className="w-full px-3.5 py-2.5 text-sm rounded-xl border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-[#7A8F4E]/20 focus:border-[#A8BA80] transition-colors"
              />
            </div>

            {/* Size */}
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "#A8BA80" }}>Size</p>
              <div className="flex gap-2">
                {SIZE_OPTIONS.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSize(s.id)}
                    className={`flex-1 py-2.5 px-3 rounded-xl text-sm font-medium border transition-all ${
                      size === s.id
                        ? "border-[#5C6B3A] text-white"
                        : "border-gray-200 text-gray-600 hover:border-[#C8D4A8]"
                    }`}
                    style={size === s.id ? { background: "#5C6B3A" } : { background: "#FAFAF8" }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Rotation */}
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "#A8BA80" }}>Rotation</p>
              <div className="flex gap-2">
                {ROTATION_OPTIONS.map((r) => (
                  <button
                    key={r.value}
                    onClick={() => setRotation(r.value)}
                    className={`flex-1 py-2.5 px-3 rounded-xl text-sm font-medium border transition-all ${
                      rotation === r.value
                        ? "border-[#5C6B3A] text-white"
                        : "border-gray-200 text-gray-600 hover:border-[#C8D4A8]"
                    }`}
                    style={rotation === r.value ? { background: "#5C6B3A" } : { background: "#FAFAF8" }}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Opacity */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "#A8BA80" }}>Opacity</p>
                <p className="text-xs font-semibold tabular-nums" style={{ color: "#6B7355" }}>{opacity}%</p>
              </div>
              <input
                type="range"
                min={5}
                max={80}
                value={opacity}
                onChange={(e) => setOpacity(Number(e.target.value))}
                className="w-full accent-[#5C6B3A]"
              />
              <div className="flex justify-between text-[10px]" style={{ color: "#C8D4A8" }}>
                <span>Subtle</span>
                <span>Bold</span>
              </div>
            </div>

          </div>
        )}

        {/* Error */}
        {error && (
          <div className="px-4 py-3 rounded-xl bg-red-50 border border-red-100 text-sm text-red-600">
            {error}
          </div>
        )}

        {/* Result */}
        {result && (
          <div className="flex flex-col gap-4 p-5 rounded-2xl border border-[#C8D4A8]" style={{ background: "#F5F6F0" }}>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5" style={{ color: "#5C6B3A" }} />
              <p className="font-semibold text-gray-900 text-sm">Watermark applied</p>
            </div>
            <button
              onClick={() => {
                const base = file!.name.replace(/\.pdf$/i, "");
                triggerDownload(result, `${base}_watermarked.pdf`);
              }}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-white text-sm"
              style={{ background: "#5C6B3A" }}
            >
              <Download className="w-4 h-4" />
              Download watermarked PDF
            </button>
            <button
              onClick={() => setResult(null)}
              className="text-xs text-center transition-colors hover:text-gray-700"
              style={{ color: "#A8BA80" }}
            >
              Change settings
            </button>
          </div>
        )}

        {/* Action */}
        {file && !result && (
          <button
            onClick={handleApply}
            disabled={isProcessing || !text.trim()}
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-semibold text-white disabled:opacity-40 transition-opacity text-sm cursor-pointer disabled:cursor-not-allowed"
            style={{ background: "#5C6B3A" }}
          >
            {isProcessing ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Applying…</>
            ) : (
              <><Stamp className="w-4 h-4" /> Apply Watermark</>
            )}
          </button>
        )}

      </main>
    </div>
  );
}
