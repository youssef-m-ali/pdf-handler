"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useDropzone } from "react-dropzone";
import {
  DndContext,
  closestCenter,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { PDFDocument, degrees } from "pdf-lib";
import {
  ArrowLeft,
  UploadCloud,
  X,
  FileText,
  Download,
  Loader2,
  RotateCw,
  RotateCcw,
  ArrowDownAZ,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PdfFile {
  id: string;
  file: File;
  pageCount: number | null;
  thumbnail: string | null;   // data-URL, null while loading or on failure
  thumbLoading: boolean;
  rotation: number;           // 0 | 90 | 180 | 270 — applied to all pages during merge
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function readPageCount(file: File): Promise<number | null> {
  try {
    const buf = await file.arrayBuffer();
    const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
    return pdf.getPageCount();
  } catch {
    return null;
  }
}

async function generateThumbnail(file: File): Promise<string | null> {
  try {
    // Dynamic import keeps pdfjs away from the SSR bundle
    const pdfjsLib = await import("pdfjs-dist");
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
    }

    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const page = await pdf.getPage(1);

    const viewport = page.getViewport({ scale: 0.5 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.render({ canvasContext: ctx as any, viewport }).promise;
    return canvas.toDataURL("image/jpeg", 0.75);
  } catch {
    return null;
  }
}

async function mergePdfs(files: PdfFile[]): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  for (const { file, rotation } of files) {
    const buf = await file.arrayBuffer();
    const pdf = await PDFDocument.load(buf);
    const copied = await merged.copyPages(pdf, pdf.getPageIndices());
    copied.forEach((p) => {
      if (rotation !== 0) {
        const existing = p.getRotation().angle;
        p.setRotation(degrees((existing + rotation) % 360));
      }
      merged.addPage(p);
    });
  }
  return merged.save();
}

// ─── Card (used both in sortable list and drag overlay) ───────────────────────

function PdfCard({
  item,
  index,
  onRemove,
  onRotate,
  isDragging = false,
}: {
  item: PdfFile;
  index: number;
  onRemove?: (id: string) => void;
  onRotate?: (id: string, delta: 90 | -90) => void;
  isDragging?: boolean;
}) {
  const thumbScale = item.rotation % 180 !== 0 ? 0.72 : 1;
  return (
    // Outer wrapper — `relative` so we can absolutely position the info pill above the card
    <div className="group relative flex flex-col select-none">

      {/* Info pill — floats above the card, visible on hover */}
      {onRemove && (
        <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-[calc(100%+6px)] z-20 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
          <div className="flex items-center gap-1 bg-black/70 backdrop-blur-sm text-white text-[10px] font-medium px-2.5 py-1 rounded-full">
            {formatBytes(item.file.size)}
            {item.pageCount !== null && (
              <> · {item.pageCount} {item.pageCount === 1 ? "page" : "pages"}</>
            )}
          </div>
        </div>
      )}

      {/* Card — no overflow-hidden so the badge can bleed past the bottom border */}
      <div
        className={`relative aspect-[3/4] rounded-2xl border bg-white ${
          isDragging
            ? "border-[#7A8F4E] shadow-xl ring-2 ring-[#7A8F4E]/30"
            : "border-gray-200 [box-shadow:4px_6px_8px_rgba(0,0,0,0.12)]"
        }`}
      >
        {/* Thumbnail — clipped inside its own rounded container */}
        {item.thumbLoading ? (
          <div className="absolute inset-0 rounded-2xl flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: "#A8BA80" }} />
          </div>
        ) : item.thumbnail ? (
          <div className="absolute inset-0 rounded-2xl overflow-hidden p-4 flex items-center justify-center">
            <img
              src={item.thumbnail}
              alt={item.file.name}
              className="w-full h-full object-contain"
              draggable={false}
              style={{
                transform: `rotate(${item.rotation}deg) scale(${thumbScale})`,
                transition: "transform 0.2s ease",
              }}
            />
          </div>
        ) : (
          <div className="absolute inset-0 rounded-2xl flex items-center justify-center">
            <FileText className="w-8 h-8" style={{ color: "#C8D4A8" }} />
          </div>
        )}

        {/* Action buttons — top-right, visible on hover */}
        {(onRemove || onRotate) && (
          <div
            className="absolute top-2 right-2 flex gap-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {onRotate && (
              <>
                <button
                  onClick={() => onRotate(item.id, -90)}
                  className="w-7 h-7 rounded-full bg-white/90 backdrop-blur-sm flex items-center justify-center shadow-sm hover:bg-white transition-colors"
                  aria-label="Rotate counter-clockwise"
                  title="Rotate left"
                >
                  <RotateCcw className="w-3 h-3 text-gray-600" />
                </button>
                <button
                  onClick={() => onRotate(item.id, 90)}
                  className="w-7 h-7 rounded-full bg-white/90 backdrop-blur-sm flex items-center justify-center shadow-sm hover:bg-white transition-colors"
                  aria-label="Rotate clockwise"
                  title="Rotate right"
                >
                  <RotateCw className="w-3 h-3 text-gray-600" />
                </button>
              </>
            )}
            {onRemove && (
              <button
                onClick={() => onRemove(item.id)}
                className="w-7 h-7 rounded-full bg-white/90 backdrop-blur-sm flex items-center justify-center shadow-sm hover:bg-white transition-colors"
                aria-label="Remove file"
              >
                <X className="w-3 h-3 text-gray-600" />
              </button>
            )}
          </div>
        )}

        {/* Order badge — center sits on the bottom border */}
        <div
          className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-6 h-6 rounded-full flex items-center justify-center shadow-sm z-10"
          style={{ background: "#5C6B3A" }}
        >
          <span className="text-[9px] font-bold text-white leading-none">{index + 1}</span>
        </div>
      </div>

      {/* Filename — mt-4 to clear the half-badge that bleeds below the card */}
      <p className="mt-4 text-[11px] text-center text-gray-500 truncate px-1 leading-tight">
        {item.file.name}
      </p>
    </div>
  );
}

// ─── Sortable wrapper around PdfCard ─────────────────────────────────────────

function SortableCard({
  item,
  index,
  onRemove,
  onRotate,
}: {
  item: PdfFile;
  index: number;
  onRemove: (id: string) => void;
  onRotate: (id: string, delta: 90 | -90) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0 : 1,
      }}
      className="cursor-grab active:cursor-grabbing"
      {...attributes}
      {...listeners}
    >
      <PdfCard item={item} index={index} onRemove={onRemove} onRotate={onRotate} />
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function MergeClient() {
  const [files, setFiles] = useState<PdfFile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // ── Drop ─────────────────────────────────────────────────────────────────
  const onDrop = useCallback(async (accepted: File[]) => {
    setDownloadUrl(null);
    setError(null);

    // Insert placeholders immediately so the grid updates at once
    const placeholders: PdfFile[] = accepted.map((file) => ({
      id: `${file.name}-${Date.now()}-${Math.random()}`,
      file,
      pageCount: null,
      thumbnail: null,
      thumbLoading: true,
      rotation: 0,
    }));

    setFiles((prev) => [...prev, ...placeholders]);

    // Enrich each placeholder with page count + thumbnail asynchronously
    placeholders.forEach(async (placeholder) => {
      const [pageCount, thumbnail] = await Promise.all([
        readPageCount(placeholder.file),
        generateThumbnail(placeholder.file),
      ]);
      setFiles((prev) =>
        prev.map((f) =>
          f.id === placeholder.id
            ? { ...f, pageCount, thumbnail, thumbLoading: false }
            : f
        )
      );
    });
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: true,
  });

  // ── Reorder ──────────────────────────────────────────────────────────────
  function handleDragStart({ active }: DragStartEvent) {
    setActiveId(active.id as string);
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null);
    if (over && active.id !== over.id) {
      setFiles((prev) => {
        const from = prev.findIndex((f) => f.id === active.id);
        const to = prev.findIndex((f) => f.id === over.id);
        return arrayMove(prev, from, to);
      });
    }
  }

  // ── Rotate ───────────────────────────────────────────────────────────────
  function rotateFile(id: string, delta: 90 | -90) {
    setDownloadUrl(null);
    setFiles((prev) =>
      prev.map((f) => f.id === id ? { ...f, rotation: (f.rotation + delta + 360) % 360 } : f)
    );
  }

  // ── Merge ────────────────────────────────────────────────────────────────
  async function handleMerge() {
    if (files.length < 2) return;
    setIsProcessing(true);
    setError(null);
    setDownloadUrl(null);
    try {
      const bytes = await mergePdfs(files);
      const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
      setDownloadUrl(URL.createObjectURL(blob));
    } catch (err) {
      console.error(err);
      setError("Something went wrong. Make sure all files are valid, unlocked PDFs.");
    } finally {
      setIsProcessing(false);
    }
  }

  function handleSortByName() {
    setFiles((prev) => [...prev].sort((a, b) => a.file.name.localeCompare(b.file.name)));
    setDownloadUrl(null);
  }

  const activeItem = files.find((f) => f.id === activeId);
  const activeIndex = files.findIndex((f) => f.id === activeId);
  const totalPages = files.reduce((s, f) => s + (f.pageCount ?? 0), 0);

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
          <span className="font-medium text-gray-900">Merge PDF</span>
        </div>
      </header>

      <main className="flex-1 py-12 px-6">
        <div className="max-w-4xl mx-auto">
          {/* Page header */}
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-gray-900 mb-1">Merge PDFs</h1>
            <p className="text-sm" style={{ color: "#6B7355" }}>
              Add your PDFs, drag to set the order, then merge into one file.
            </p>
          </div>

          {/* Drop zone */}
          <div
            {...getRootProps()}
            className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-colors mb-6 ${
              isDragActive
                ? "border-[#7A8F4E] bg-[#F5F6F0]"
                : "border-gray-200 bg-[#FAFAF8] hover:border-[#A8BA80] hover:bg-[#F5F6F0]"
            }`}
          >
            <input {...getInputProps()} />
            <UploadCloud
              className="w-7 h-7 mx-auto mb-2 transition-colors"
              style={{ color: isDragActive ? "#5C6B3A" : "#A8BA80" }}
            />
            <p className="text-sm font-medium text-gray-700">
              {isDragActive ? "Drop PDFs here" : "Click or drag & drop PDFs"}
            </p>
            <p className="text-xs mt-1" style={{ color: "#6B7355" }}>
              Add as many files as you need
            </p>
          </div>

          {/* Grid */}
          {files.length > 0 && (
            <div className="mb-6 rounded-2xl p-4" style={{ background: "#EAEDE3" }}>
              {/* Grid header */}
              <div className="flex items-center justify-between mb-4">
                <p
                  className="text-xs font-semibold uppercase tracking-widest"
                  style={{ color: "#A8BA80" }}
                >
                  {files.length} {files.length === 1 ? "file" : "files"}
                  {totalPages > 0 && ` · ${totalPages} pages total`}
                </p>
                <div className="flex items-center gap-3">
                  {/* Sort by name */}
                  <div className="relative group/sort">
                    <button
                      onClick={handleSortByName}
                      className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-white/60 transition-colors"
                      style={{ color: "#A8BA80" }}
                      aria-label="Sort files by name"
                    >
                      <ArrowDownAZ className="w-3.5 h-3.5" />
                    </button>
                    {/* Tooltip */}
                    <div className="pointer-events-none absolute bottom-full right-0 mb-1.5 opacity-0 group-hover/sort:opacity-100 transition-opacity whitespace-nowrap">
                      <span className="bg-gray-800 text-white text-[10px] font-medium px-2 py-1 rounded-md">
                        Order files by name
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={() => { setFiles([]); setDownloadUrl(null); setError(null); }}
                    className="text-xs hover:text-red-400 transition-colors"
                    style={{ color: "#A8BA80" }}
                  >
                    Remove all
                  </button>
                </div>
              </div>

              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragCancel={() => setActiveId(null)}
              >
                <SortableContext
                  items={files.map((f) => f.id)}
                  strategy={rectSortingStrategy}
                >
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                    {files.map((item, index) => (
                      <SortableCard
                        key={item.id}
                        item={item}
                        index={index}
                        onRemove={(id) => {
                          setFiles((prev) => prev.filter((f) => f.id !== id));
                          setDownloadUrl(null);
                        }}
                        onRotate={rotateFile}
                      />
                    ))}
                  </div>
                </SortableContext>

                {/* Drag ghost */}
                <DragOverlay>
                  {activeItem ? (
                    <div className="cursor-grabbing">
                      <PdfCard item={activeItem} index={activeIndex} isDragging />
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-100 text-sm text-red-600">
              {error}
            </div>
          )}

          {/* Hint */}
          {files.length === 1 && (
            <p className="text-center text-sm mb-4" style={{ color: "#A8BA80" }}>
              Add at least one more PDF to merge.
            </p>
          )}

          {/* Merge button */}
          {files.length >= 2 && (
            <button
              onClick={handleMerge}
              disabled={isProcessing}
              className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-semibold text-white transition-opacity disabled:opacity-60 cursor-pointer"
              style={{ background: "#5C6B3A" }}
            >
              {isProcessing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Merging…
                </>
              ) : (
                `Merge ${files.length} PDFs`
              )}
            </button>
          )}

          {/* Download */}
          {downloadUrl && (
            <a
              href={downloadUrl}
              download="merged.pdf"
              className="mt-3 w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-semibold border-2 transition-colors hover:bg-[#F5F6F0]"
              style={{ borderColor: "#5C6B3A", color: "#5C6B3A" }}
            >
              <Download className="w-4 h-4" />
              Download merged.pdf
            </a>
          )}
        </div>
      </main>
    </div>
  );
}
