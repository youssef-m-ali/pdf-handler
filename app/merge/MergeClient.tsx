"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useDropzone } from "react-dropzone";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { PDFDocument } from "pdf-lib";
import {
  ArrowLeft,
  UploadCloud,
  GripVertical,
  X,
  FileText,
  Download,
  Loader2,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PdfFile {
  id: string;
  file: File;
  pageCount: number | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

async function mergePdfs(files: File[]): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  for (const file of files) {
    const buf = await file.arrayBuffer();
    const pdf = await PDFDocument.load(buf);
    const copied = await merged.copyPages(pdf, pdf.getPageIndices());
    copied.forEach((page) => merged.addPage(page));
  }
  return merged.save();
}

// ─── Sortable file row ────────────────────────────────────────────────────────

function SortableItem({
  item,
  index,
  onRemove,
}: {
  item: PdfFile;
  index: number;
  onRemove: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.45 : 1,
        zIndex: isDragging ? 20 : undefined,
      }}
      className="flex items-center gap-3 px-4 py-3 bg-white border border-gray-100 rounded-xl"
    >
      {/* order badge */}
      <span
        className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 text-white"
        style={{ background: "#A8BA80" }}
      >
        {index + 1}
      </span>

      {/* drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="touch-none cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-400 transition-colors"
        aria-label="Drag to reorder"
      >
        <GripVertical className="w-4 h-4" />
      </button>

      {/* file icon */}
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ background: "#EDF0E6" }}
      >
        <FileText className="w-4 h-4" style={{ color: "#5C6B3A" }} />
      </div>

      {/* name + meta */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{item.file.name}</p>
        <p className="text-xs mt-0.5" style={{ color: "#6B7355" }}>
          {formatBytes(item.file.size)}
          {item.pageCount !== null && (
            <span>
              {" "}
              · {item.pageCount} {item.pageCount === 1 ? "page" : "pages"}
            </span>
          )}
        </p>
      </div>

      {/* remove */}
      <button
        onClick={() => onRemove(item.id)}
        className="flex-shrink-0 text-gray-300 hover:text-red-400 transition-colors"
        aria-label="Remove file"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function MergeClient() {
  const [files, setFiles] = useState<PdfFile[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // ── Drop handler ─────────────────────────────────────────────────────────
  const onDrop = useCallback(async (accepted: File[]) => {
    setDownloadUrl(null);
    setError(null);

    const newItems: PdfFile[] = await Promise.all(
      accepted.map(async (file) => ({
        id: `${file.name}-${Date.now()}-${Math.random()}`,
        file,
        pageCount: await readPageCount(file),
      }))
    );

    setFiles((prev) => [...prev, ...newItems]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: true,
  });

  // ── Reorder ───────────────────────────────────────────────────────────────
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setFiles((prev) => {
        const from = prev.findIndex((f) => f.id === active.id);
        const to = prev.findIndex((f) => f.id === over.id);
        return arrayMove(prev, from, to);
      });
    }
  }

  // ── Merge ─────────────────────────────────────────────────────────────────
  async function handleMerge() {
    if (files.length < 2) return;
    setIsProcessing(true);
    setError(null);
    setDownloadUrl(null);

    try {
      const bytes = await mergePdfs(files.map((f) => f.file));
      const blob = new Blob([bytes], { type: "application/pdf" });
      setDownloadUrl(URL.createObjectURL(blob));
    } catch (err) {
      console.error(err);
      setError("Something went wrong. Make sure all files are valid, unlocked PDFs.");
    } finally {
      setIsProcessing(false);
    }
  }

  const totalPages = files.reduce((s, f) => s + (f.pageCount ?? 0), 0);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col bg-white">
      {/* Navbar */}
      <header className="border-b border-gray-100 sticky top-0 z-10 bg-white/90 backdrop-blur">
        <div className="max-w-3xl mx-auto px-6 h-14 flex items-center gap-3 text-sm">
          <Link
            href="/"
            className="flex items-center gap-1.5 transition-colors hover:text-gray-900"
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
        <div className="max-w-3xl mx-auto">
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
            className={`border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-colors mb-5 ${
              isDragActive
                ? "border-[#7A8F4E] bg-[#F5F6F0]"
                : "border-gray-200 bg-[#FAFAF8] hover:border-[#A8BA80] hover:bg-[#F5F6F0]"
            }`}
          >
            <input {...getInputProps()} />
            <UploadCloud
              className="w-8 h-8 mx-auto mb-3 transition-colors"
              style={{ color: isDragActive ? "#5C6B3A" : "#A8BA80" }}
            />
            <p className="text-sm font-medium text-gray-700">
              {isDragActive ? "Drop PDFs here" : "Click or drag & drop PDFs"}
            </p>
            <p className="text-xs mt-1" style={{ color: "#6B7355" }}>
              Add as many files as you need
            </p>
          </div>

          {/* File list */}
          {files.length > 0 && (
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <p
                  className="text-xs font-semibold uppercase tracking-widest"
                  style={{ color: "#A8BA80" }}
                >
                  {files.length} {files.length === 1 ? "file" : "files"}
                  {totalPages > 0 && ` · ${totalPages} pages total`}
                </p>
                <button
                  onClick={() => {
                    setFiles([]);
                    setDownloadUrl(null);
                    setError(null);
                  }}
                  className="text-xs hover:text-red-400 transition-colors"
                  style={{ color: "#A8BA80" }}
                >
                  Remove all
                </button>
              </div>

              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={files.map((f) => f.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="flex flex-col gap-2">
                    {files.map((item, index) => (
                      <SortableItem
                        key={item.id}
                        item={item}
                        index={index}
                        onRemove={(id) => {
                          setFiles((prev) => prev.filter((f) => f.id !== id));
                          setDownloadUrl(null);
                        }}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-100 text-sm text-red-600">
              {error}
            </div>
          )}

          {/* Hint when only 1 file */}
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
