#!/usr/bin/env node
// Read-only bundle size report for the production frontend build
// (dist/public, produced by `pnpm build`'s `vite build` step).
//
// Reads dist/public/index.html to find which JS/CSS files it actually
// references (the "initial entry" - what a fresh page load must download
// before anything else), then reports every .js/.css file under
// dist/public/assets with raw/gzip/Brotli sizes, largest first, plus
// totals. Never calls any external service - gzip/Brotli sizes are
// computed locally via Node's built-in zlib, matching how a real HTTP
// response would be compressed, not measured by uploading anywhere.
//
// Usage: node scripts/report-build-size.mjs   (or `pnpm analyze:bundle`)

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const distPublicDir = path.join(repoRoot, "dist", "public");
const assetsDir = path.join(distPublicDir, "assets");
const indexHtmlPath = path.join(distPublicDir, "index.html");

function fail(message) {
  console.error(`[analyze:bundle] ${message}`);
  process.exitCode = 1;
}

if (!fs.existsSync(distPublicDir)) {
  fail(`dist/public was not found at "${distPublicDir}". Run \`pnpm build\` first.`);
  process.exit(1);
}

if (!fs.existsSync(indexHtmlPath)) {
  fail(`dist/public/index.html was not found. Run \`pnpm build\` first (or re-run it if the build is stale/partial).`);
  process.exit(1);
}

if (!fs.existsSync(assetsDir)) {
  fail(`dist/public/assets was not found. Run \`pnpm build\` first (or re-run it if the build is stale/partial).`);
  process.exit(1);
}

const indexHtml = fs.readFileSync(indexHtmlPath, "utf-8");

/** Local (same-origin, under /assets/) file names referenced directly by index.html - the initial entry. */
function findInitialEntryFileNames(html) {
  const names = new Set();
  // <script ... src="/assets/xxx.js" ...> (module entry) and
  // <link ... href="/assets/xxx.css" ...> (stylesheet) - matches either
  // attribute order since Vite/plugins may emit attributes in either order.
  const tagPattern = /<(script|link)\b[^>]*>/gi;
  const srcOrHrefPattern = /\b(?:src|href)="([^"]+)"/i;
  for (const [tag] of html.matchAll(tagPattern)) {
    const match = tag.match(srcOrHrefPattern);
    if (!match) continue;
    const url = match[1];
    if (!url.startsWith("/assets/")) continue; // external (fonts, dev-only debug collector, etc.) or non-asset path
    names.add(path.posix.basename(url));
  }
  return names;
}

const initialEntryFileNames = findInitialEntryFileNames(indexHtml);

function gzipSize(buffer) {
  return zlib.gzipSync(buffer, { level: zlib.constants.Z_BEST_COMPRESSION }).length;
}

function brotliSize(buffer) {
  return zlib.brotliCompressSync(buffer, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY },
  }).length;
}

function formatBytes(n) {
  return `${n.toLocaleString("en-US")} B`;
}

function formatKB(n) {
  return `${(n / 1024).toFixed(2)} kB`;
}

const allFiles = fs
  .readdirSync(assetsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".css")))
  .map((entry) => entry.name);

if (allFiles.length === 0) {
  fail(`No .js/.css files found under "${assetsDir}". Run \`pnpm build\` first (or re-run it if the build is stale/partial).`);
  process.exit(1);
}

const rows = allFiles.map((name) => {
  const filePath = path.join(assetsDir, name);
  const buffer = fs.readFileSync(filePath);
  return {
    name,
    isInitialEntry: initialEntryFileNames.has(name),
    raw: buffer.length,
    gzip: gzipSize(buffer),
    brotli: brotliSize(buffer),
  };
});

rows.sort((a, b) => b.raw - a.raw);

console.log(`\n[analyze:bundle] dist/public/assets - ${rows.length} file(s), largest first\n`);

const nameWidth = Math.max(...rows.map((r) => r.name.length), "file".length) + 2;
console.log(
  `${"file".padEnd(nameWidth)}${"raw".padStart(12)}${"gzip".padStart(12)}${"brotli".padStart(12)}  initial entry?`
);
for (const row of rows) {
  console.log(
    `${row.name.padEnd(nameWidth)}${formatBytes(row.raw).padStart(12)}${formatBytes(row.gzip).padStart(12)}${formatBytes(row.brotli).padStart(12)}  ${row.isInitialEntry ? "yes" : ""}`
  );
}

const totals = rows.reduce(
  (acc, r) => ({ raw: acc.raw + r.raw, gzip: acc.gzip + r.gzip, brotli: acc.brotli + r.brotli }),
  { raw: 0, gzip: 0, brotli: 0 }
);
const initialRows = rows.filter((r) => r.isInitialEntry);
const initialTotals = initialRows.reduce(
  (acc, r) => ({ raw: acc.raw + r.raw, gzip: acc.gzip + r.gzip, brotli: acc.brotli + r.brotli }),
  { raw: 0, gzip: 0, brotli: 0 }
);
const jsRows = rows.filter((r) => r.name.endsWith(".js"));
const jsTotalRaw = jsRows.reduce((sum, r) => sum + r.raw, 0);

console.log(
  `\n[analyze:bundle] TOTAL (all ${rows.length} files): raw ${formatKB(totals.raw)}, gzip ${formatKB(totals.gzip)}, brotli ${formatKB(totals.brotli)}`
);
console.log(
  `[analyze:bundle] INITIAL ENTRY (${initialRows.length} file(s) referenced directly by index.html): raw ${formatKB(initialTotals.raw)}, gzip ${formatKB(initialTotals.gzip)}, brotli ${formatKB(initialTotals.brotli)}`
);
console.log(`[analyze:bundle] JS total raw across all ${jsRows.length} chunk(s) (initial + dynamic): ${formatKB(jsTotalRaw)}`);
if (initialRows.length === 0) {
  console.warn(
    "[analyze:bundle] WARNING: could not identify any initial entry file from index.html - the report above is still accurate per-file, but the INITIAL ENTRY line could not be computed."
  );
}
