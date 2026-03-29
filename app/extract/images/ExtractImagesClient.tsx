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
  Images,
  Check,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PageThumb {
  pageNum: number;
  dataUrl: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Convert pdfjs image object (any kind) to RGBA Uint8ClampedArray
function toRGBA(imgObj: { width: number; height: number; data: Uint8Array | Uint8ClampedArray; kind: number }): Uint8ClampedArray {
  const { width, height, data, kind } = imgObj;
  // kind: 1 = GRAYSCALE_1BPP, 2 = RGB_24BPP, 3 = RGBA_32BPP
  if (kind === 3) {
    return data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data.buffer);
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (kind === 2) {
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4]     = data[i * 3];
      rgba[i * 4 + 1] = data[i * 3 + 1];
      rgba[i * 4 + 2] = data[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
  } else {
    // GRAYSCALE_1BPP
    const bytesPerRow = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = data[y * bytesPerRow + Math.floor(x / 8)];
        const bit = (byte >> (7 - (x % 8))) & 1;
        const val = bit ? 255 : 0;
        const p = (y * width + x) * 4;
        rgba[p] = rgba[p + 1] = rgba[p + 2] = val;
        rgba[p + 3] = 255;
      }
    }
  }
  return rgba;
}

async function renderThumbs(file: File): Promise<PageThumb[]> {
  const pdfjsLib = await import("pdfjs-dist");
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
  }
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const thumbs: PageThumb[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 72 / 72 }); // 1x = 72 DPI
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext("2d")! as CanvasRenderingContext2D, viewport: vp }).promise;
    thumbs.push({ pageNum: i, dataUrl: canvas.toDataURL("image/jpeg", 0.7) });
  }
  return thumbs;
}

async function extractImages(
  file: File,
  selectedPages: number[]
): Promise<{ pageNum: number; imgIndex: number; dataUrl: string }[]> {
  const pdfjsLib = await import("pdfjs-dist");
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
  }
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;

  const IMAGE_OPS = new Set([
    pdfjsLib.OPS.paintJpegXObject,
    pdfjsLib.OPS.paintImageXObject,
    pdfjsLib.OPS.paintImageMaskXObject,
    pdfjsLib.OPS.paintImageXObjectRepeat,
  ]);

  const results: { pageNum: number; imgIndex: number; dataUrl: string }[] = [];

  for (const pageNum of selectedPages) {
    const page = await pdf.getPage(pageNum);
    const opList = await page.getOperatorList();

    // Collect unique image names referenced on this page
    const seen = new Set<string>();
    const imgNames: string[] = [];
    for (let i = 0; i < opList.fnArray.length; i++) {
      if (IMAGE_OPS.has(opList.fnArray[i])) {
        const name: string = opList.argsArray[i][0];
        if (!seen.has(name)) { seen.add(name); imgNames.push(name); }
      }
    }

    let imgIndex = 0;
    for (const name of imgNames) {
      // page.objs.get fires callback immediately if already loaded, or when ready
      const imgObj = await new Promise<{ width: number; height: number; data: Uint8Array; kind: number } | null>((resolve) => {
        try {
          page.objs.get(name, (obj: unknown) => resolve(obj as never));
        } catch {
          resolve(null);
        }
      });

      if (!imgObj || !imgObj.width || !imgObj.height || !imgObj.data) continue;

      try {
        const rgba = toRGBA(imgObj);
        const canvas = document.createElement("canvas");
        canvas.width = imgObj.width;
        canvas.height = imgObj.height;
        canvas.getContext("2d")!.putImageData(new ImageData(rgba, imgObj.width, imgObj.height), 0, 0);
        results.push({ pageNum, imgIndex: imgIndex++, dataUrl: canvas.toDataURL("image/png") });
      } catch {
        // skip malformed images
      }
    }
  }

  return results;
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
      for (let i = a; i !== b + step; i += step)
        if (!seen.has(i)) { seen.add(i); result.push(i); }
    } else if (/^\d+$/.test(trimmed)) {
      const n = parseInt(trimmed);
      if (n < 1 || n > total) { invalid = true; continue; }
      if (!seen.has(n)) { seen.add(n); result.push(n); }
    } else { invalid = true; }
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

// ─── Thumb card ───────────────────────────────────────────────────────────────

function ThumbCard({ thumb, selected, onToggle }: { thumb: PageThumb; selected: boolean; onToggle: () => void }) {
  return (
    <div onClick={onToggle} className="relative group flex flex-col select-none cursor-pointer">
      <div className={`relative aspect-[3/4] rounded-2xl border bg-white transition-all duration-150 ${
        selected
          ? "border-[#5C6B3A] ring-2 ring-[#5C6B3A]/20 [box-shadow:4px_6px_8px_rgba(92,107,58,0.2)]"
          : "[box-shadow:4px_6px_8px_rgba(0,0,0,0.10)] border-gray-200"
      }`}>
        <div className="absolute inset-0 rounded-2xl overflow-hidden p-2 flex items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={thumb.dataUrl} alt={`Page ${thumb.pageNum}`} className="w-full h-full object-contain" draggable={false} />
        </div>

        {selected && (
          <div className="absolute inset-0 rounded-2xl bg-[#5C6B3A]/10 flex items-start justify-end p-2">
            <div className="w-5 h-5 rounded-full flex items-center justify-center" style={{ background: "#5C6B3A" }}>
              <Check className="w-3 h-3 text-white" strokeWidth={3} />
            </div>
          </div>
        )}
        {!selected && (
          <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity bg-black/5 flex items-start justify-end p-2">
            <div className="w-5 h-5 rounded-full border-2 border-white/80 bg-white/30" />
          </div>
        )}

        <div
          className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-6 h-6 rounded-full flex items-center justify-center shadow-sm z-10"
          style={{ background: selected ? "#5C6B3A" : "#A8BA80" }}
        >
          <span className="text-[9px] font-bold text-white leading-none">{thumb.pageNum}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ExtractImagesClient() {
  const [file, setFile]               = useState<File | null>(null);
  const [thumbs, setThumbs]           = useState<PageThumb[] | null>(null);
  const [isLoading, setIsLoading]     = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [selectedNums, setSelectedNums] = useState<Set<number>>(new Set());
  const [rangeStr, setRangeStr]       = useState("");
  const [error, setError]             = useState<string | null>(null);
  const [emptyMsg, setEmptyMsg]       = useState<string | null>(null);

  const reset = () => {
    setFile(null); setThumbs(null); setSelectedNums(new Set());
    setRangeStr(""); setError(null); setEmptyMsg(null);
  };

  const onDrop = useCallback(async (accepted: File[]) => {
    const f = accepted[0];
    if (!f) return;
    setFile(f);
    setThumbs(null);
    setSelectedNums(new Set());
    setRangeStr("");
    setError(null);
    setEmptyMsg(null);
    setIsLoading(true);
    try {
      const result = await renderThumbs(f);
      const allNums = result.map((t) => t.pageNum);
      setThumbs(result);
      setSelectedNums(new Set(allNums));
      setRangeStr(pagesToRangeString(allNums));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load PDF.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: false,
  });

  const togglePage = (n: number) => {
    setSelectedNums((prev) => {
      const next = new Set(prev);
      next.has(n) ? next.delete(n) : next.add(n);
      setRangeStr(pagesToRangeString([...next].sort((a, b) => a - b)));
      return next;
    });
  };

  const allSelected = thumbs !== null && selectedNums.size === thumbs.length;

  const toggleSelectAll = () => {
    if (!thumbs) return;
    if (allSelected) { setSelectedNums(new Set()); setRangeStr(""); }
    else {
      const allNums = thumbs.map((t) => t.pageNum);
      setSelectedNums(new Set(allNums));
      setRangeStr(pagesToRangeString(allNums));
    }
  };

  const handleRangeChange = (val: string) => {
    setRangeStr(val);
    if (!thumbs) return;
    const { pages } = parsePageRange(val, thumbs.length);
    setSelectedNums(new Set(pages));
  };

  const rangeInvalid = rangeStr.trim() !== "" && thumbs !== null && parsePageRange(rangeStr, thumbs.length).invalid;

  const handleExtract = async () => {
    if (!file || selectedNums.size === 0) return;
    setIsExtracting(true);
    setError(null);
    setEmptyMsg(null);
    try {
      const pages = [...selectedNums].sort((a, b) => a - b);
      const images = await extractImages(file, pages);

      if (images.length === 0) {
        setEmptyMsg("No embedded images found in the selected pages.");
        return;
      }

      const baseName = file.name.replace(/\.pdf$/i, "");
      if (images.length === 1) {
        const { pageNum, imgIndex, dataUrl } = images[0];
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = `${baseName}_page${String(pageNum).padStart(2, "0")}_img${imgIndex + 1}.png`;
        a.click();
        return;
      }

      const zip = new JSZip();
      for (const { pageNum, imgIndex, dataUrl } of images) {
        zip.file(
          `${baseName}_page${String(pageNum).padStart(2, "0")}_img${imgIndex + 1}.png`,
          dataUrl.split(",")[1],
          { base64: true }
        );
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${baseName}_images.zip`;
      a.click();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Extraction failed.");
    } finally {
      setIsExtracting(false);
    }
  };

  return (
    <div className="min-h-screen bg-white text-gray-900 flex flex-col">

      {/* Navbar */}
      <header className="border-b border-gray-100 sticky top-0 z-10 bg-white/90 backdrop-blur">
        <div className="max-w-4xl mx-auto px-6 h-14 flex items-center gap-3 text-sm">
          <Link href="/" className="flex items-center gap-1.5 transition-colors hover:text-gray-900" style={{ color: "#6B7355" }}>
            <ArrowLeft className="w-3.5 h-3.5" /> Home
          </Link>
          <span style={{ color: "#C8D4A8" }}>/</span>
          <span className="font-medium text-gray-900">Extract Images</span>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-6 py-12 flex flex-col gap-6">

        {/* Title */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: "#EDF0E6" }}>
              <Images className="w-4 h-4" style={{ color: "#5C6B3A" }} />
            </div>
            <h1 className="text-xl font-semibold text-gray-900">Extract Images</h1>
          </div>
          <p className="text-sm pl-[42px]" style={{ color: "#6B7355" }}>
            Pull all embedded images out of a PDF — runs locally in your browser.
          </p>
        </div>

        {/* Dropzone / file bar */}
        {!file ? (
          <div
            {...getRootProps()}
            className="border-2 border-dashed rounded-2xl p-10 flex flex-col items-center gap-3 cursor-pointer transition-colors text-center"
            style={{ borderColor: isDragActive ? "#5C6B3A" : "#C8D4A8", background: isDragActive ? "#F0F2EA" : "#FAFAF8" }}
          >
            <input {...getInputProps()} />
            <UploadCloud className="w-8 h-8" style={{ color: isDragActive ? "#5C6B3A" : "#A8BA80" }} />
            <div>
              <p className="text-sm font-medium text-gray-800">{isDragActive ? "Drop it here" : "Drop a PDF here"}</p>
              <p className="text-xs mt-1" style={{ color: "#A8BA80" }}>or click to browse</p>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between px-4 py-3 rounded-2xl border border-gray-100" style={{ background: "#FAFAF8" }}>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "#EDF0E6" }}>
                <FileText className="w-4 h-4" style={{ color: "#5C6B3A" }} />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900 truncate max-w-[220px]">{file.name}</p>
                <p className="text-xs" style={{ color: "#6B7355" }}>{formatBytes(file.size)}</p>
              </div>
            </div>
            <button onClick={reset} className="text-xs transition-colors hover:text-gray-600" style={{ color: "#A8BA80" }}>Change</button>
          </div>
        )}

        {/* Loading thumbnails */}
        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm" style={{ color: "#A8BA80" }}>
            <Loader2 className="w-4 h-4 animate-spin" /> Loading pages…
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="px-4 py-3 rounded-xl bg-red-50 border border-red-100 text-sm text-red-600">{error}</div>
        )}

        {/* Empty result message */}
        {emptyMsg && (
          <div className="px-4 py-3 rounded-xl border border-[#C8D4A8] text-sm" style={{ background: "#F5F6F0", color: "#6B7355" }}>
            {emptyMsg}
          </div>
        )}

        {/* Page selection */}
        {thumbs && (
          <>
            {/* Range input */}
            <div className="flex flex-col gap-1">
              <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "#A8BA80" }}>
                Pages to extract from{" "}
                <span className="normal-case tracking-normal font-normal" style={{ color: "#C8D4A8" }}>(e.g. 1-3, 5, 7-9)</span>
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
            </div>

            {/* Controls row */}
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#A8BA80" }}>
                {selectedNums.size > 0
                  ? `${selectedNums.size} of ${thumbs.length} pages selected`
                  : "Click pages to select"}
              </p>
              <button
                onClick={toggleSelectAll}
                className="flex items-center gap-1.5 text-xs hover:text-gray-900 transition-colors"
                style={{ color: "#A8BA80" }}
              >
                <span
                  className="w-3.5 h-3.5 rounded flex items-center justify-center border transition-colors flex-shrink-0"
                  style={allSelected ? { background: "#5C6B3A", borderColor: "#5C6B3A" } : { borderColor: "#A8BA80" }}
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

            {/* Scrollable grid */}
            <div className="rounded-2xl p-4 max-h-[520px] overflow-y-auto" style={{ background: "#EAEDE3" }}>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                {thumbs.map((thumb) => (
                  <ThumbCard
                    key={thumb.pageNum}
                    thumb={thumb}
                    selected={selectedNums.has(thumb.pageNum)}
                    onToggle={() => togglePage(thumb.pageNum)}
                  />
                ))}
              </div>
            </div>

            {/* Extract button */}
            <button
              onClick={handleExtract}
              disabled={selectedNums.size === 0 || isExtracting}
              className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed transition-opacity text-sm"
              style={{ background: "#5C6B3A" }}
            >
              {isExtracting ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Extracting…</>
              ) : selectedNums.size === 0 ? (
                "Select pages to extract from"
              ) : (
                <><Download className="w-4 h-4" /> Extract images from {selectedNums.size} {selectedNums.size === 1 ? "page" : "pages"}</>
              )}
            </button>
          </>
        )}

      </main>
    </div>
  );
}
