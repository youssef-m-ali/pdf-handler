"use client";

import { useState, useCallback, useRef } from "react";
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
  ImageIcon,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Rotation      = 0 | 45 | -45 | 90;
type Size          = "small" | "medium" | "large";
type Step          = "configure" | "preview";
type WatermarkType = "text" | "image";

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

const TEXT_SIZE_MAP: Record<Size, number> = { small: 28, medium: 52, large: 80 };
const IMG_SIZE_MAP:  Record<Size, number> = { small: 0.2, medium: 0.35, large: 0.5 };

function centerOffsets(w: number, h: number, rotation: Rotation) {
  const rad  = (rotation * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  return { cosA, sinA };
}

async function applyTextWatermark(
  file: File, text: string, size: Size, opacity: number, rotation: Rotation
): Promise<Uint8Array> {
  const buf     = await file.arrayBuffer();
  const pdfDoc  = await PDFDocument.load(buf);
  const font    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontSize = TEXT_SIZE_MAP[size];

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    const { cosA, sinA } = centerOffsets(width, height, rotation);
    const x = width  / 2 - cosA * (textWidth / 2) + sinA * (fontSize / 2);
    const y = height / 2 - sinA * (textWidth / 2) - cosA * (fontSize / 2);

    page.drawText(text, {
      x, y,
      size: fontSize,
      font,
      color: rgb(0.5, 0.5, 0.5),
      opacity: opacity / 100,
      rotate: degrees(rotation),
    });
  }

  return pdfDoc.save();
}

async function applyImageWatermark(
  file: File, imageFile: File, size: Size, opacity: number, rotation: Rotation
): Promise<Uint8Array> {
  const buf    = await file.arrayBuffer();
  const imgBuf = await imageFile.arrayBuffer();
  const pdfDoc = await PDFDocument.load(buf);

  const isPng = imageFile.type === "image/png";
  const embedded = isPng
    ? await pdfDoc.embedPng(imgBuf)
    : await pdfDoc.embedJpg(imgBuf);

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize();
    const scale    = IMG_SIZE_MAP[size];
    const imgW     = width * scale;
    const imgH     = imgW * (embedded.height / embedded.width);
    const { cosA, sinA } = centerOffsets(width, height, rotation);
    const x = width  / 2 - cosA * (imgW / 2) + sinA * (imgH / 2);
    const y = height / 2 - sinA * (imgW / 2) - cosA * (imgH / 2);

    page.drawImage(embedded, {
      x, y,
      width: imgW,
      height: imgH,
      opacity: opacity / 100,
      rotate: degrees(rotation),
    });
  }

  return pdfDoc.save();
}

async function renderThumbnails(bytes: Uint8Array): Promise<string[]> {
  const pdfjsLib = await import("pdfjs-dist");
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
  }
  const pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
  const thumbs: string[] = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page     = await pdfDoc.getPage(i);
    const viewport = page.getViewport({ scale: 0.4 });
    const canvas   = document.createElement("canvas");
    canvas.width   = viewport.width;
    canvas.height  = viewport.height;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.render({ canvasContext: canvas.getContext("2d") as any, viewport }).promise;
    thumbs.push(canvas.toDataURL("image/jpeg", 0.8));
  }
  return thumbs;
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
  const [file, setFile]                   = useState<File | null>(null);
  const [wmType, setWmType]               = useState<WatermarkType>("text");
  const [text, setText]                   = useState("");
  const [imageFile, setImageFile]         = useState<File | null>(null);
  const [imagePreview, setImagePreview]   = useState<string | null>(null);
  const [size, setSize]                   = useState<Size>("medium");
  const [opacity, setOpacity]             = useState(30);
  const [rotation, setRotation]           = useState<Rotation>(45);
  const [step, setStep]                   = useState<Step>("configure");
  const [result, setResult]               = useState<Uint8Array | null>(null);
  const [thumbnails, setThumbnails]       = useState<string[]>([]);
  const [isProcessing, setIsProcessing]   = useState(false);
  const [error, setError]                 = useState<string | null>(null);
  const imageInputRef                     = useRef<HTMLInputElement>(null);

  const reset = () => {
    setFile(null); setResult(null); setThumbnails([]);
    setStep("configure"); setError(null);
    setImageFile(null); setImagePreview(null);
  };

  const onDrop = useCallback((accepted: File[]) => {
    if (accepted[0]) {
      setFile(accepted[0]); setResult(null); setThumbnails([]);
      setStep("configure"); setError(null);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: false,
  });

  const handleImagePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setImageFile(f);
    setImagePreview(URL.createObjectURL(f));
  };

  const canProceed = wmType === "text" ? text.trim().length > 0 : imageFile !== null;

  const handleNext = async () => {
    if (!file || !canProceed) return;
    setIsProcessing(true);
    setError(null);
    try {
      const bytes = wmType === "text"
        ? await applyTextWatermark(file, text.trim(), size, opacity, rotation)
        : await applyImageWatermark(file, imageFile!, size, opacity, rotation);
      const thumbs = await renderThumbnails(bytes);
      setResult(bytes);
      setThumbnails(thumbs);
      setStep("preview");
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
          <Link href="/" className="flex items-center gap-1.5 transition-colors hover:text-gray-900" style={{ color: "#6B7355" }}>
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
            Stamp a text or image watermark on every page of your PDF.
          </p>
        </div>

        {/* File bar / dropzone */}
        {!file ? (
          <div
            {...getRootProps()}
            className="border-2 border-dashed rounded-2xl p-10 flex flex-col items-center gap-3 cursor-pointer transition-colors text-center"
            style={{
              borderColor: isDragActive ? "#5C6B3A" : "#C8D4A8",
              background:  isDragActive ? "#F0F2EA"  : "#FAFAF8",
            }}
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
                <p className="text-sm font-medium text-gray-900 truncate max-w-[200px]">{file.name}</p>
                <p className="text-xs" style={{ color: "#6B7355" }}>{formatBytes(file.size)}</p>
              </div>
            </div>
            {step === "preview" ? (
              <button onClick={() => setStep("configure")} className="flex items-center gap-1 text-xs transition-colors hover:text-gray-900" style={{ color: "#6B7355" }}>
                <ArrowLeft className="w-3 h-3" /> Change settings
              </button>
            ) : (
              <button onClick={reset} className="text-xs transition-colors hover:text-gray-600" style={{ color: "#A8BA80" }}>Change</button>
            )}
          </div>
        )}

        {/* ── Configure step ── */}
        {file && step === "configure" && (
          <>
            <div className="flex flex-col gap-5">

              {/* Type toggle */}
              <div className="flex gap-1 p-1 rounded-xl w-fit" style={{ background: "#EAEDE3" }}>
                {(["text", "image"] as WatermarkType[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => setWmType(t)}
                    className={`flex items-center gap-1.5 px-5 py-2 text-sm font-medium rounded-lg transition-all ${
                      wmType === t ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    {t === "text" ? <><Stamp className="w-3.5 h-3.5" /> Text</> : <><ImageIcon className="w-3.5 h-3.5" /> Image</>}
                  </button>
                ))}
              </div>

              {/* Text input */}
              {wmType === "text" && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "#A8BA80" }}>Watermark text</p>
                  <input
                    type="text"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="e.g. CONFIDENTIAL"
                    className="w-full px-3.5 py-2.5 text-sm rounded-xl border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-[#7A8F4E]/20 focus:border-[#A8BA80] transition-colors"
                  />
                </div>
              )}

              {/* Image upload */}
              {wmType === "image" && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "#A8BA80" }}>Watermark image</p>
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/png,image/jpeg"
                    className="hidden"
                    onChange={handleImagePick}
                  />
                  {imagePreview ? (
                    <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-gray-200 bg-white">
                      <img src={imagePreview} alt="Watermark preview" className="w-12 h-12 object-contain rounded-lg" style={{ background: "#F5F6F0" }} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{imageFile!.name}</p>
                        <p className="text-xs" style={{ color: "#6B7355" }}>{formatBytes(imageFile!.size)}</p>
                      </div>
                      <button onClick={() => imageInputRef.current?.click()} className="text-xs transition-colors hover:text-gray-600" style={{ color: "#A8BA80" }}>
                        Change
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => imageInputRef.current?.click()}
                      className="flex items-center justify-center gap-2 px-4 py-4 rounded-xl border-2 border-dashed border-gray-200 text-sm transition-colors hover:border-[#A8BA80] hover:bg-[#F5F6F0]"
                      style={{ color: "#A8BA80" }}
                    >
                      <UploadCloud className="w-4 h-4" />
                      Click to upload PNG or JPG
                    </button>
                  )}
                </div>
              )}

              {/* Size */}
              <div className="flex flex-col gap-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "#A8BA80" }}>Size</p>
                <div className="flex gap-2">
                  {SIZE_OPTIONS.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => setSize(s.id)}
                      className={`flex-1 py-2.5 px-3 rounded-xl text-sm font-medium border transition-all ${
                        size === s.id ? "border-[#5C6B3A] text-white" : "border-gray-200 text-gray-600 hover:border-[#C8D4A8]"
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
                        rotation === r.value ? "border-[#5C6B3A] text-white" : "border-gray-200 text-gray-600 hover:border-[#C8D4A8]"
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
                  type="range" min={5} max={80} value={opacity}
                  onChange={(e) => setOpacity(Number(e.target.value))}
                  className="w-full accent-[#5C6B3A]"
                />
                <div className="flex justify-between text-[10px]" style={{ color: "#C8D4A8" }}>
                  <span>Subtle</span><span>Bold</span>
                </div>
              </div>

            </div>

            {error && (
              <div className="px-4 py-3 rounded-xl bg-red-50 border border-red-100 text-sm text-red-600">{error}</div>
            )}

            <button
              onClick={handleNext}
              disabled={isProcessing || !canProceed}
              className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-semibold text-white disabled:opacity-40 transition-opacity text-sm cursor-pointer disabled:cursor-not-allowed"
              style={{ background: "#5C6B3A" }}
            >
              {isProcessing ? <><Loader2 className="w-4 h-4 animate-spin" /> Generating preview…</> : "Next"}
            </button>
          </>
        )}

        {/* ── Preview step ── */}
        {file && step === "preview" && result && (
          <>
            <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "#A8BA80" }}>
              Preview — {thumbnails.length} {thumbnails.length === 1 ? "page" : "pages"}
            </p>

            <div className="rounded-2xl p-4 max-h-[520px] overflow-y-auto" style={{ background: "#EAEDE3" }}>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                {thumbnails.map((src, i) => (
                  <div key={i} className="pb-4">
                    <div className="relative aspect-[3/4] rounded-2xl border border-gray-200 bg-white [box-shadow:4px_6px_8px_rgba(0,0,0,0.10)]">
                      <img src={src} alt={`Page ${i + 1}`} className="absolute inset-0 w-full h-full object-contain p-2" draggable={false} />
                      <div
                        className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-6 h-6 rounded-full flex items-center justify-center shadow-sm z-10"
                        style={{ background: "#A8BA80" }}
                      >
                        <span className="text-[9px] font-bold text-white leading-none">{i + 1}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <button
              onClick={() => {
                const base = file!.name.replace(/\.pdf$/i, "");
                triggerDownload(result, `${base}_watermarked.pdf`);
              }}
              className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-semibold text-white text-sm"
              style={{ background: "#5C6B3A" }}
            >
              <Download className="w-4 h-4" />
              Download watermarked PDF
            </button>
          </>
        )}

      </main>
    </div>
  );
}
