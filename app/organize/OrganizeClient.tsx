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
  FileText,
  Download,
  Loader2,
  RotateCcw,
  RotateCw,
  X,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PageItem {
  id: string;
  originalIndex: number;  // 0-indexed position in the source PDF
  rotation: number;       // user-applied delta: 0 | 90 | 180 | 270
  thumbnail: string | null;
  thumbLoading: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function buildOrganizedPdf(sourceFile: File, pages: PageItem[]): Promise<Uint8Array> {
  const buf = await sourceFile.arrayBuffer();
  const source = await PDFDocument.load(buf);
  const out = await PDFDocument.create();

  for (const item of pages) {
    const [copied] = await out.copyPages(source, [item.originalIndex]);
    if (item.rotation !== 0) {
      const existing = copied.getRotation().angle;
      copied.setRotation(degrees((existing + item.rotation) % 360));
    }
    out.addPage(copied);
  }

  return out.save();
}

// ─── Page card (presentational) ───────────────────────────────────────────────

function PageCard({
  item,
  index,
  onRotate,
  onDelete,
  isDragging = false,
}: {
  item: PageItem;
  index: number;
  onRotate?: (id: string, delta: 90 | -90) => void;
  onDelete?: (id: string) => void;
  isDragging?: boolean;
}) {
  // Thumbnail needs CSS rotation for the user's delta (pdfjs already bakes in the PDF's own rotation)
  const thumbRotation = item.rotation;
  // When rotated 90/270, the image is wider than it is tall inside the portrait card —
  // we scale it down so it fits without clipping.
  const thumbScale = thumbRotation % 180 !== 0 ? 0.72 : 1;

  return (
    <div className="group relative flex flex-col select-none">
      {/* Card */}
      <div
        className={`relative aspect-[3/4] rounded-2xl border bg-white overflow-hidden ${
          isDragging
            ? "border-[#7A8F4E] shadow-xl ring-2 ring-[#7A8F4E]/30"
            : "border-gray-200 [box-shadow:4px_6px_8px_rgba(0,0,0,0.12)]"
        }`}
      >
        {/* Thumbnail */}
        {item.thumbLoading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: "#A8BA80" }} />
          </div>
        ) : item.thumbnail ? (
          <div className="absolute inset-0 flex items-center justify-center p-3">
            <img
              src={item.thumbnail}
              alt={`Page ${index + 1}`}
              draggable={false}
              style={{
                transform: `rotate(${thumbRotation}deg) scale(${thumbScale})`,
                transition: "transform 0.2s ease",
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
              }}
            />
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <FileText className="w-8 h-8" style={{ color: "#C8D4A8" }} />
          </div>
        )}

        {/* Action buttons — top-right on hover */}
        {(onRotate || onDelete) && (
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
            {onDelete && (
              <button
                onClick={() => onDelete(item.id)}
                className="w-7 h-7 rounded-full bg-white/90 backdrop-blur-sm flex items-center justify-center shadow-sm hover:bg-white transition-colors"
                aria-label="Delete page"
                title="Delete page"
              >
                <X className="w-3 h-3 text-gray-600" />
              </button>
            )}
          </div>
        )}

        {/* Order badge — bottom center, half outside */}
        <div
          className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-6 h-6 rounded-full flex items-center justify-center shadow-sm z-10"
          style={{ background: "#5C6B3A" }}
        >
          <span className="text-[9px] font-bold text-white leading-none">{index + 1}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Sortable wrapper ─────────────────────────────────────────────────────────

function SortablePage({
  item,
  index,
  onRotate,
  onDelete,
}: {
  item: PageItem;
  index: number;
  onRotate: (id: string, delta: 90 | -90) => void;
  onDelete: (id: string) => void;
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
      <PageCard item={item} index={index} onRotate={onRotate} onDelete={onDelete} />
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function OrganizeClient() {
  const [file, setFile] = useState<File | null>(null);
  const [pages, setPages] = useState<PageItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isLoadingPages, setIsLoadingPages] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // ── Load PDF ─────────────────────────────────────────────────────────────
  async function loadPdf(f: File) {
    setFile(f);
    setPages([]);
    setDownloadUrl(null);
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

      // Seed grid immediately
      setPages(
        Array.from({ length: numPages }, (_, i) => ({
          id: `page-${i}-${Date.now()}`,
          originalIndex: i,
          rotation: 0,
          thumbnail: null,
          thumbLoading: true,
        }))
      );
      setIsLoadingPages(false);

      // Render thumbnails sequentially
      for (let i = 1; i <= numPages; i++) {
        try {
          const page = await pdfDoc.getPage(i);
          const viewport = page.getViewport({ scale: 0.4 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await page.render({ canvasContext: ctx as any, viewport }).promise;
          const thumbnail = canvas.toDataURL("image/jpeg", 0.75);
          setPages((prev) =>
            prev.map((p) =>
              p.originalIndex === i - 1 ? { ...p, thumbnail, thumbLoading: false } : p
            )
          );
        } catch {
          setPages((prev) =>
            prev.map((p) =>
              p.originalIndex === i - 1 ? { ...p, thumbLoading: false } : p
            )
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

  // ── Drag & drop reorder ───────────────────────────────────────────────────
  function handleDragStart({ active }: DragStartEvent) {
    setActiveId(active.id as string);
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null);
    setDownloadUrl(null);
    if (over && active.id !== over.id) {
      setPages((prev) => {
        const from = prev.findIndex((p) => p.id === active.id);
        const to = prev.findIndex((p) => p.id === over.id);
        return arrayMove(prev, from, to);
      });
    }
  }

  // ── Rotate ────────────────────────────────────────────────────────────────
  function rotatePage(id: string, delta: 90 | -90) {
    setDownloadUrl(null);
    setPages((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, rotation: ((p.rotation + delta + 360) % 360) } : p
      )
    );
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  function deletePage(id: string) {
    setDownloadUrl(null);
    setPages((prev) => prev.filter((p) => p.id !== id));
  }

  // ── Download ──────────────────────────────────────────────────────────────
  async function handleDownload() {
    if (!file || pages.length === 0) return;
    setIsProcessing(true);
    setError(null);
    setDownloadUrl(null);
    try {
      const bytes = await buildOrganizedPdf(file, pages);
      const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
      setDownloadUrl(URL.createObjectURL(blob));
    } catch (err) {
      console.error(err);
      setError("Something went wrong. Make sure the PDF is a valid, unlocked file.");
    } finally {
      setIsProcessing(false);
    }
  }

  const hasFile = file !== null && pages.length > 0;
  const activeItem = pages.find((p) => p.id === activeId);
  const activeIndex = pages.findIndex((p) => p.id === activeId);

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
          <span className="font-medium text-gray-900">Organize Pages</span>
        </div>
      </header>

      <main className="flex-1 py-12 px-6">
        <div className="max-w-4xl mx-auto">
          {/* Page header */}
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-gray-900 mb-1">Organize Pages</h1>
            <p className="text-sm" style={{ color: "#6B7355" }}>
              Drag to reorder, rotate, or delete pages — then download your new PDF.
            </p>
          </div>

          {/* Drop zone / file info bar */}
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
                    {formatBytes(file.size)} · {pages.length} page{pages.length !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setFile(null);
                  setPages([]);
                  setDownloadUrl(null);
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

          {/* Page grid */}
          {hasFile && (
            <>
              {/* Grid header */}
              <div className="flex items-center justify-between mb-3">
                <p
                  className="text-xs font-semibold uppercase tracking-widest"
                  style={{ color: "#A8BA80" }}
                >
                  {pages.length} page{pages.length !== 1 ? "s" : ""}
                </p>
                <button
                  onClick={() => {
                    setPages([]);
                    setDownloadUrl(null);
                  }}
                  className="text-xs hover:text-red-400 transition-colors"
                  style={{ color: "#A8BA80" }}
                >
                  Remove all
                </button>
              </div>

              <div className="rounded-2xl p-4 mb-6" style={{ background: "#EAEDE3" }}>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragCancel={() => setActiveId(null)}
                >
                  <SortableContext
                    items={pages.map((p) => p.id)}
                    strategy={rectSortingStrategy}
                  >
                    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                      {pages.map((item, index) => (
                        <SortablePage
                          key={item.id}
                          item={item}
                          index={index}
                          onRotate={rotatePage}
                          onDelete={deletePage}
                        />
                      ))}
                    </div>
                  </SortableContext>

                  <DragOverlay>
                    {activeItem ? (
                      <div className="cursor-grabbing">
                        <PageCard item={activeItem} index={activeIndex} isDragging />
                      </div>
                    ) : null}
                  </DragOverlay>
                </DndContext>
              </div>

              {/* Actions */}
              <button
                onClick={handleDownload}
                disabled={isProcessing || pages.length === 0}
                className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-semibold text-white transition-opacity disabled:opacity-60 cursor-pointer"
                style={{ background: "#5C6B3A" }}
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Processing…
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    Download organized PDF
                  </>
                )}
              </button>

              {downloadUrl && (
                <a
                  href={downloadUrl}
                  download="organized.pdf"
                  className="mt-3 w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-semibold border-2 transition-colors hover:bg-[#F5F6F0]"
                  style={{ borderColor: "#5C6B3A", color: "#5C6B3A" }}
                >
                  <Download className="w-4 h-4" />
                  Download organized.pdf
                </a>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
