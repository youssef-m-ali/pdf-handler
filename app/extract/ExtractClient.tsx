"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useDropzone } from "react-dropzone";
import {
  ArrowLeft,
  UploadCloud,
  FileText,
  Download,
  Loader2,
  FileType,
  CheckCircle2,
} from "lucide-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Core functions ───────────────────────────────────────────────────────────

async function convertViaApi(file: File): Promise<Blob> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/pdf-to-word", { method: "POST", body: form });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: "Conversion failed" }));
    throw new Error(error);
  }
  return res.blob();
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ExtractClient() {
  const [file, setFile]                 = useState<File | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [done, setDone]                 = useState(false);
  const [docxBlob, setDocxBlob]         = useState<Blob | null>(null);
  const [docxFilename, setDocxFilename] = useState("");
  const [error, setError]               = useState<string | null>(null);

  const reset = () => { setFile(null); setDone(false); setDocxBlob(null); setError(null); };

  const onDrop = useCallback((accepted: File[]) => {
    if (accepted[0]) { setFile(accepted[0]); setDone(false); setDocxBlob(null); setError(null); }
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
    setDone(false);
    try {
      const name = file.name.replace(/\.pdf$/i, "") + ".docx";
      const blob = await convertViaApi(file);
      setDocxBlob(blob);
      setDocxFilename(name);
      triggerBlobDownload(blob, name);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conversion failed.");
    } finally {
      setIsConverting(false);
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
          <span className="font-medium text-gray-900">PDF to Word</span>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-6 py-12 flex flex-col gap-6">

        {/* Title */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: "#EDF0E6" }}>
              <FileType className="w-4 h-4" style={{ color: "#5C6B3A" }} />
            </div>
            <h1 className="text-xl font-semibold text-gray-900">PDF to Word</h1>
          </div>
          <p className="text-sm pl-[42px]" style={{ color: "#6B7355" }}>
            Convert a PDF to an editable .docx file — runs locally in your browser.
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

        {/* Disclaimer */}
        {file && (
          <p className="text-xs px-3 py-2.5 rounded-xl" style={{ background: "#F5F6F0", color: "#6B7355" }}>
            Text and structure only — images and original formatting are not preserved.
          </p>
        )}

        {/* Error */}
        {error && (
          <div className="px-4 py-3 rounded-xl bg-red-50 border border-red-100 text-sm text-red-600">{error}</div>
        )}

        {/* Success */}
        {done && (
          <div className="flex flex-col gap-4 p-5 rounded-2xl border border-[#C8D4A8]" style={{ background: "#F5F6F0" }}>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5" style={{ color: "#5C6B3A" }} />
              <p className="font-semibold text-gray-900 text-sm">Conversion complete</p>
            </div>
            <button
              onClick={() => docxBlob && triggerBlobDownload(docxBlob, docxFilename)}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-white text-sm"
              style={{ background: "#5C6B3A" }}
            >
              <Download className="w-4 h-4" /> Download again
            </button>
            <button onClick={reset} className="text-xs text-center transition-colors hover:text-gray-700" style={{ color: "#A8BA80" }}>
              Convert another file
            </button>
          </div>
        )}

        {/* Convert button */}
        {file && !done && (
          <button
            onClick={handleConvert}
            disabled={isConverting}
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-semibold text-white disabled:opacity-60 transition-opacity text-sm"
            style={{ background: "#5C6B3A" }}
          >
            {isConverting ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Converting…</>
            ) : (
              <><FileType className="w-4 h-4" /> Convert to Word</>
            )}
          </button>
        )}

      </main>
    </div>
  );
}
