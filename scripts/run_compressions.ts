// Run with: node --experimental-strip-types scripts/run_compressions.ts <path-to-pdf> [--level=light|balanced|extreme]
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { compressLight, compressBalanced, compressExtreme } from "../lib/compress.ts";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2).filter(a => !a.startsWith("--"));
const flags    = process.argv.slice(2).filter(a =>  a.startsWith("--"));
const inputArg = args[0];
const levelArg = flags.find(f => f.startsWith("--level="))?.split("=")[1] ?? null;

const VALID_LEVELS = ["light", "balanced", "extreme"];

if (!inputArg) {
  console.error("Usage: node --experimental-strip-types scripts/run_compressions.ts <path-to-pdf> [--level=light|balanced|extreme]");
  process.exit(1);
}
if (levelArg && !VALID_LEVELS.includes(levelArg)) {
  console.error(`Unknown level "${levelArg}". Choose from: ${VALID_LEVELS.join(", ")}`);
  process.exit(1);
}

// ─── Output paths ─────────────────────────────────────────────────────────────

const inputPath = path.resolve(inputArg);
const baseName  = path.basename(inputPath, ".pdf");
const outputDir = path.join(path.dirname(inputPath), "../files");

// ─── Run ─────────────────────────────────────────────────────────────────────

function fmt(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
function pct(output: number, input: number) {
  const p = ((output - input) / input * 100).toFixed(1);
  return (p[0] === "-" ? "" : "+") + p + "%";
}

const input     = readFileSync(inputPath);
const inputBytes = new Uint8Array(input);
console.log(`\nInput:  ${inputPath}`);
console.log(`Size:   ${fmt(input.byteLength)}\n`);

const allLevels = [
  { name: "light",    outFile: `${baseName}_jolt_light.pdf`,    fn: () => compressLight(inputBytes)    },
  { name: "balanced", outFile: `${baseName}_jolt_balanced.pdf`, fn: () => compressBalanced(inputBytes) },
  { name: "extreme",  outFile: `${baseName}_jolt_extreme.pdf`,  fn: () => compressExtreme(inputBytes)  },
];
const levels = levelArg ? allLevels.filter(l => l.name === levelArg) : allLevels;

for (const { name, outFile, fn } of levels) {
  process.stdout.write(`  [${name}]    compressing... `);
  const output = await fn();
  writeFileSync(path.join(outputDir, outFile), Buffer.from(output));
  console.log(`${fmt(output.byteLength)} (${pct(output.byteLength, input.byteLength)})  →  ${outFile}`);
}

console.log();
