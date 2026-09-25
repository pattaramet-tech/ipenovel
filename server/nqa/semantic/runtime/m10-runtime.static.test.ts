import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DIR = path.resolve(process.cwd(), "server/nqa/semantic/runtime");

function read(name: string): string {
  return fs.readFileSync(path.join(DIR, name), "utf8");
}

describe("NQA M10 local reranker runtime", () => {
  it("pins the accepted bge-reranker-v2-m3 revision", () => {
    const sidecar = read("bge_reranker_sidecar.py");
    const provision = read("provision-reranker.ps1");
    const start = read("start-reranker.ps1");
    const revision = "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e";

    expect(sidecar).toContain('"BAAI/bge-reranker-v2-m3"');
    expect(sidecar).toContain(revision);
    expect(provision).toContain(revision);
    expect(start).toContain(revision);
  });

  it("binds the reranker to loopback only", () => {
    const source = read("bge_reranker_sidecar.py");

    expect(source).toContain('HOST = "127.0.0.1"');
    expect(source).not.toContain('HOST = "0.0.0.0"');
    expect(source).not.toContain('HOST = "::"');
  });

  it("normalizes sequence-classification logits into [0,1]", () => {
    const source = read("bge_reranker_sidecar.py");

    expect(source).toContain("AutoModelForSequenceClassification");
    expect(source).toContain("torch.sigmoid");
    expect(source).toContain('self.path != "/rerank"');
  });

  it("bounds pair count and text size", () => {
    const source = read("bge_reranker_sidecar.py");

    expect(source).toContain("MAX_PAIRS");
    expect(source).toContain("MAX_TEXT_CHARS");
    expect(source).toContain("too_many_pairs");
    expect(source).toContain("text_too_large");
  });

  it("starts normal reranker runtime in Hugging Face offline mode", () => {
    const source = read("start-reranker.ps1");

    expect(source).toContain('$env:HF_HUB_OFFLINE = "1"');
    expect(source).toContain('$env:TRANSFORMERS_OFFLINE = "1"');
    expect(source).not.toContain("0.0.0.0");
  });

  it("runs canonical smoke through the M10 TypeScript core", () => {
    const source = read("m10-smoke.ts");

    expect(source).toContain("runSemanticAlignment");
    expect(source).toContain("LocalHttpEmbeddingProvider");
    expect(source).toContain("LocalHttpRerankerProvider");
    expect(source).toContain('"current_corrected"');
    expect(source).toContain('"historical_bad_revision_69"');
  });

  it("does not embed model cache or canonical novel snapshots in repo", () => {
    expect(fs.existsSync(path.join(DIR, "hf-cache"))).toBe(false);
    expect(fs.existsSync(path.join(DIR, "canonical-197.jsonl"))).toBe(false);
  });

  it("contains no paid-model API endpoint or credential marker", () => {
    const source = [
      read("bge_reranker_sidecar.py"),
      read("provision-reranker.ps1"),
      read("start-reranker.ps1"),
    ].join("\n");

    expect(source).not.toMatch(/api\.openai\.com/i);
    expect(source).not.toMatch(/api\.anthropic\.com/i);
    expect(source).not.toMatch(/generativelanguage\.googleapis\.com/i);
    expect(source).not.toMatch(/client_secret|access_token|refresh_token/i);
  });
});
