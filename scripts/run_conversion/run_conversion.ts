// Run with: node --experimental-strip-types scripts/run_conversion.ts <path-to-pdf>
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { convertPdfToDocx } from "../../lib/convert.ts";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const inputArg = process.argv.slice(2).find(a => !a.startsWith("--"));

if (!inputArg) {
  console.error("Usage: node --experimental-strip-types scripts/run_conversion.ts <path-to-pdf>");
  process.exit(1);
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const inputPath = path.resolve(inputArg);
const baseName  = path.basename(inputPath, ".pdf");
const outputDir = path.dirname(inputPath);
const outputPath = path.join(outputDir, `${baseName}.docx`);

console.log(`\nInput:  ${inputPath}`);

const pdfBuf  = readFileSync(inputPath);
const docxBuf = await convertPdfToDocx(pdfBuf);

writeFileSync(outputPath, docxBuf);
console.log(`Output: ${outputPath}`);
console.log(`Size:   ${(docxBuf.byteLength / 1024).toFixed(1)} KB\n`);
