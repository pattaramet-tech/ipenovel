import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  categorizeOcrFailure,
  describeProviderFailure,
  summarizeRootCause,
} from "./ocrDiagnosticsService";
import { sanitizeSnapshot } from "./ocrAttemptService";
import { LLMInvokeError } from "../_core/llm";

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Admin Recheck: structural guarantees ─────────────────────────────────

/**
 * The recheck endpoint's core promise is what it CANNOT do. These assert on
 * the module source because the guarantee is the absence of a call - a
 * behavioral test can only show that approval did not happen for the inputs
 * it tried, whereas this fails the moment approval is wired in at all.
 */
describe("Admin Recheck OCR cannot approve or reject", () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "server/services/ocrRecheckService.ts"),
    "utf-8"
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  it("never calls approvePayment()", () => {
    expect(code).not.toMatch(/\bapprovePayment\s*\(/);
  });

  it("never calls rejectPayment()", () => {
    expect(code).not.toMatch(/\brejectPayment\s*\(/);
  });

  it("never calls ApprovalService", () => {
    expect(code).not.toMatch(/ApprovalService/);
  });

  it("never calls claimSlip() - approving is the only thing that may claim", () => {
    expect(code).not.toMatch(/\bclaimSlip\s*\(/);
  });

  it("never writes a status field", () => {
    expect(code).not.toMatch(/status\s*:\s*["'`](approved|rejected|pending)["'`]/);
  });

  it("never WRITES slipSubmittedAt - the original submission time is evidence", () => {
    // Reading it is mandatory (freshness is measured from the customer's real
    // submission time, never from "now"), so this targets writes only: any
    // occurrence inside a db.updatePayment(...) payload.
    const updateCalls = code.match(/updatePayment\([\s\S]*?\}\)/g) ?? [];
    for (const call of updateCalls) {
      expect(call).not.toMatch(/slipSubmittedAt/);
    }
  });

  it("passes the ORIGINAL slipSubmittedAt into verification, never a fresh Date", () => {
    // The freshness window must still be judged against when the customer
    // actually submitted; using `new Date()` here would make every stale slip
    // look fresh on recheck.
    expect(code).toMatch(/slipSubmittedAt:\s*payment\.slipSubmittedAt/);
  });

  it("never calls submitPaymentSlip(), which would reset slipSubmittedAt", () => {
    expect(code).not.toMatch(/\bsubmitPaymentSlip\s*\(/);
  });

  it("never calls updateOrder()", () => {
    expect(code).not.toMatch(/\bupdateOrder\s*\(/);
  });

  it("every payment write is conditional and names display columns explicitly", () => {
    // Writes now go through the compare-and-set helper so a late recheck can
    // never mutate finalized evidence; none may carry status/slipSubmittedAt.
    const updateCalls = code.match(/updatePaymentIfNotFinalized\([\s\S]*?\}\)/g) ?? [];
    expect(updateCalls.length).toBeGreaterThan(0);
    for (const call of updateCalls) {
      expect(call).not.toMatch(/\bstatus\b/);
      expect(call).not.toMatch(/slipSubmittedAt/);
    }
    // No unconditional write remains.
    expect(code).not.toMatch(/db\.updatePayment\(/);
  });

  it("reports readyForAdminApproval instead of approving", () => {
    expect(code).toMatch(/readyForAdminApproval/);
  });
});

// ─── Provider diagnostics ─────────────────────────────────────────────────

describe("describeProviderFailure - technical vs data", () => {
  it("HTTP 503 exhausted after 3 attempts is PROVIDER_RETRY_EXHAUSTED", () => {
    const d = describeProviderFailure(new LLMInvokeError(503, "generic"), 3);
    expect(d.code).toBe("PROVIDER_RETRY_EXHAUSTED");
    expect(d.providerHttpStatus).toBe(503);
    expect(d.providerAttemptCount).toBe(3);
    expect(categorizeOcrFailure(d.code)).toBe("TECHNICAL");
  });

  it("a single HTTP 503 is a transient error, not retry-exhausted", () => {
    expect(describeProviderFailure(new LLMInvokeError(503, "generic"), 1).code).toBe(
      "PROVIDER_TRANSIENT_ERROR"
    );
  });

  it("HTTP 429 is rate limiting", () => {
    expect(describeProviderFailure(new LLMInvokeError(429, "generic"), 1).code).toBe(
      "PROVIDER_RATE_LIMIT"
    );
  });

  it("HTTP 401 is an auth/config error, clearly not the slip's fault", () => {
    const d = describeProviderFailure(new LLMInvokeError(401, "generic"), 1);
    expect(d.code).toBe("PROVIDER_AUTH_ERROR");
    expect(d.message).toMatch(/configuration problem/i);
    expect(d.message).toMatch(/not a problem with the slip/i);
  });

  it("HTTP 400 is a bad request", () => {
    expect(describeProviderFailure(new LLMInvokeError(400, "generic"), 1).code).toBe(
      "PROVIDER_BAD_REQUEST"
    );
  });

  it("HTTP 504 is a timeout", () => {
    expect(describeProviderFailure(new LLMInvokeError(504, "generic"), 1).code).toBe(
      "PROVIDER_TIMEOUT"
    );
  });

  it("image preparation failure never reached the provider", () => {
    const d = describeProviderFailure(new Error("OCR_IMAGE_PREPARATION_FAILED"));
    expect(d.code).toBe("OCR_IMAGE_PREPARATION_FAILED");
    expect(d.providerAttemptCount).toBe(0);
  });

  it("a network error is classified as such", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(describeProviderFailure(err).code).toBe("PROVIDER_NETWORK_ERROR");
  });

  it("a JSON parse failure is RESPONSE_PARSE_ERROR", () => {
    expect(describeProviderFailure(new SyntaxError("Unexpected token")).code).toBe(
      "RESPONSE_PARSE_ERROR"
    );
  });
});

describe("provider diagnostics never leak secrets", () => {
  it("an unknown error's own message is not propagated", () => {
    const leaky = new Error(
      "Request failed: https://api.example.com/v1?key=sk-SECRET123 Authorization: Bearer sk-SECRET123"
    );
    const d = describeProviderFailure(leaky);
    expect(d.message).not.toMatch(/sk-SECRET123/);
    expect(d.message).not.toMatch(/https?:/);
    expect(d.message).not.toMatch(/Bearer/i);
  });

  it("no diagnostic message contains a URL", () => {
    const cases = [
      describeProviderFailure(new LLMInvokeError(500, "generic"), 3),
      describeProviderFailure(new LLMInvokeError(401, "legacy_forge"), 1),
      describeProviderFailure(new Error("OCR_IMAGE_PREPARATION_FAILED")),
    ];
    for (const d of cases) {
      expect(d.message).not.toMatch(/https?:\/\//);
    }
  });
});

describe("categorizeOcrFailure", () => {
  it.each([
    ["PROVIDER_RATE_LIMIT", "TECHNICAL"],
    ["OCR_IMAGE_PREPARATION_FAILED", "TECHNICAL"],
    ["RESPONSE_PARSE_ERROR", "TECHNICAL"],
    ["MISSING_REFERENCE", "DATA"],
    ["AMOUNT_MISMATCH", "DATA"],
    ["UNKNOWN_CONFIDENCE", "DATA"],
    ["WEAK_DUPLICATE_RISK", "DATA"],
    ["OCR_DISABLED", "CONFIG"],
    ["AUTO_APPROVE_DISABLED", "CONFIG"],
  ])("%s -> %s", (code, expected) => {
    expect(categorizeOcrFailure(code)).toBe(expected);
  });

  it("an unknown legacy code defaults to DATA, never TECHNICAL", () => {
    // Conservative: calling a data problem a provider outage would invite an
    // admin to retry forever.
    expect(categorizeOcrFailure("SOME_LEGACY_CODE")).toBe("DATA");
    expect(categorizeOcrFailure(null)).toBe("DATA");
  });
});

describe("summarizeRootCause answers 'provider or slip?'", () => {
  it("a provider outage reads as an OCR system problem", () => {
    const d = describeProviderFailure(new LLMInvokeError(503, "generic"), 3);
    const s = summarizeRootCause({ reviewReason: d.code, providerDiagnostic: d });
    expect(s.category).toBe("TECHNICAL");
    expect(s.summary).toMatch(/OCR system problem/i);
    expect(s.summary).toMatch(/503/);
  });

  it("a missing reference reads as incomplete slip data", () => {
    const s = summarizeRootCause({ reviewReason: "MISSING_REFERENCE" });
    expect(s.category).toBe("DATA");
    expect(s.summary).toMatch(/no transaction reference/i);
  });

  it("a duplicate names the owning submission when known", () => {
    const s = summarizeRootCause({
      reviewReason: "DUPLICATE_REFERENCE",
      duplicateSourceLabel: "payment #123",
    });
    expect(s.summary).toMatch(/payment #123/);
  });

  it("a weak duplicate is explicitly labelled as not proof", () => {
    const s = summarizeRootCause({ reviewReason: "WEAK_DUPLICATE_RISK" });
    expect(s.summary).toMatch(/Possible duplicate only/i);
    expect(s.summary).toMatch(/NOT proof/i);
  });

  it("a passing recheck reads as ready for admin approval, never as approved", () => {
    const s = summarizeRootCause({ readyForAdminApproval: true });
    expect(s.summary).toMatch(/waiting for an admin to approve/i);
    expect(s.summary).not.toMatch(/\bapproved\b(?!.*waiting)/i);
  });

  it("an out-of-window date hints at a possible OCR misread", () => {
    const s = summarizeRootCause({ reviewReason: "TRANSACTION_OUTSIDE_TIME_WINDOW" });
    expect(s.summary).toMatch(/misread/i);
  });
});

// ─── Attempt-history sanitization ─────────────────────────────────────────

describe("sanitizeSnapshot strips anything sensitive", () => {
  it("drops credential-ish keys", () => {
    const out = sanitizeSnapshot(
      JSON.stringify({ apiKey: "sk-123", authorization: "Bearer x", amountMatched: true })
    );
    expect(out).not.toMatch(/sk-123/);
    expect(out).not.toMatch(/Bearer/);
    expect(JSON.parse(out!)).toEqual({ amountMatched: true });
  });

  it("drops any URL-valued field regardless of its key name", () => {
    const out = sanitizeSnapshot(
      JSON.stringify({ harmlessName: "https://signed.example.com/slip.png", datePresent: true })
    );
    expect(out).not.toMatch(/https:/);
    expect(JSON.parse(out!)).toEqual({ datePresent: true });
  });

  it("drops r2p: and data: values", () => {
    const out = sanitizeSnapshot(
      JSON.stringify({ a: "r2p:bucket/key", b: "data:image/png;base64,AAAA", ok: 1 })
    );
    expect(JSON.parse(out!)).toEqual({ ok: 1 });
  });

  it("drops raw OCR text", () => {
    const out = sanitizeSnapshot(JSON.stringify({ rawText: "ธนาคาร...", referencePresent: true }));
    expect(JSON.parse(out!)).toEqual({ referencePresent: true });
  });

  it("drops overly long strings that could smuggle a payload", () => {
    const out = sanitizeSnapshot(JSON.stringify({ blob: "x".repeat(500), ok: true }));
    expect(JSON.parse(out!)).toEqual({ ok: true });
  });

  it("returns null for malformed JSON rather than storing it unvetted", () => {
    expect(sanitizeSnapshot("{not json")).toBeNull();
    expect(sanitizeSnapshot(null)).toBeNull();
    expect(sanitizeSnapshot(undefined)).toBeNull();
  });

  it("keeps the verification checklist booleans", () => {
    const snapshot = {
      amountMatched: true,
      datePresent: true,
      dateWithinWindow: false,
      referencePresent: true,
      confidenceKnown: false,
      strongIdentifierPresent: true,
    };
    expect(JSON.parse(sanitizeSnapshot(JSON.stringify(snapshot))!)).toEqual(snapshot);
  });
});

// ─── Recheck reads global duplicate state, but never writes ──────────────

describe("Admin Recheck duplicate lookup is READ-ONLY", () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "server/services/ocrRecheckService.ts"),
    "utf-8"
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ 	]*\/\/.*$/gm, "");

  it("uses the SHARED conflict evaluator rather than its own lookup", () => {
    // Three near-copies of a financial decision is what let Recheck report
    // READY for a payment Approve was guaranteed to refuse.
    expect(code).toMatch(/evaluateSlipConflict\s*\(/);
    expect(code).not.toMatch(/findExistingClaim\s*\(/);
    expect(code).not.toMatch(/findLegacyApprovedDuplicate\s*\(/);
  });

  it("passes the raw reference so the advisory alias is included", () => {
    expect(code).toMatch(/rawReference: getRawReferenceForLegacyLookup\(/);
  });

  it("still never calls claimSlip - Approve remains the only writer", () => {
    expect(code).not.toMatch(/claimSlip\s*\(/);
  });

  it("never inserts into paymentSlipClaims", () => {
    expect(code).not.toMatch(/insert\s*\(/);
  });

  it("refuses READY for a strong duplicate AND for a legacy ambiguity", () => {
    // Both must block: Approve returns LEGACY_CASE_AMBIGUITY_REQUIRES_RESOLUTION
    // for an ambiguity, so presenting it as ready is a guaranteed dead end.
    expect(code).toMatch(
      /verificationPassed\s*=\s*verification\.isAutoApproved\s*&&\s*!strongDuplicate\s*&&\s*!legacyAmbiguity/
    );
  });

  it("reports an ambiguity as its own reason, not as a duplicate", () => {
    expect(code).toMatch(/"LEGACY_REFERENCE_CASE_AMBIGUITY"/);
    expect(code).toMatch(/requiresAdminResolution: Boolean\(legacyAmbiguity\)/);
    expect(code).toMatch(/strength: "legacy_case_ambiguity"/);
  });

  it("returns the matched owner for admin cross-linking", () => {
    expect(code).toMatch(/matchedSourceType/);
    expect(code).toMatch(/matchedSourceId/);
  });

  it("maps a duplicate to a strong reason code", () => {
    expect(code).toMatch(/DUPLICATE_REFERENCE/);
    expect(code).toMatch(/DUPLICATE_FILE/);
  });

  it("recomputes the file hash server-side rather than trusting stored state", () => {
    expect(code).toMatch(/computeSlipFileHash\s*\(\s*payment\.slipImageUrl/);
  });

  it("returns the EFFECTIVE window, never a hard-coded 120", () => {
    expect(code).toMatch(/effectiveWindowMinutes:\s*config\.maxTimeWindowMinutes/);
    expect(code).not.toMatch(/allowedWindowMinutes:\s*120/);
  });

  it("preserves the provider diagnostic instead of re-wrapping it", () => {
    // The old code threw new Error(code), discarding HTTP status and attempts.
    expect(code).toMatch(/PreservedProviderFailure/);
    expect(code).not.toMatch(/throw new Error\(parsed\.technicalErrorCode/);
  });
});


// ─── P2: a failed recheck must PERSIST the file hash it recovered ────────

describe("the recovered file identifier is persisted, but only while pending", () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "server/services/ocrRecheckService.ts"),
    "utf-8"
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  it("persists the hash BEFORE the provider call, conditionally", () => {
    // Written while the payment is still pending, so it is valid historical
    // evidence no matter what happens to the payment afterwards.
    const preIdx = code.indexOf("const preOcrFileHash");
    const providerIdx = code.indexOf("prepareSlipImageForOcr(payment.slipImageUrl)");
    expect(preIdx).toBeGreaterThan(-1);
    expect(providerIdx).toBeGreaterThan(preIdx);
    expect(code).toMatch(/updatePaymentIfNotFinalized\(payment\.id, \{\s*\n\s*extractedData: mergeFileHashInto/);
  });

  it("only writes when a hash was actually recovered", () => {
    expect(code).toMatch(/if \(preOcrFileHash\) \{/);
  });

  it("MERGES into existing extraction rather than replacing it", () => {
    // A provider failure must not destroy evidence an earlier read stored.
    const idx = code.indexOf("export function mergeFileHashInto");
    const block = code.slice(idx, idx + 700);
    expect(block).toMatch(/JSON\.parse\(existingJson\)/);
    expect(block).toMatch(/merged\.fileHash = fileHash/);
  });

  it("a corrupt existing blob does not throw", () => {
    const idx = code.indexOf("export function mergeFileHashInto");
    const block = code.slice(idx, idx + 700);
    expect(block).toMatch(/catch \{/);
    expect(block).toMatch(/merged = \{\}/);
  });

  it("the technical-failure path performs NO second write", () => {
    const idx = code.indexOf("const technicalPathFileHash = preOcrFileHash");
    expect(idx).toBeGreaterThan(-1);
    const block = code.slice(idx, idx + 900);
    expect(block).not.toMatch(/updatePayment/);
  });

  it("the panel status and the Approve action still cannot contradict each other", () => {
    const idx = code.indexOf("const technicalPathFileHash = preOcrFileHash");
    const block = code.slice(idx, idx + 2400);
    expect(block).toMatch(/describeFileIdentifierStatus\(\{ fileHash: technicalPathFileHash \}\)/);
    expect(block).toMatch(/hasStrongIdentifier: Boolean\(technicalPathFileHash\)/);
  });

  it("recheck still never claims, approves or rejects", () => {
    expect(code).not.toMatch(/\bclaimSlip\s*\(/);
    expect(code).not.toMatch(/\bapprovePayment\s*\(/);
    expect(code).not.toMatch(/\brejectPayment\s*\(/);
  });
});
