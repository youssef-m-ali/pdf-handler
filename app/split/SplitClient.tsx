"use client";

import { useState, useCallback, Fragment } from "react";
import Link from "next/link";
import { useDropzone } from "react-dropzone";
import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";
import {
  ArrowLeft,
  UploadCloud,
  FileText,
  Download,
  Loader2,
  Check,
  Scissors,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Mode = "extract" | "split";

interface PageItem {
  pageNumber: number;   // 1-indexed
  thumbnail: string | null;
  thumbLoading: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function buildPdf(sourceFile: File, zeroIndexedPages: number[]): Promise<Uint8Array> {
  const buf = await sourceFile.arrayBuffer();
  const source = await PDFDocument.load(buf);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(source, zeroIndexedPages);
  copied.forEach((p) => out.addPage(p));
  return out.save();
}

function triggerDownload(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
}

// ─── Page card ────────────────────────────────────────────────────────────────

function PageCard({
  page,
  selected,
  selectable,
  onToggle,
}: {
  page: PageItem;
  selected: boolean;
  selectable: boolean;
  onToggle?: () => void;
}) {
  return (
    <div
      onClick={selectable ? onToggle : undefined}
      className={`relative group flex flex-col select-none ${selectable ? "cursor-pointer" : ""}`}
    >
      {/* Card */}
      <div
        className={`relative aspect-[3/4] rounded-2xl border bg-white transition-all duration-150 ${
          selected
            ? "border-[#5C6B3A] ring-2 ring-[#5C6B3A]/20 [box-shadow:4px_6px_8px_rgba(92,107,58,0.2)]"
            : "[box-shadow:4px_6px_8px_rgba(0,0,0,0.10)] border-gray-200"
        }`}
      >
        {/* Thumbnail */}
        {page.thumbLoading ? (
          <div className="absolute inset-0 rounded-2xl flex items-center justify-center">
            <Loader2 className="w-4 h-4 animate-spin" style={{ color: "#A8BA80" }} />
          </div>
        ) : page.thumbnail ? (
          <div className="absolute inset-0 rounded-2xl overflow-hidden p-3 flex items-center justify-center">
            <img
              src={page.thumbnail}
              alt={`Page ${page.pageNumber}`}
              className="w-full h-full object-contain"
              draggable={false}
            />
          </div>
        ) : (
          <div className="absolute inset-0 rounded-2xl flex items-center justify-center">
            <FileText className="w-6 h-6" style={{ color: "#C8D4A8" }} />
          </div>
        )}

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

        {/* Hover checkmark (extract mode, not yet selected) */}
        {selectable && !selected && (
          <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity bg-black/5 flex items-start justify-end p-2">
            <div className="w-5 h-5 rounded-full border-2 border-white/80 bg-white/30" />
          </div>
        )}

        {/* Page number badge — bottom center, half outside */}
        <div
          className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-6 h-6 rounded-full flex items-center justify-center shadow-sm z-10"
          style={{ background: selected ? "#5C6B3A" : "#A8BA80" }}
        >
          <span className="text-[9px] font-bold text-white leading-none">{page.pageNumber}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Split divider ────────────────────────────────────────────────────────────

function SplitDivider() {
  return (
    <div className="col-span-full flex items-center gap-3 py-3">
      <div className="flex-1 border-t-2 border-dashed" style={{ borderColor: "#A8BA80" }} />
      <div
        className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold"
        style={{ background: "#EDF0E6", color: "#5C6B3A" }}
      >
        <Scissors className="w-3 h-3" />
        Split here
      </div>
      <div className="flex-1 border-t-2 border-dashed" style={{ borderColor: "#A8BA80" }} />
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function SplitClient() {
  const [file, setFile] = useState<File | null>(null);
  const [pages, setPages] = useState<PageItem[]>([]);
  const [mode, setMode] = useState<Mode>("extract");
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [splitInto, setSplitInto] = useState(2);
  // String states so inputs allow empty/partial values while typing
  const [pagesStr, setPagesStr] = useState("8");
  const [partsStr, setPartsStr] = useState("2");
  const [isLoadingPages, setIsLoadingPages] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Load PDF & render thumbnails progressively ───────────────────────────
  async function loadPdf(f: File) {
    setFile(f);
    setPages([]);
    setSelectedPages(new Set());
    setError(null);
    setIsLoadingPages(true);

    try {
      const pdfjsLib = await import("pdfjs-dist");
      if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
      }

      const buf = await f.arrayBuffer();
      const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
      const numPages = pdfDoc.numPages;

      // Seed the pages array so the grid appears immediately
      setPages(
        Array.from({ length: numPages }, (_, i) => ({
          pageNumber: i + 1,
          thumbnail: null,
          thumbLoading: true,
        }))
      );
      setSplitInto(2);
      setPagesStr(Math.floor(numPages / 2).toString());
      setPartsStr("2");
      setIsLoadingPages(false);

      // Render thumbnails one by one
      for (let i = 1; i <= numPages; i++) {
        try {
          const page = await pdfDoc.getPage(i);
          const viewport = page.getViewport({ scale: 0.3 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await page.render({ canvasContext: ctx as any, viewport }).promise;
          const thumbnail = canvas.toDataURL("image/jpeg", 0.7);
          setPages((prev) =>
            prev.map((p) => (p.pageNumber === i ? { ...p, thumbnail, thumbLoading: false } : p))
          );
        } catch {
          setPages((prev) =>
            prev.map((p) => (p.pageNumber === i ? { ...p, thumbLoading: false } : p))
          );
        }
      }
    } catch (err) {
      console.error(err);
      setError("Could not load this PDF. Make sure it is a valid, unlocked PDF.");
      setIsLoadingPages(false);
    }
  }

  const onDrop = useCallback((accepted: File[]) => {
    if (accepted[0]) loadPdf(accepted[0]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: false,
  });

  // ── Page selection (extract mode) ─────────────────────────────────────────
  function togglePage(n: number) {
    setSelectedPages((prev) => {
      const next = new Set(prev);
      next.has(n) ? next.delete(n) : next.add(n);
      return next;
    });
  }

  function selectAll() {
    setSelectedPages(new Set(pages.map((p) => p.pageNumber)));
  }

  function deselectAll() {
    setSelectedPages(new Set());
  }

  // ── Extract ───────────────────────────────────────────────────────────────
  async function handleExtract() {
    if (!file || selectedPages.size === 0) return;
    setIsProcessing(true);
    setError(null);
    try {
      const sorted = [...selectedPages].sort((a, b) => a - b);
      const bytes = await buildPdf(file, sorted.map((n) => n - 1));
      triggerDownload(bytes, "extracted-pages.pdf");
    } catch (err) {
      console.error(err);
      setError("Something went wrong while extracting pages.");
    } finally {
      setIsProcessing(false);
    }
  }

  // ── Split every N pages → ZIP ─────────────────────────────────────────────
  async function handleSplitDownload() {
    if (!file) return;
    setIsProcessing(true);
    setError(null);
    try {
      const total = pages.length;
      const chunk = Math.floor(total / splitInto);
      const zip = new JSZip();

      for (let i = 0; i < splitInto; i++) {
        const start = i * chunk;
        if (start >= total) break;
        const end = i === splitInto - 1 ? total : start + chunk; // last part takes remainder
        const indices = Array.from({ length: end - start }, (_, j) => start + j);
        const bytes = await buildPdf(file, indices);
        const label = String(i + 1).padStart(2, "0");
        zip.file(`part-${label}.pdf`, bytes);
      }

      const zipBytes = await zip.generateAsync({ type: "uint8array" });
      triggerDownload(zipBytes, "split.zip");
    } catch (err) {
      console.error(err);
      setError("Something went wrong while splitting.");
    } finally {
      setIsProcessing(false);
    }
  }

  const hasFile = file !== null && pages.length > 0;

  // Derived split values — floor so last part absorbs remainder, never empty
  const chunkSize    = pages.length > 0 ? Math.floor(pages.length / splitInto) : 1;
  const lastPartSize = pages.length > 0 ? pages.length - (splitInto - 1) * chunkSize : 0;
  const splitIsExact = pages.length % splitInto === 0;

  function handlePagesChange(val: string) {
    setPagesStr(val);
    const n = parseInt(val);
    if (!isNaN(n) && n >= 1 && n < pages.length) {
      const newParts = Math.max(2, Math.ceil(pages.length / n));
      setSplitInto(newParts);
      setPartsStr(newParts.toString());
    }
  }

  function handlePartsChange(val: string) {
    setPartsStr(val);
    const n = parseInt(val);
    if (!isNaN(n) && n >= 2 && n <= pages.length) {
      setSplitInto(n);
      setPagesStr(Math.floor(pages.length / n).toString());
    }
  }

  function syncInputsOnBlur() {
    setPagesStr(chunkSize.toString());
    setPartsStr(splitInto.toString());
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col bg-white">
      {/* Navbar */}
      <header className="border-b border-gray-100 sticky top-0 z-10 bg-white/90 backdrop-blur">
        <div className="max-w-4xl mx-auto px-6 h-14 flex items-center gap-3 text-sm">
          <Link
            href="/"
            className="flex items-center gap-1.5 hover:text-gray-900 transition-colors"
            style={{ color: "#6B7355" }}
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Home
          </Link>
          <span className="text-gray-200">/</span>
          <span className="font-medium text-gray-900">Split PDF</span>
        </div>
      </header>

      <main className="flex-1 py-12 px-6">
        <div className="max-w-4xl mx-auto">
          {/* Page header */}
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-gray-900 mb-1">Split PDF</h1>
            <p className="text-sm" style={{ color: "#6B7355" }}>
              Extract specific pages or split your PDF into two parts.
            </p>
          </div>

          {/* Drop zone — always shown; shrinks once a file is loaded */}
          {!hasFile ? (
            <div
              {...getRootProps()}
              className={`border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-colors mb-6 ${
                isDragActive
                  ? "border-[#7A8F4E] bg-[#F5F6F0]"
                  : "border-gray-200 bg-[#FAFAF8] hover:border-[#A8BA80] hover:bg-[#F5F6F0]"
              }`}
            >
              <input {...getInputProps()} />
              {isLoadingPages ? (
                <Loader2 className="w-7 h-7 mx-auto animate-spin" style={{ color: "#A8BA80" }} />
              ) : (
                <>
                  <UploadCloud
                    className="w-7 h-7 mx-auto mb-2"
                    style={{ color: isDragActive ? "#5C6B3A" : "#A8BA80" }}
                  />
                  <p className="text-sm font-medium text-gray-700">
                    {isDragActive ? "Drop a PDF here" : "Click or drag & drop a PDF"}
                  </p>
                  <p className="text-xs mt-1" style={{ color: "#6B7355" }}>
                    One file at a time
                  </p>
                </>
              )}
            </div>
          ) : (
            /* File info bar */
            <div
              className="flex items-center justify-between px-4 py-3 rounded-2xl border border-gray-100 mb-6"
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
                  <p className="text-sm font-medium text-gray-900 truncate max-w-xs">{file.name}</p>
                  <p className="text-xs" style={{ color: "#6B7355" }}>
                    {formatBytes(file.size)} · {pages.length} pages
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setFile(null);
                  setPages([]);
                  setSelectedPages(new Set());
                  setError(null);
                }}
                className="text-xs hover:text-gray-900 transition-colors"
                style={{ color: "#A8BA80" }}
              >
                Change file
              </button>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-100 text-sm text-red-600">
              {error}
            </div>
          )}

          {/* Mode tabs + page grid */}
          {hasFile && (
            <>
              {/* Tabs */}
              <div className="flex gap-1 p-1 rounded-xl mb-6 w-fit" style={{ background: "#EAEDE3" }}>
                {(["extract", "split"] as Mode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`px-5 py-2 text-sm font-medium rounded-lg transition-all ${
                      mode === m
                        ? "bg-white text-gray-900 shadow-sm"
                        : "text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    {m === "extract" ? "Extract pages" : "Split equally"}
                  </button>
                ))}
              </div>

              {/* ── Extract mode controls ── */}
              {mode === "extract" && (
                <div className="flex items-center justify-between mb-4">
                  <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#A8BA80" }}>
                    {selectedPages.size > 0
                      ? `${selectedPages.size} of ${pages.length} selected`
                      : "Click pages to select"}
                  </p>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={selectAll}
                      className="text-xs hover:text-gray-900 transition-colors"
                      style={{ color: "#A8BA80" }}
                    >
                      Select all
                    </button>
                    {selectedPages.size > 0 && (
                      <button
                        onClick={deselectAll}
                        className="text-xs hover:text-red-400 transition-colors"
                        style={{ color: "#A8BA80" }}
                      >
                        Deselect all
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* ── Split equally controls (converter-style) ── */}
              {mode === "split" && (
                <div className="mb-4 max-w-xs">
                  <div className="border border-gray-200 rounded-2xl overflow-hidden bg-white [box-shadow:2px_4px_8px_rgba(0,0,0,0.06)]">

                    {/* Pages per part */}
                    <div className="flex items-center justify-between px-5 py-4">
                      <div>
                        <p className="text-sm font-medium text-gray-700">Pages per part</p>
                        {!splitIsExact && (
                          <p className="text-[10px] mt-0.5" style={{ color: "#A8BA80" }}>
                            last part: {lastPartSize} page{lastPartSize !== 1 ? "s" : ""}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        {!splitIsExact && (
                          <span className="text-base font-medium" style={{ color: "#A8BA80" }}>≈</span>
                        )}
                        <input
                          type="number"
                          min={1}
                          max={pages.length - 1}
                          value={pagesStr}
                          onChange={(e) => handlePagesChange(e.target.value)}
                          onBlur={syncInputsOnBlur}
                          className="no-spinner w-14 text-right text-xl font-bold text-gray-900 focus:outline-none bg-transparent"
                        />
                      </div>
                    </div>

                    {/* Divider */}
                    <div className="h-px mx-5" style={{ background: "#EAEDE3" }} />

                    {/* Number of parts */}
                    <div className="flex items-center justify-between px-5 py-4">
                      <p className="text-sm font-medium text-gray-700">Number of parts</p>
                      <input
                        type="number"
                        min={2}
                        max={pages.length}
                        value={partsStr}
                        onChange={(e) => handlePartsChange(e.target.value)}
                        onBlur={syncInputsOnBlur}
                        className="no-spinner w-14 text-right text-xl font-bold text-gray-900 focus:outline-none bg-transparent"
                      />
                    </div>

                  </div>
                </div>
              )}

              {/* Page grid */}
              <div className="rounded-2xl p-4 mb-6" style={{ background: "#EAEDE3" }}>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                  {pages.map((page, idx) => (
                    <Fragment key={page.pageNumber}>
                      <PageCard
                        page={page}
                        selected={selectedPages.has(page.pageNumber)}
                        selectable={mode === "extract"}
                        onToggle={() => togglePage(page.pageNumber)}
                      />
                      {/* Divider after every chunk in split equally mode */}
                      {mode === "split" && (idx + 1) % Math.ceil(pages.length / splitInto) === 0 && idx + 1 < pages.length && <SplitDivider />}
                    </Fragment>
                  ))}
                </div>
              </div>

              {/* ── Extract action ── */}
              {mode === "extract" && (
                <button
                  onClick={handleExtract}
                  disabled={selectedPages.size === 0 || isProcessing}
                  className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-semibold text-white transition-opacity disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                  style={{ background: "#5C6B3A" }}
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Extracting…
                    </>
                  ) : selectedPages.size === 0 ? (
                    "Select pages to extract"
                  ) : (
                    <>
                      <Download className="w-4 h-4" />
                      Extract {selectedPages.size} {selectedPages.size === 1 ? "page" : "pages"}
                    </>
                  )}
                </button>
              )}

              {/* ── Split action ── */}
              {mode === "split" && (
                <button
                  onClick={handleSplitDownload}
                  disabled={isProcessing}
                  className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-semibold text-white transition-opacity disabled:opacity-60 cursor-pointer"
                  style={{ background: "#5C6B3A" }}
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Splitting…
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4" />
                      Download ZIP — {splitInto} parts
                    </>
                  )}
                </button>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
