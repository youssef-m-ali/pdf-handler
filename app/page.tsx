import Link from "next/link";
import {
  FileStack,
  Scissors,
  LayoutGrid,
  Minimize2,
  Image,
  Stamp,
  Lock,
  FileText,
  ShieldCheck,
  Zap,
  Laptop,
  ArrowRight,
  Github,
} from "lucide-react";

const tools = [
  {
    href: "/merge",
    icon: FileStack,
    label: "Merge PDF",
    description: "Combine multiple PDFs into one document.",
    color: "bg-blue-50 text-blue-600",
    border: "hover:border-blue-200",
  },
  {
    href: "/split",
    icon: Scissors,
    label: "Split PDF",
    description: "Extract pages or split a PDF at any page.",
    color: "bg-orange-50 text-orange-600",
    border: "hover:border-orange-200",
  },
  {
    href: "/organize",
    icon: LayoutGrid,
    label: "Organize Pages",
    description: "Reorder, rotate, and delete pages with drag & drop.",
    color: "bg-violet-50 text-violet-600",
    border: "hover:border-violet-200",
  },
  {
    href: "/compress",
    icon: Minimize2,
    label: "Compress PDF",
    description: "Reduce file size without losing quality.",
    color: "bg-green-50 text-green-600",
    border: "hover:border-green-200",
  },
  {
    href: "/convert",
    icon: Image,
    label: "PDF to Image",
    description: "Convert each page to PNG or JPEG.",
    color: "bg-pink-50 text-pink-600",
    border: "hover:border-pink-200",
  },
  {
    href: "/watermark",
    icon: Stamp,
    label: "Watermark",
    description: "Add a text or image watermark to your PDF.",
    color: "bg-yellow-50 text-yellow-600",
    border: "hover:border-yellow-200",
  },
  {
    href: "/protect",
    icon: Lock,
    label: "Protect & Unlock",
    description: "Password-protect or unlock a PDF file.",
    color: "bg-red-50 text-red-600",
    border: "hover:border-red-200",
  },
  {
    href: "/extract",
    icon: FileText,
    label: "Extract Text",
    description: "Pull all text content out of any PDF.",
    color: "bg-teal-50 text-teal-600",
    border: "hover:border-teal-200",
  },
];

const features = [
  {
    icon: ShieldCheck,
    title: "Your files stay on your device",
    description:
      "All processing happens in your browser. We never upload, store, or see your files.",
  },
  {
    icon: Zap,
    title: "Fast and free",
    description:
      "No sign-up, no watermarks, no limits. Just pick a tool and go.",
  },
  {
    icon: Laptop,
    title: "Works everywhere",
    description:
      "Any browser, any OS. No software to install, no plugins required.",
  },
];

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Navbar */}
      <header className="border-b border-gray-100 sticky top-0 bg-white/80 backdrop-blur z-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 font-semibold text-gray-900">
            <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center">
              <FileStack className="w-4 h-4 text-white" />
            </div>
            PDFriend
          </Link>
          <nav className="flex items-center gap-6 text-sm text-gray-500">
            <Link href="#tools" className="hover:text-gray-900 transition-colors">
              Tools
            </Link>
            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-gray-900 transition-colors"
            >
              <Github className="w-4 h-4" />
            </a>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="pt-20 pb-16 px-4 sm:px-6 text-center">
          <div className="max-w-3xl mx-auto">
            <div className="inline-flex items-center gap-2 bg-blue-50 text-blue-700 text-xs font-medium px-3 py-1.5 rounded-full mb-6">
              <ShieldCheck className="w-3.5 h-3.5" />
              Files never leave your browser
            </div>
            <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 leading-tight mb-4">
              Free PDF tools,{" "}
              <span className="text-blue-600">right in your browser</span>
            </h1>
            <p className="text-lg text-gray-500 mb-10 max-w-xl mx-auto">
              Merge, split, compress, and edit PDFs without uploading anything.
              Everything runs locally — fast, private, and completely free.
            </p>
            <a
              href="#tools"
              className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium px-6 py-3 rounded-xl transition-colors"
            >
              Get started <ArrowRight className="w-4 h-4" />
            </a>
          </div>
        </section>

        {/* Tool Grid */}
        <section id="tools" className="pb-20 px-4 sm:px-6">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest text-center mb-8">
              All tools
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {tools.map(({ href, icon: Icon, label, description, color, border }) => (
                <Link
                  key={href}
                  href={href}
                  className={`group flex flex-col gap-3 p-5 rounded-2xl border border-gray-100 bg-white hover:shadow-md transition-all duration-200 ${border}`}
                >
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${color}`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="font-semibold text-gray-900 text-sm mb-0.5 group-hover:text-blue-600 transition-colors">
                      {label}
                    </p>
                    <p className="text-xs text-gray-500 leading-relaxed">{description}</p>
                  </div>
                  <ArrowRight className="w-3.5 h-3.5 text-gray-300 group-hover:text-blue-500 group-hover:translate-x-0.5 transition-all mt-auto" />
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Features / Trust strip */}
        <section className="border-t border-gray-100 py-16 px-4 sm:px-6 bg-gray-50">
          <div className="max-w-5xl mx-auto grid grid-cols-1 sm:grid-cols-3 gap-10">
            {features.map(({ icon: Icon, title, description }) => (
              <div key={title} className="flex flex-col items-center text-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-white border border-gray-200 flex items-center justify-center shadow-sm">
                  <Icon className="w-5 h-5 text-gray-700" />
                </div>
                <h3 className="font-semibold text-gray-900 text-sm">{title}</h3>
                <p className="text-xs text-gray-500 leading-relaxed">{description}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-100 py-8 px-4 sm:px-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-gray-400">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-blue-600 flex items-center justify-center">
              <FileStack className="w-3 h-3 text-white" />
            </div>
            <span className="font-medium text-gray-600">PDFriend</span>
            <span>— free & open source</span>
          </div>
          <div className="flex items-center gap-5">
            <a href="#" className="hover:text-gray-600 transition-colors">Privacy</a>
            <a href="#" className="hover:text-gray-600 transition-colors">GitHub</a>
            <span>© {new Date().getFullYear()}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
