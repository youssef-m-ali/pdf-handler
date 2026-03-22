"use client";

import { useState, useCallback } from "react";
import { PDFDocument } from "pdf-lib";
import Link from "next/link";
import { useDropzone } from "react-dropzone";
import {
  ArrowLeft,
  UploadCloud,
  FileText,
  Download,
  Loader2,
  Minimize2,
  CheckCircle2,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type CompressionLevel = "light" | "balanced" | "maximum";

interface CompressResult {
  bytes: Uint8Array;
  originalSize: number;
  compressedSize: number;
}

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

async function compressRasterize(file: File): Promise<Uint8Array> {
  const pdfjsLib = await import("pdfjs-dist");
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
  }

  const buf = await file.arrayBuffer();
  const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const out = await PDFDocument.create();

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const viewport = page.getViewport({ scale: 1 }); // 72 DPI

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);

    await page.render({ canvasContext: canvas.getContext("2d")! as CanvasRenderingContext2D, viewport }).promise;

    const dataUrl = canvas.toDataURL("image/jpeg", 0.35);
    const imageBytes = Uint8Array.from(atob(dataUrl.split(",")[1]), (c) => c.charCodeAt(0));
    const jpegImage = await out.embedJpg(imageBytes);

    const pdfPage = out.addPage([viewport.width, viewport.height]);
    pdfPage.drawImage(jpegImage, { x: 0, y: 0, width: viewport.width, height: viewport.height });
  }

  return out.save({ useObjectStreams: true });
}

// Each call gets a fresh Ghostscript instance; the WASM binary is cached by
// the browser after the first download (~18 MB).
async function compressWithGhostscript(
  file: File,
  pdfsettings: string
): Promise<Uint8Array> {
  const { default: Module } = await import("@jspawn/ghostscript-wasm");
  const gs = await Module({
    locateFile: (path: string) =>
      `https://cdn.jsdelivr.net/npm/@jspawn/ghostscript-wasm@0.0.2/${path}`,
  });

  const buf = await file.arrayBuffer();
  gs.FS.writeFile("/input.pdf", new Uint8Array(buf));

  gs.callMain([
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    `-dPDFSETTINGS=${pdfsettings}`,
    "-dNOPAUSE",
    "-dQUIET",
    "-dBATCH",
    "-sOutputFile=/output.pdf",
    "/input.pdf",
  ]);

  const result: Uint8Array = gs.FS.readFile("/output.pdf");
  return result;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const LEVELS: {
  id: CompressionLevel;
  label: string;
  desc: string;
  pdfsettings?: string;
  warning?: string;
}[] = [
  {
    id: "light",
    label: "Light",
    desc: "Printer quality (300 DPI images). Optimizes structure while preserving full quality.",
    pdfsettings: "/printer",
  },
  {
    id: "balanced",
    label: "Balanced",
    desc: "eBook quality (150 DPI images). Good compression with readable output. Text stays searchable.",
    pdfsettings: "/ebook",
  },
  {
    id: "maximum",
    label: "Maximum",
    desc: "Rasterizes pages at 72 DPI. Smallest file size.",
    warning: "Text becomes non-searchable.",
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function CompressClient() {
  const [file, setFile] = useState<File | null>(null);
  const [level, setLevel] = useState<CompressionLevel>("balanced");
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<CompressResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFile(null);
    setResult(null);
    setError(null);
  };

  const onDrop = useCallback((accepted: File[]) => {
    if (accepted[0]) {
      setFile(accepted[0]);
      setResult(null);
      setError(null);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: false,
  });

  const handleCompress = async () => {
    if (!file) return;
    setIsProcessing(true);
    setError(null);
    setResult(null);

    try {
      const bytes = level === "maximum"
        ? await compressRasterize(file)
        : await compressWithGhostscript(file, LEVELS.find((l) => l.id === level)!.pdfsettings!);
      setResult({ bytes, originalSize: file.size, compressedSize: bytes.byteLength });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Compression failed.");
    } finally {
      setIsProcessing(false);
    }
  };

  const selectedLevel = LEVELS.find((l) => l.id === level)!;

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
          <span className="font-medium text-gray-900">Compress PDF</span>
        </div>
      </header>

      <main className="flex-1 max-w-xl mx-auto w-full px-6 py-12 flex flex-col gap-6">

        {/* Title */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center"
              style={{ background: "#EDF0E6" }}
            >
              <Minimize2 className="w-4 h-4" style={{ color: "#5C6B3A" }} />
            </div>
            <h1 className="text-xl font-semibold text-gray-900">Compress PDF</h1>
          </div>
          <p className="text-sm pl-[42px]" style={{ color: "#6B7355" }}>
            Reduce file size — powered by Ghostscript, runs locally in your browser.
          </p>
          <p className="text-xs pl-[42px]" style={{ color: "#A8BA80" }}>
            First run downloads the compression engine (~18 MB). Subsequent runs are instant.
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
            <UploadCloud
              className="w-8 h-8"
              style={{ color: isDragActive ? "#5C6B3A" : "#A8BA80" }}
            />
            <div>
              <p className="text-sm font-medium text-gray-800">
                {isDragActive ? "Drop it here" : "Drop a PDF here"}
              </p>
              <p className="text-xs mt-1" style={{ color: "#A8BA80" }}>
                or click to browse
              </p>
            </div>
          </div>
        ) : (
          <div
            className="flex items-center justify-between px-4 py-3 rounded-2xl border border-gray-100"
            style={{ background: "#FAFAF8" }}
          >
            <div className="flex items-center gap-3">
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center"
                style={{ background: "#EDF0E6" }}
              >
                <FileText className="w-4 h-4" style={{ color: "#5C6B3A" }} />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900 truncate max-w-[200px]">
                  {file.name}
                </p>
                <p className="text-xs" style={{ color: "#6B7355" }}>
                  {formatBytes(file.size)}
                </p>
              </div>
            </div>
            <button
              onClick={reset}
              className="text-xs transition-colors hover:text-gray-600"
              style={{ color: "#A8BA80" }}
            >
              Change
            </button>
          </div>
        )}

        {/* Level selector */}
        {file && !result && (
          <div className="flex flex-col gap-3">
            <p
              className="text-xs font-semibold uppercase tracking-wide"
              style={{ color: "#A8BA80" }}
            >
              Compression level
            </p>
            <div className="flex gap-2">
              {LEVELS.map((l) => (
                <button
                  key={l.id}
                  onClick={() => setLevel(l.id)}
                  className={`flex-1 py-2.5 px-3 rounded-xl text-sm font-medium border transition-all ${
                    level === l.id
                      ? "border-[#5C6B3A] text-white"
                      : "border-gray-200 text-gray-600 hover:border-[#C8D4A8]"
                  }`}
                  style={
                    level === l.id
                      ? { background: "#5C6B3A" }
                      : { background: "#FAFAF8" }
                  }
                >
                  {l.label}
                </button>
              ))}
            </div>
            <div
              className="px-3 py-2.5 rounded-xl text-xs leading-relaxed"
              style={{ background: "#F5F6F0", color: "#6B7355" }}
            >
              {selectedLevel.desc}
              {selectedLevel.warning && (
                <span className="ml-1 font-medium" style={{ color: "#7A8F4E" }}>
                  {selectedLevel.warning}
                </span>
              )}
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
          <div
            className="flex flex-col gap-4 p-5 rounded-2xl border border-[#C8D4A8]"
            style={{ background: "#F5F6F0" }}
          >
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5" style={{ color: "#5C6B3A" }} />
              <p className="font-semibold text-gray-900 text-sm">Compressed successfully</p>
            </div>

            <div className="grid grid-cols-3 text-center gap-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs" style={{ color: "#A8BA80" }}>
                  Original
                </span>
                <span className="text-sm font-semibold text-gray-800">
                  {formatBytes(result.originalSize)}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs" style={{ color: "#A8BA80" }}>
                  Compressed
                </span>
                <span className="text-sm font-semibold" style={{ color: "#5C6B3A" }}>
                  {formatBytes(result.compressedSize)}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs" style={{ color: "#A8BA80" }}>
                  Reduction
                </span>
                <span className="text-sm font-semibold text-gray-800">
                  {result.compressedSize < result.originalSize
                    ? `-${Math.round(
                        (1 - result.compressedSize / result.originalSize) * 100
                      )}%`
                    : "—"}
                </span>
              </div>
            </div>

            <button
              onClick={() => {
                const baseName = file!.name.replace(/\.pdf$/i, "");
                triggerDownload(result.bytes, `${baseName}_compressed.pdf`);
              }}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-white text-sm"
              style={{ background: "#5C6B3A" }}
            >
              <Download className="w-4 h-4" />
              Download compressed PDF
            </button>

            <button
              onClick={() => setResult(null)}
              className="text-xs text-center transition-colors hover:text-gray-700"
              style={{ color: "#A8BA80" }}
            >
              Try different settings
            </button>
          </div>
        )}

        {/* Action button */}
        {file && !result && (
          <button
            onClick={handleCompress}
            disabled={isProcessing}
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-semibold text-white disabled:opacity-60 transition-opacity text-sm"
            style={{ background: "#5C6B3A" }}
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Compressing…
              </>
            ) : (
              <>
                <Minimize2 className="w-4 h-4" />
                Compress PDF
              </>
            )}
          </button>
        )}

      </main>
    </div>
  );
}
