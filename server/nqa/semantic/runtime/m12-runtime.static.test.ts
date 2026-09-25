import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DIR = path.resolve(process.cwd(), "server/nqa/semantic/runtime");

function read(name: string): string {
  return fs.readFileSync(path.join(DIR, name), "utf8");
}

describe("NQA M12 structured-verification runtime", () => {
  it("reuses the pinned Qwen3-1.7B sidecar on loopback", () => {
    const source = read("qwen_adjudicator_sidecar.py");

    expect(source).toContain('"Qwen/Qwen3-1.7B"');
    expect(source).toContain("70d244cc86ccca08cf5af4e1e306ecf908b1ad5e");
    expect(source).toContain('HOST = "127.0.0.1"');
    expect(source).toContain('"/verify-structure"');
  });

  it("self-identifies the exact runtime source revision", () => {
    const source = read("qwen_adjudicator_sidecar.py");

    expect(source).toContain(
      'STRUCTURE_ENGINE_VERSION = "nqa-structure-runtime-v3"'
    );
    expect(source).toContain("RUNTIME_SOURCE_SHA256");
    expect(source).toContain('"runtime_source_sha256"');
    expect(source).toContain('"structure_engine_version"');
  });

  it("canonicalizes Thai before extracting translation facts", () => {
    const source = read("qwen_adjudicator_sidecar.py");

    expect(source).toContain("THAI_CANONICALIZE_PROMPT");
    expect(source).toContain("canonicalize_translation_text");
    expect(source).toContain("_contains_thai(translation_text)");
    expect(source).toContain(
      "canonical_translation = canonicalize_translation_text("
    );
  });

  it("extracts source and translation facts separately", () => {
    const source = read("qwen_adjudicator_sidecar.py");

    expect(source).toContain("FACT_EXTRACTION_PROMPT");
    expect(source).toContain("def extract_structure_side(");
    expect(source).toContain("source = extract_structure_side(");
    expect(source).toContain("translation = extract_structure_side(");
    expect(source).toContain('"entities": entities');
    expect(source).toContain('"events": events');
  });

  it("compares extracted facts deterministically", () => {
    const source = read("qwen_adjudicator_sidecar.py");

    expect(source).toContain("from difflib import SequenceMatcher");
    expect(source).toContain("def compare_structure_sides(");
    expect(source).toContain("def _entity_matches(");
    expect(source).toContain("def _event_matches(");
    expect(source).toContain("def _greedy_match(");
    expect(source).toContain("def _coverage_status(");
  });

  it("keeps weak/one-sided aligned extraction fail-safe", () => {
    const source = read("qwen_adjudicator_sidecar.py");

    expect(source).toContain(
      "Fact extraction on one bounded side was empty; mismatch is not asserted."
    );
    expect(source).toContain('"INSUFFICIENT"');
  });

  it("requires all five structured dimensions in the TypeScript boundary", () => {
    const source = read("../structure/provider.ts");

    expect(source).toContain("value.length !== 5");
    for (const dimension of [
      "EVENT",
      "ENTITY",
      "RELATIONSHIP",
      "CAUSALITY",
      "CHRONOLOGY",
    ]) {
      expect(source).toContain('"' + dimension + '"');
    }
  });

  it("keeps normal Qwen startup offline", () => {
    const start = read("start-adjudicator.ps1");

    expect(start).toContain('$env:HF_HUB_OFFLINE = "1"');
    expect(start).toContain('$env:TRANSFORMERS_OFFLINE = "1"');
  });

  it("does not add a second Qwen model runtime", () => {
    expect(fs.existsSync(path.join(DIR, "qwen_structure_sidecar.py"))).toBe(
      false
    );
  });

  it("contains no paid general-purpose LLM endpoint", () => {
    const source = read("qwen_adjudicator_sidecar.py");

    expect(source).not.toMatch(/api\.openai\.com/i);
    expect(source).not.toMatch(/api\.anthropic\.com/i);
    expect(source).not.toMatch(/generativelanguage\.googleapis\.com/i);
  });
});
