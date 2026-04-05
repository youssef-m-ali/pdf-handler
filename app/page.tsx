import Link from "next/link";
import { OrientalPattern } from "./components/OrientalPattern";
import {
  FileStack,
  Scissors,
  LayoutGrid,
  Minimize2,
  Image,
  Images,
  Stamp,
  Lock,
  FileType,
  ArrowRight,
} from "lucide-react";

// Olive green palette
// primary:   #5C6B3A
// medium:    #7A8F4E
// light:     #A8BA80
// bg tint:   #F5F6F0
// muted text:#6B7355

const tools = [
  { href: "/merge",     icon: FileStack,  label: "Merge PDF",       description: "Combine multiple PDFs into one document." },
  { href: "/split",     icon: Scissors,   label: "Split PDF",       description: "Extract pages or split a PDF at any page." },
  { href: "/organize",  icon: LayoutGrid, label: "Organize Pages",  description: "Reorder, rotate, and delete pages with drag & drop." },
  { href: "/compress",  icon: Minimize2,  label: "Compress PDF",    description: "Reduce file size without losing quality." },
  { href: "/convert/image", icon: Image,  label: "PDF to Image",    description: "Convert each page to PNG or JPEG." },
  { href: "/watermark", icon: Stamp,      label: "Watermark",       description: "Add a text or image watermark to your PDF." },
  { href: "/protect",   icon: Lock,       label: "Protect",         description: "Password-protect a PDF file." },
  { href: "/convert/word",   icon: FileType, label: "PDF to Word",   description: "Convert a PDF to an editable Word document (.docx)." },
  { href: "/extract/images", icon: Images,   label: "Extract Images", description: "Pull all embedded images out of a PDF as a ZIP." },
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white text-gray-900 flex flex-col">

      {/* Navbar */}
      <header className="border-b border-gray-100 sticky top-0 z-10 bg-white/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 font-semibold text-gray-900">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "#5C6B3A" }}>
              <FileStack className="w-3.5 h-3.5 text-white" />
            </div>
            SWFT PDF
          </Link>
          <nav className="flex items-center gap-6 text-sm" style={{ color: "#6B7355" }}>
            <Link href="#tools" className="hover:text-gray-900 transition-colors">Tools</Link>
            <a href="https://github.com" target="_blank" rel="noopener noreferrer" className="hover:text-gray-900 transition-colors">
              GitHub
            </a>
          </nav>
        </div>
      </header>

      <main className="flex-1">

        {/* Hero */}
        <section className="relative pt-24 pb-20 px-6 text-center overflow-hidden" style={{ background: "#F5F6F0" }}>
          {/* Oriental decorative patterns */}
          <div className="pointer-events-none absolute -right-32 top-1/2 -translate-y-1/2 w-[420px] h-[420px] opacity-[0.12]">
            <OrientalPattern className="w-full h-full animate-spin-slow" />
          </div>
          <div className="pointer-events-none absolute -left-32 top-1/2 -translate-y-1/2 w-[300px] h-[300px] opacity-[0.08]">
            <OrientalPattern className="w-full h-full animate-spin-slow-reverse" />
          </div>

          <div className="relative max-w-3xl mx-auto">
            <div
              className="inline-flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-full mb-6 border"
              style={{ background: "#EDF0E6", borderColor: "#C8D4A8", color: "#5C6B3A" }}
            >
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "#7A8F4E" }} />
              Privacy-first · no file storage · free & open source
            </div>
            <h1 className="text-5xl sm:text-6xl font-bold leading-tight mb-5 text-gray-900">
              PDF tools that{" "}
              <span style={{ color: "#5C6B3A" }}>respect your privacy</span>
            </h1>
            <p className="text-lg mb-10 max-w-xl mx-auto leading-relaxed" style={{ color: "#6B7355" }}>
              Merge, split, compress, convert, and edit PDFs.
              Fast, free, and open source — your files are never stored.
            </p>
            <a
              href="#tools"
              className="inline-flex items-center gap-2 text-white font-semibold px-6 py-3 rounded-xl transition-all hover:opacity-90 shadow-md"
              style={{ background: "#5C6B3A" }}
            >
              Pick a tool <ArrowRight className="w-4 h-4" />
            </a>
          </div>
        </section>

        {/* Tool Grid */}
        <section id="tools" className="py-20 px-6 bg-white">
          <div className="max-w-6xl mx-auto">
            <p className="text-xs font-semibold uppercase tracking-widest text-center mb-8" style={{ color: "#A8BA80" }}>
              All tools
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {tools.map(({ href, icon: Icon, label, description }) => (
                <Link
                  key={href}
                  href={href}
                  className="group flex flex-col gap-4 p-5 rounded-2xl border border-gray-100 hover:border-[#C8D4A8] transition-all duration-200 [box-shadow:4px_6px_8px_rgba(0,0,0,0.07)] hover:[box-shadow:4px_6px_12px_rgba(0,0,0,0.12)]"
                  style={{ background: "#FAFAF8" }}
                >
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center"
                    style={{ background: "#EDF0E6" }}
                  >
                    <Icon className="w-5 h-5" style={{ color: "#5C6B3A" }} />
                  </div>
                  <div>
                    <p className="font-semibold text-gray-900 text-sm mb-1 group-hover:transition-colors" style={{}}>
                      {label}
                    </p>
                    <p className="text-xs leading-relaxed" style={{ color: "#6B7355" }}>{description}</p>
                  </div>
                  <ArrowRight
                    className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-all mt-auto"
                    style={{ color: "#C8D4A8" }}
                  />
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Trust strip */}
        <section className="py-14 px-6 border-t border-gray-100" style={{ background: "#F5F6F0" }}>
          <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-center gap-10 sm:gap-20 text-center">
            {[
              { stat: "0",    label: "Files stored on any server" },
              { stat: "0",    label: "Accounts required" },
              { stat: "Free", label: "No limits, no paywalls" },
            ].map(({ stat, label }) => (
              <div key={label} className="flex flex-col gap-1">
                <span className="text-3xl font-bold" style={{ color: "#5C6B3A" }}>{stat}</span>
                <span className="text-sm" style={{ color: "#6B7355" }}>{label}</span>
              </div>
            ))}
          </div>
        </section>

      </main>

      {/* Footer */}
      <footer className="border-t border-gray-100 py-7 px-6 bg-white">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-xs" style={{ color: "#A8BA80" }}>
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded flex items-center justify-center" style={{ background: "#5C6B3A" }}>
              <FileStack className="w-2.5 h-2.5 text-white" />
            </div>
            <span className="font-medium" style={{ color: "#6B7355" }}>SWFT PDF</span>
            <span>— free & open source</span>
          </div>
          <div className="flex items-center gap-5">
            <a href="#" className="hover:text-gray-500 transition-colors">Privacy</a>
            <a href="#" className="hover:text-gray-500 transition-colors">GitHub</a>
            <span>© {new Date().getFullYear()}</span>
          </div>
        </div>
      </footer>

    </div>
  );
}
