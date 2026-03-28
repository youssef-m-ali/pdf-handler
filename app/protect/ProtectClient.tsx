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
  Lock,
  Eye,
  EyeOff,
  CheckCircle2,
} from "lucide-react";

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

async function protectPdf(
  file: File,
  userPassword: string,
  ownerPassword: string,
  allowPrinting: boolean,
  allowCopying: boolean,
): Promise<Uint8Array> {
  const { default: Module } = await import("@jspawn/ghostscript-wasm");
  const gs = await Module({
    locateFile: (path: string) =>
      `https://cdn.jsdelivr.net/npm/@jspawn/ghostscript-wasm@0.0.2/${path}`,
  });

  const buf = await file.arrayBuffer();
  gs.FS.writeFile("/input.pdf", new Uint8Array(buf));

  // PDF permission bits: 4 = print, 2048 = high-res print, 16 = copy
  let permissions = 0;
  if (allowPrinting) permissions |= 4 | 2048;
  if (allowCopying)  permissions |= 16;

  gs.callMain([
    "-sDEVICE=pdfwrite",
    "-dNOPAUSE",
    "-dQUIET",
    "-dBATCH",
    `-sOwnerPassword=${ownerPassword || userPassword}`,
    `-sUserPassword=${userPassword}`,
    "-dEncryptionR=3",
    "-dKeyLength=128",
    `-dPermissions=${permissions}`,
    "-sOutputFile=/output.pdf",
    "/input.pdf",
  ]);

  return gs.FS.readFile("/output.pdf");
}

// ─── Password input ───────────────────────────────────────────────────────────

function PasswordInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "#A8BA80" }}>
        {label}
      </p>
      <div className="relative">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full px-3.5 py-2.5 pr-10 text-sm rounded-xl border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-[#7A8F4E]/20 focus:border-[#A8BA80] transition-colors"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
          style={{ color: "#A8BA80" }}
        >
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ProtectClient() {
  const [file, setFile]               = useState<File | null>(null);
  const [userPassword, setUserPassword]   = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [allowPrinting, setAllowPrinting] = useState(true);
  const [allowCopying, setAllowCopying]   = useState(false);
  const [isProcessing, setIsProcessing]   = useState(false);
  const [result, setResult]               = useState<Uint8Array | null>(null);
  const [error, setError]                 = useState<string | null>(null);

  const reset = () => {
    setFile(null); setResult(null); setError(null);
    setUserPassword(""); setOwnerPassword("");
  };

  const onDrop = useCallback((accepted: File[]) => {
    if (accepted[0]) { setFile(accepted[0]); setResult(null); setError(null); }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: false,
  });

  const handleSubmit = async () => {
    if (!file) return;
    setIsProcessing(true);
    setError(null);
    setResult(null);
    try {
      const bytes = await protectPdf(file, userPassword, ownerPassword, allowPrinting, allowCopying);
      setResult(bytes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
          <span className="font-medium text-gray-900">Protect PDF</span>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-6 py-12 flex flex-col gap-6">

        {/* Title */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: "#EDF0E6" }}>
              <Lock className="w-4 h-4" style={{ color: "#5C6B3A" }} />
            </div>
            <h1 className="text-xl font-semibold text-gray-900">Protect PDF</h1>
          </div>
          <p className="text-sm pl-[42px]" style={{ color: "#6B7355" }}>
            Password-protect a PDF with custom permissions.
          </p>
        </div>

        {/* Dropzone / file bar */}
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
            <button onClick={reset} className="text-xs transition-colors hover:text-gray-600" style={{ color: "#A8BA80" }}>Change</button>
          </div>
        )}

        {/* Settings */}
        {file && !result && (
          <div className="flex flex-col gap-5">
            <PasswordInput
              label="Password"
              value={userPassword}
              onChange={setUserPassword}
              placeholder="Enter a password"
            />
            <PasswordInput
              label="Owner password (optional)"
              value={ownerPassword}
              onChange={setOwnerPassword}
              placeholder="Defaults to the same password"
            />

            {/* Permissions */}
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "#A8BA80" }}>
                Permissions for readers
              </p>
              {[
                { label: "Allow printing",     value: allowPrinting, set: setAllowPrinting },
                { label: "Allow copying text", value: allowCopying,  set: setAllowCopying  },
              ].map(({ label, value, set }) => (
                <label key={label} className="flex items-center gap-3 cursor-pointer select-none">
                  <div
                    onClick={() => set(!value)}
                    className={`w-9 h-5 rounded-full transition-colors flex items-center px-0.5 ${value ? "" : "bg-gray-200"}`}
                    style={value ? { background: "#5C6B3A" } : {}}
                  >
                    <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${value ? "translate-x-4" : "translate-x-0"}`} />
                  </div>
                  <span className="text-sm text-gray-700">{label}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="px-4 py-3 rounded-xl bg-red-50 border border-red-100 text-sm text-red-600">{error}</div>
        )}

        {/* Result */}
        {result && (
          <div className="flex flex-col gap-4 p-5 rounded-2xl border border-[#C8D4A8]" style={{ background: "#F5F6F0" }}>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5" style={{ color: "#5C6B3A" }} />
              <p className="font-semibold text-gray-900 text-sm">PDF protected</p>
            </div>
            <button
              onClick={() => triggerDownload(result, file!.name.replace(/\.pdf$/i, "") + "_protected.pdf")}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-white text-sm"
              style={{ background: "#5C6B3A" }}
            >
              <Download className="w-4 h-4" />
              Download protected PDF
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
            onClick={handleSubmit}
            disabled={isProcessing || userPassword.length === 0}
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-semibold text-white disabled:opacity-40 transition-opacity text-sm cursor-pointer disabled:cursor-not-allowed"
            style={{ background: "#5C6B3A" }}
          >
            {isProcessing ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Protecting…</>
            ) : (
              <><Lock className="w-4 h-4" /> Protect PDF</>
            )}
          </button>
        )}

      </main>
    </div>
  );
}
