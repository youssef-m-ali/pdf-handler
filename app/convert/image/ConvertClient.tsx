"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useDropzone } from "react-dropzone";
import JSZip from "jszip";
import {
  ArrowLeft,
  UploadCloud,
  FileText,
  Download,
  Loader2,
  Image as ImageIcon,
  Check,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Format = "png" | "jpeg";
type Resolution = 72 | 150 | 300;

interface PageImage {
  pageNum: number;
  dataUrl: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function triggerDownloadUrl(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
}

async function convertPdfToImages(
  file: File,
  format: Format,
  dpi: Resolution
): Promise<PageImage[]> {
  const pdfjsLib = await import("pdfjs-dist");
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
  }

  const buf = await file.arrayBuffer();
  const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const scale = dpi / 72;
  const results: PageImage[] = [];

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);

    await page.render({
      canvasContext: canvas.getContext("2d")! as CanvasRenderingContext2D,
      viewport,
    }).promise;

    const mimeType = format === "png" ? "image/png" : "image/jpeg";
    const dataUrl = canvas.toDataURL(mimeType, format === "jpeg" ? 0.92 : undefined);
    results.push({ pageNum: i, dataUrl });
  }

  return results;
}

async function downloadSelected(
  selected: PageImage[],
  baseName: string,
  format: Format
) {
  const ext = format === "png" ? "png" : "jpg";
  if (selected.length === 1) {
    const { pageNum, dataUrl } = selected[0];
    triggerDownloadUrl(dataUrl, `${baseName}_page_${String(pageNum).padStart(2, "0")}.${ext}`);
    return;
  }
  const zip = new JSZip();
  for (const { pageNum, dataUrl } of selected) {
    zip.file(
      `${baseName}_page_${String(pageNum).padStart(2, "0")}.${ext}`,
      dataUrl.split(",")[1],
      { base64: true }
    );
  }
  const blob = await zip.generateAsync({ type: "blob" });
  triggerDownloadUrl(URL.createObjectURL(blob), `${baseName}_images.zip`);
}

// ─── Range helpers ────────────────────────────────────────────────────────────

function parsePageRange(input: string, total: number): { pages: number[]; invalid: boolean } {
  if (!input.trim()) return { pages: [], invalid: false };
  const seen = new Set<number>();
  const result: number[] = [];
  let invalid = false;
  for (const part of input.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1]), b = parseInt(rangeMatch[2]);
      if (a < 1 || b < 1 || a > total || b > total) { invalid = true; continue; }
      const step = a <= b ? 1 : -1;
      for (let i = a; i !== b + step; i += step) {
        if (!seen.has(i)) { seen.add(i); result.push(i); }
      }
    } else if (/^\d+$/.test(trimmed)) {
      const n = parseInt(trimmed);
      if (n < 1 || n > total) { invalid = true; continue; }
      if (!seen.has(n)) { seen.add(n); result.push(n); }
    } else {
      invalid = true;
    }
  }
  return { pages: result, invalid };
}

function pagesToRangeString(selected: number[]): string {
  const sorted = [...new Set(selected)].sort((a, b) => a - b);
  if (!sorted.length) return "";
  const ranges: string[] = [];
  let start = sorted[0], end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) { end = sorted[i]; }
    else { ranges.push(start === end ? `${start}` : `${start}-${end}`); start = end = sorted[i]; }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(", ");
}

// ─── Config ───────────────────────────────────────────────────────────────────

const RESOLUTIONS: { value: Resolution; label: string; desc: string }[] = [
  { value: 72,  label: "Low",    desc: "72 DPI — small files, fast to generate." },
  { value: 150, label: "Medium", desc: "150 DPI — balanced quality and size." },
  { value: 300, label: "High",   desc: "300 DPI — best quality, ideal for print." },
];

// ─── Image card ───────────────────────────────────────────────────────────────

function ImageCard({
  page,
  selected,
  onToggle,
}: {
  page: PageImage;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      onClick={onToggle}
      className="relative group flex flex-col select-none cursor-pointer"
    >
      <div
        className={`relative aspect-[3/4] rounded-2xl border bg-white transition-all duration-150 ${
          selected
            ? "border-[#5C6B3A] ring-2 ring-[#5C6B3A]/20 [box-shadow:4px_6px_8px_rgba(92,107,58,0.2)]"
            : "[box-shadow:4px_6px_8px_rgba(0,0,0,0.10)] border-gray-200"
        }`}
      >
        {/* Thumbnail */}
        <div className="absolute inset-0 rounded-2xl overflow-hidden p-2 flex items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={page.dataUrl}
            alt={`Page ${page.pageNum}`}
            className="w-full h-full object-contain"
            draggable={false}
          />
        </div>

        {/* Selected overlay */}
        {selected && (
          <div className="absolute inset-0 rounded-2xl bg-[#5C6B3A]/10 flex items-start justify-end p-2">
            <div
              className="w-5 h-5 rounded-full flex items-center justify-center"
              style={{ background: "#5C6B3A" }}
            >
              <Check className="w-3 h-3 text-white" strokeWidth={3} />
            </div>
          </div>
        )}

        {/* Hover ring when not selected */}
        {!selected && (
          <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity bg-black/5 flex items-start justify-end p-2">
            <div className="w-5 h-5 rounded-full border-2 border-white/80 bg-white/30" />
          </div>
        )}

        {/* Page number badge */}
        <div
          className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-6 h-6 rounded-full flex items-center justify-center shadow-sm z-10"
          style={{ background: selected ? "#5C6B3A" : "#A8BA80" }}
        >
          <span className="text-[9px] font-bold text-white leading-none">{page.pageNum}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ConvertClient() {
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<Format>("png");
  const [dpi, setDpi] = useState<Resolution>(150);
  const [isConverting, setIsConverting] = useState(false);
  const [pages, setPages] = useState<PageImage[] | null>(null);
  const [selectedNums, setSelectedNums] = useState<Set<number>>(new Set());
  const [rangeStr, setRangeStr] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFile(null);
    setPages(null);
    setSelectedNums(new Set());
    setRangeStr("");
    setError(null);
  };

  const onDrop = useCallback((accepted: File[]) => {
    if (accepted[0]) {
      setFile(accepted[0]);
      setPages(null);
      setSelectedNums(new Set());
      setRangeStr("");
      setError(null);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: false,
  });

  const handleConvert = async () => {
    if (!file) return;
    setIsConverting(true);
    setError(null);
    try {
      const result = await convertPdfToImages(file, format, dpi);
      const allNums = result.map((p) => p.pageNum);
      setPages(result);
      setSelectedNums(new Set(allNums));
      setRangeStr(pagesToRangeString(allNums));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conversion failed.");
    } finally {
      setIsConverting(false);
    }
  };

  const togglePage = (n: number) => {
    setSelectedNums((prev) => {
      const next = new Set(prev);
      next.has(n) ? next.delete(n) : next.add(n);
      setRangeStr(pagesToRangeString([...next].sort((a, b) => a - b)));
      return next;
    });
  };

  const allSelected = pages !== null && selectedNums.size === pages.length;

  const toggleSelectAll = () => {
    if (!pages) return;
    if (allSelected) {
      setSelectedNums(new Set());
      setRangeStr("");
    } else {
      const allNums = pages.map((p) => p.pageNum);
      setSelectedNums(new Set(allNums));
      setRangeStr(pagesToRangeString(allNums));
    }
  };

  const handleRangeChange = (val: string) => {
    setRangeStr(val);
    if (!pages) return;
    const { pages: parsed } = parsePageRange(val, pages.length);
    setSelectedNums(new Set(parsed));
  };

  const rangeInvalid = rangeStr.trim() !== "" && pages !== null && parsePageRange(rangeStr, pages.length).invalid;

  const handleDownload = async () => {
    if (!pages) return;
    const selected = pages.filter((p) => selectedNums.has(p.pageNum));
    await downloadSelected(selected, baseName, format);
  };

  const baseName = file?.name.replace(/\.pdf$/i, "") ?? "document";
  const selectedRes = RESOLUTIONS.find((r) => r.value === dpi)!;

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
          <span className="font-medium text-gray-900">PDF to Image</span>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-6 py-12 flex flex-col gap-6">

        {/* Title */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center"
              style={{ background: "#EDF0E6" }}
            >
              <ImageIcon className="w-4 h-4" style={{ color: "#5C6B3A" }} />
            </div>
            <h1 className="text-xl font-semibold text-gray-900">PDF to Image</h1>
          </div>
          <p className="text-sm pl-[42px]" style={{ color: "#6B7355" }}>
            Convert each page to PNG or JPEG — runs locally in your browser.
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
                <p className="text-sm font-medium text-gray-900 truncate max-w-[220px]">
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

        {/* Settings */}
        {file && !pages && (
          <div className="flex flex-col gap-5">

            {/* Format */}
            <div className="flex flex-col gap-3">
              <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "#A8BA80" }}>
                Format
              </p>
              <div className="flex gap-2">
                {(["png", "jpeg"] as Format[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFormat(f)}
                    className={`flex-1 py-2.5 px-3 rounded-xl text-sm font-medium border transition-all ${
                      format === f
                        ? "border-[#5C6B3A] text-white"
                        : "border-gray-200 text-gray-600 hover:border-[#C8D4A8]"
                    }`}
                    style={format === f ? { background: "#5C6B3A" } : { background: "#FAFAF8" }}
                  >
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
              <p
                className="text-xs px-3 py-2.5 rounded-xl"
                style={{ background: "#F5F6F0", color: "#6B7355" }}
              >
                {format === "png"
                  ? "Lossless. Best for text-heavy PDFs and documents."
                  : "Smaller files. Best for photo-heavy PDFs."}
              </p>
            </div>

            {/* Resolution */}
            <div className="flex flex-col gap-3">
              <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "#A8BA80" }}>
                Resolution
              </p>
              <div className="flex gap-2">
                {RESOLUTIONS.map((r) => (
                  <button
                    key={r.value}
                    onClick={() => setDpi(r.value)}
                    className={`flex-1 py-2.5 px-3 rounded-xl text-sm font-medium border transition-all ${
                      dpi === r.value
                        ? "border-[#5C6B3A] text-white"
                        : "border-gray-200 text-gray-600 hover:border-[#C8D4A8]"
                    }`}
                    style={dpi === r.value ? { background: "#5C6B3A" } : { background: "#FAFAF8" }}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <p
                className="text-xs px-3 py-2.5 rounded-xl"
                style={{ background: "#F5F6F0", color: "#6B7355" }}
              >
                {selectedRes.desc}
              </p>
            </div>

          </div>
        )}

        {/* Error */}
        {error && (
          <div className="px-4 py-3 rounded-xl bg-red-50 border border-red-100 text-sm text-red-600">
            {error}
          </div>
        )}

        {/* Results */}
        {pages && (
          <>
            {/* Range input */}
            <p className="text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: "#A8BA80" }}>
              Pages to download{" "}
              <span className="normal-case tracking-normal" style={{ color: "#C8D4A8" }}>(e.g. 1-3, 5, 7-9)</span>
            </p>
            <input
              type="text"
              value={rangeStr}
              onChange={(e) => handleRangeChange(e.target.value)}
              placeholder="e.g. 1-5, 8, 11-13"
              className={`w-full px-3.5 py-2.5 text-sm rounded-xl border focus:outline-none focus:ring-2 transition-colors ${
                rangeInvalid
                  ? "border-red-300 bg-red-50 focus:ring-red-200"
                  : "border-gray-200 bg-white focus:ring-[#7A8F4E]/20 focus:border-[#A8BA80]"
              }`}
            />

            {/* Controls row */}
            <div className="flex items-center justify-between">
              <button
                onClick={() => { setPages(null); setSelectedNums(new Set()); }}
                className="flex items-center gap-1.5 text-xs transition-colors hover:text-gray-900"
                style={{ color: "#6B7355" }}
              >
                <ArrowLeft className="w-3 h-3" />
                Change conversion settings
              </button>

              <div className="flex items-center gap-3">
                <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#A8BA80" }}>
                  {selectedNums.size > 0
                    ? `${selectedNums.size} of ${pages.length} selected`
                    : "Click pages to select"}
                </p>
                <button
                  onClick={toggleSelectAll}
                  className="flex items-center gap-1.5 text-xs hover:text-gray-900 transition-colors"
                  style={{ color: "#A8BA80" }}
                >
                  <span
                    className="w-3.5 h-3.5 rounded flex items-center justify-center border transition-colors flex-shrink-0"
                    style={
                      allSelected
                        ? { background: "#5C6B3A", borderColor: "#5C6B3A" }
                        : { borderColor: "#A8BA80" }
                    }
                  >
                    {allSelected && (
                      <svg viewBox="0 0 10 8" className="w-2 h-2" fill="none">
                        <path d="M1 4l2.5 2.5L9 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  {allSelected ? "Deselect all" : "Select all"}
                </button>
              </div>
            </div>

            {/* Scrollable grid */}
            <div
              className="rounded-2xl p-4 max-h-[520px] overflow-y-auto"
              style={{ background: "#EAEDE3" }}
            >
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                {pages.map((page) => (
                  <ImageCard
                    key={page.pageNum}
                    page={page}
                    selected={selectedNums.has(page.pageNum)}
                    onToggle={() => togglePage(page.pageNum)}
                  />
                ))}
              </div>
            </div>

            {/* Download button */}
            <button
              onClick={handleDownload}
              disabled={selectedNums.size === 0}
              className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed transition-opacity text-sm"
              style={{ background: "#5C6B3A" }}
            >
              {selectedNums.size === 0 ? (
                "Select pages to download"
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  {selectedNums.size === 1
                    ? "Download image"
                    : `Download ${selectedNums.size} images (.zip)`}
                </>
              )}
            </button>
          </>
        )}

        {/* Convert button */}
        {file && !pages && (
          <button
            onClick={handleConvert}
            disabled={isConverting}
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-semibold text-white disabled:opacity-60 transition-opacity text-sm"
            style={{ background: "#5C6B3A" }}
          >
            {isConverting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Converting…
              </>
            ) : (
              "Next"
            )}
          </button>
        )}

      </main>
    </div>
  );
}
