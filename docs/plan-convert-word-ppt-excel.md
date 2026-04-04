# Plan: PDF → Word / PPT / Excel Converters

## Context
M2 includes three document conversion features. The server-side PDF→Word API already exists (`app/api/pdf-to-word/route.ts`) but has no client-side page. PPT and Excel need new libraries, API routes, and client pages. All three follow the same simple UX pattern: drop PDF → click convert → download result. Implementation order: Word → PPT → Excel.

---

## Architecture

All three use the **server-side API route** pattern (client POSTs FormData, gets file back):
- Server uses `pdfjs-dist` (Node.js, worker disabled) to extract text per page
- Server builds the output document with a library
- Client is a simple dropzone → button → download (no settings, no page selection)
- Matches styling of existing tools (olive green palette, rounded cards, same navbar pattern)

---

## Step 1: PDF → Word

**The API already exists.** Only the client page needs to be built.

### Files to create
- `app/convert/word/page.tsx` — server component with metadata
- `app/convert/word/WordClient.tsx` — client component

### WordClient.tsx flow
1. Dropzone (single PDF, `react-dropzone`)
2. "Convert to Word" button → POST `FormData({ file })` to `/api/pdf-to-word`
3. Receive DOCX blob → trigger download as `${baseName}.docx`
4. Result state shows filename + download button

### Reuse from existing code
- Dropzone UI pattern: `app/convert/image/ConvertClient.tsx` (file info bar, dropzone styling)
- `triggerBlobDownload()` pattern from `app/extract/ExtractClient.tsx`
- `formatBytes()` inline helper (copy from any existing component)

---

## Step 2: PDF → PPT

### Install
```
npm install pptxgenjs
```

### Files to create
- `app/api/pdf-to-ppt/route.ts` — server route
- `app/convert/ppt/page.tsx`
- `app/convert/ppt/PptClient.tsx`

### API route logic
1. Extract text per page with `pdfjs-dist` (same pattern as `pdf-to-word` route lines 14–32)
2. Create presentation with `pptxgenjs` — one slide per page
   - First non-empty line → slide title
   - Remaining text → body text box
   - Slide dimensions: 10" × 7.5" (standard widescreen)
3. Return `.pptx` buffer

Content-Type: `application/vnd.openxmlformats-officedocument.presentationml.presentation`

### PptClient.tsx
Same flow as WordClient — drop PDF → convert → download `${baseName}.pptx`.

---

## Step 3: PDF → Excel

### Install
```
npm install exceljs
```

### Files to create
- `app/api/pdf-to-excel/route.ts` — server route
- `app/convert/excel/page.tsx`
- `app/convert/excel/ExcelClient.tsx`

### API route logic
1. Extract text per page with `pdfjs-dist`
2. Create workbook with `exceljs` — one worksheet per page ("Page 1", "Page 2", …)
   - Split page text by newline → each line goes in column A
   - Auto-size column A (cap at 100)
3. Return `.xlsx` buffer

Content-Type: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`

### ExcelClient.tsx
Same flow — drop PDF → convert → download `${baseName}.xlsx`.

---

## Homepage update

After all three converters are built, update `app/page.tsx` to add tool cards for:
- `/convert/word`
- `/convert/ppt`
- `/convert/excel`

---

## Critical files

| File | Status |
|------|--------|
| `app/api/pdf-to-word/route.ts` | ✅ Exists — no changes needed |
| `app/convert/image/ConvertClient.tsx` | Reference only (UI patterns) |
| `app/convert/word/page.tsx` | Create |
| `app/convert/word/WordClient.tsx` | Create |
| `app/api/pdf-to-ppt/route.ts` | Create |
| `app/convert/ppt/page.tsx` | Create |
| `app/convert/ppt/PptClient.tsx` | Create |
| `app/api/pdf-to-excel/route.ts` | Create |
| `app/convert/excel/page.tsx` | Create |
| `app/convert/excel/ExcelClient.tsx` | Create |
| `app/page.tsx` | Update — add 3 tool cards |
| `package.json` | Add `pptxgenjs`, `exceljs` |

---

## Verification

1. `npm run dev` — no build errors
2. Upload a multi-page text PDF to `/convert/word` → valid DOCX with text per page
3. Same PDF to `/convert/ppt` → valid PPTX with one slide per page
4. Same PDF to `/convert/excel` → valid XLSX with one sheet per page
5. Edge case: image-only PDF (no extractable text) → file still generates with `[No text on this page]` placeholder, no crash
