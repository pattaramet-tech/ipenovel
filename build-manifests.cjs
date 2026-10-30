const { execSync } = require("child_process");
const fs = require("fs");
const crypto = require("crypto");
// NOTE: never .trim() the whole command output — the first porcelain line
// legitimately starts with a space (" M path") and trimming it shifts the
// fixed-column slice. Strip BOM once, then handle \r per line.
function sh(c) {
  return execSync(c, { encoding: "utf8" }).replace(/^\uFEFF/, "");
}
function safeDiff(cmd) {
  try { return execSync(cmd, { cwd: process.cwd(), maxBuffer: 1024 * 1024 * 64 }).toString(); }
  catch (e) { return (e.stdout || "").toString(); }
}
const status = sh("git status --porcelain")
  .split("\n")
  .map(l => l.replace(/\r$/, ""))
  .filter(Boolean)
  .map(l => ({ state: l.slice(0, 2).trim(), path: l.slice(3).split("\\").join("/").trim() }));
const changed = new Map(status.map(s => [s.path, s.state]));
const tracked = sh("git ls-files").split("\n").map(l => l.replace(/\r$/, "")).filter(Boolean);
const untracked = sh("git ls-files --others --exclude-standard").split("\n").map(l => l.replace(/\r$/, "")).filter(Boolean);
const all = [...new Set([...tracked, ...untracked])].sort();
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");
function gitBlob(buf) {
  // normalized git blob (LF) — matches `git hash-object` of the LF form
  return execSync("git hash-object --stdin", { input: Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n")) }).toString().trim();
}
const rows = [];
const changedRows = [];
for (const p of all) {
  let buf;
  try { buf = fs.readFileSync(p); } catch { continue; }
  const rawBlob = execSync("git hash-object --stdin", { input: buf }).toString().trim();
  const normBlob = gitBlob(buf);
  const st = changed.has(p) ? (changed.get(p) === "??" ? "untracked" : "modified") : "unchanged";
  const bin = buf.toString("binary");
  const eolCRLF = (bin.match(/\r\n/g) || []).length;
  const eolLF = (bin.match(/(^|[^\r])\n/g) || []).length;
  rows.push(`${p}\t${st}\t${buf.length}\t${normBlob}`);
  if (st !== "unchanged") {
    changedRows.push(`${p}\t${st}\t${buf.length}\t${sha256(buf)}\traw=${rawBlob}\tnorm=${normBlob}\tCRLF=${eolCRLF},LF=${eolLF}`);
  }
}
fs.writeFileSync("C:/ai-workspace/reader-session-controls-evidence/r4r8-manifest-full-dedup.tsv", rows.join("\n") + "\n");
fs.writeFileSync("C:/ai-workspace/reader-session-controls-evidence/r4r8-manifest-changed.tsv", "path\tstate\tbytes\tsha256(raw)\traw-blob\tnormalized-blob\tEOL\n" + changedRows.join("\n") + "\n");
console.log("full(uniq)=", rows.length, "changed=", changedRows.length);
if (!changedRows.some(r => r.includes("App.tsx"))) throw new Error("App.tsx missing!");
