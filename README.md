# Bolt PDF

Free PDF tools that run entirely in your browser. Merge, split, reorder, compress, convert, watermark, protect, and extract text from PDFs — no uploads, no sign-up, no cost.

## Features

- **Merge** — combine multiple PDFs into one
- **Split** — extract pages or split at a page number
- **Organize** — drag & drop to reorder, rotate, or delete pages
- **Compress** — reduce file size without losing quality
- **PDF to Image** — export pages as PNG or JPEG
- **Watermark** — add text or image watermarks
- **Protect / Unlock** — password-protect or unlock PDFs
- **Extract Text** — pull text content out of any PDF

## Privacy

All processing happens client-side using [pdf-lib](https://pdf-lib.js.org/) and [PDF.js](https://mozilla.github.io/pdf.js/). Your files never leave your device.

## Tech Stack

- [Next.js 15](https://nextjs.org/) (App Router)
- [pdf-lib](https://pdf-lib.js.org/) — PDF manipulation in the browser
- [pdfjs-dist](https://mozilla.github.io/pdf.js/) — page thumbnail rendering
- [@dnd-kit](https://dndkit.com/) — drag and drop
- [Tailwind CSS](https://tailwindcss.com/) — styling
- [Zustand](https://zustand-demo.pmnd.rs/) — state management

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

