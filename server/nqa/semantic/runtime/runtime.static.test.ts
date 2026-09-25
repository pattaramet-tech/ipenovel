import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RUNTIME_DIR = path.resolve(process.cwd(), "server/nqa/semantic/runtime");

function read(name: string): string {
  return fs.readFileSync(path.join(RUNTIME_DIR, name), "utf8");
}

describe("NQA M09A local BGE-M3 runtime", () => {
  it("binds the Python sidecar to loopback only", () => {
    const source = read("bge_m3_sidecar.py");

    expect(source).toContain('HOST = "127.0.0.1"');
    expect(source).not.toContain('HOST = "0.0.0.0"');
    expect(source).not.toContain('HOST = "::"');
  });

  it("pins the exact BGE-M3 model revision used by canonical smoke", () => {
    const source = read("bge_m3_sidecar.py");

    expect(source).toContain('"BAAI/bge-m3"');
    expect(source).toContain('"5617a9f61b028005a4858fdac845db406aefb181"');
    expect(source).toContain("revision=MODEL_REVISION");
  });

  it("uses direct CLS pooling and L2 normalization without sentence-transformers", () => {
    const source = read("bge_m3_sidecar.py");

    expect(source).toContain(".last_hidden_state[:, 0]");
    expect(source).toContain("F.normalize(hidden.float(), p=2, dim=1)");
    expect(source).not.toMatch(/sentence_transformers/i);
  });

  it("caps model input at BGE-M3's 8192-token window", () => {
    const source = read("bge_m3_sidecar.py");

    expect(source).toContain(
      "MAX_LENGTH = min(8192, int(TOKENIZER.model_max_length))"
    );
    expect(source).toContain("truncation=True");
  });

  it("pins the Python installer URL and verified SHA-256", () => {
    const source = read("bootstrap-python311.ps1");

    expect(source).toContain('$Version = "3.11.9"');
    expect(source).toContain("https://www.python.org/ftp/python/");
    expect(source).toContain(
      "5EE42C4EEE1E6B4464BB23722F90B45303F79442DF63083F05322F1785F5FDDE"
    );
    expect(source).toContain("Get-FileHash");
  });

  it("pins the provisioned CUDA/runtime dependency and model versions", () => {
    const source = read("provision.ps1");

    expect(source).toContain("torch==2.9.1");
    expect(source).toContain("https://download.pytorch.org/whl/cu130");
    expect(source).toContain("transformers==5.17.0");
    expect(source).toContain("5617a9f61b028005a4858fdac845db406aefb181");
    expect(source).not.toMatch(/sentence-transformers/i);
  });

  it("starts normal sidecar runtime in Hugging Face offline mode", () => {
    const source = read("start-sidecar.ps1");

    expect(source).toContain('$env:HF_HUB_OFFLINE = "1"');
    expect(source).toContain('$env:TRANSFORMERS_OFFLINE = "1"');
    expect(source).toContain("5617a9f61b028005a4858fdac845db406aefb181");
  });

  it("runs canonical smoke through the M09 TypeScript core", () => {
    const source = read("m09a-smoke.ts");

    expect(source).toContain("LocalHttpEmbeddingProvider");
    expect(source).toContain("searchGlobalSourceChapters");
    expect(source).toContain('"current_corrected"');
    expect(source).toContain('"historical_bad_revision_69"');
  });

  it("does not embed smoke snapshots or model cache inside the repository", () => {
    expect(fs.existsSync(path.join(RUNTIME_DIR, "canonical-197.jsonl"))).toBe(
      false
    );
    expect(fs.existsSync(path.join(RUNTIME_DIR, "hf-cache"))).toBe(false);
  });
});
