import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DIR = path.resolve(process.cwd(), "server/nqa/semantic/runtime");

function read(name: string): string {
  return fs.readFileSync(path.join(DIR, name), "utf8");
}

describe("NQA M11 local adjudicator runtime", () => {
  it("pins the accepted Qwen3-1.7B revision", () => {
    const sidecar = read("qwen_adjudicator_sidecar.py");
    const provision = read("provision-adjudicator.ps1");
    const start = read("start-adjudicator.ps1");
    const revision = "70d244cc86ccca08cf5af4e1e306ecf908b1ad5e";

    expect(sidecar).toContain('"Qwen/Qwen3-1.7B"');
    expect(sidecar).toContain(revision);
    expect(provision).toContain(revision);
    expect(start).toContain(revision);
  });

  it("binds only to loopback", () => {
    const sidecar = read("qwen_adjudicator_sidecar.py");

    expect(sidecar).toContain('HOST = "127.0.0.1"');
    expect(sidecar).not.toContain('HOST = "0.0.0.0"');
    expect(sidecar).not.toContain('HOST = "::"');
  });

  it("bounds request/input/output size", () => {
    const sidecar = read("qwen_adjudicator_sidecar.py");

    expect(sidecar).toContain("MAX_BODY_BYTES");
    expect(sidecar).toContain("MAX_INPUT_TOKENS");
    expect(sidecar).toContain("MAX_NEW_TOKENS");
    expect(sidecar).toContain("request_body_out_of_bounds");
  });

  it("uses deterministic local generation and schema validation", () => {
    const sidecar = read("qwen_adjudicator_sidecar.py");

    expect(sidecar).toContain("do_sample=False");
    expect(sidecar).toContain("enable_thinking=False");
    expect(sidecar).toContain("ALLOWED_DECISIONS");
    expect(sidecar).toContain("ALLOWED_REASONS");
    expect(sidecar).toContain("validate_result");
  });

  it("starts normal runtime in Hugging Face offline mode", () => {
    const start = read("start-adjudicator.ps1");

    expect(start).toContain('$env:HF_HUB_OFFLINE = "1"');
    expect(start).toContain('$env:TRANSFORMERS_OFFLINE = "1"');
    expect(start).not.toContain("0.0.0.0");
  });

  it("contains no paid-model endpoint or credential marker", () => {
    const source = [
      read("qwen_adjudicator_sidecar.py"),
      read("provision-adjudicator.ps1"),
      read("start-adjudicator.ps1"),
    ].join("\n");

    expect(source).not.toMatch(/api\.openai\.com/i);
    expect(source).not.toMatch(/api\.anthropic\.com/i);
    expect(source).not.toMatch(/generativelanguage\.googleapis\.com/i);
    expect(source).not.toMatch(/client_secret|access_token|refresh_token/i);
  });

  it("does not place model cache in the repository", () => {
    expect(fs.existsSync(path.join(DIR, "hf-cache"))).toBe(false);
  });
});
