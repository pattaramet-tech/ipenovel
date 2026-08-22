/**
 * Slip identifier + duplicate-evidence model.
 *
 * Pure, dependency-free helpers (crypto only) so they can be unit tested
 * without a database, an LLM, or a DOM - matching this repo's existing
 * pure-helper test pattern.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 * The pre-existing duplicate model had ONE notion of "duplicate": a single
 * `generateFingerprint()` SHA-256 whose fallback branch hashed
 * `bank | maskedAccount | amount | transactionDate`. A customer who
 * legitimately transfers 100 THB twice from the same account on the same day
 * produces the SAME value there, so that fallback cannot distinguish "the
 * same bank transaction submitted twice" from "two different real transfers".
 * Treating it as proof of duplication is a false-positive generator; treating
 * it as nothing at all throws away a genuine risk signal.
 *
 * So evidence is split by STRENGTH:
 *
 *   STRONG  - identifies ONE real bank transaction:
 *             referenceHash   (the bank's own transaction reference)
 *             fileHash        (byte-identical slip image re-uploaded)
 *             qrPayloadHash   (decoded slip QR payload)
 *             These may gate financial value (see paymentSlipClaims).
 *
 *   WEAK    - a risk signal only: semanticFingerprint (bank/account/amount/
 *             date). NEVER proof, NEVER a DB unique constraint, NEVER a
 *             hard block. At most it routes a submission to human review.
 *
 * Nothing in this module ever rejects a payment. Per payment policy, OCR may
 * only AUTO_APPROVE or NEEDS_REVIEW; rejection is an admin-only action.
 */

import crypto from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────

export type DuplicateEvidenceStrength = "strong" | "weak" | "none";

export type StrongDuplicateKind = "reference" | "file" | "qr";

export interface SlipStrongIdentifiers {
  /** SHA-256 of the normalized bank transaction reference. */
  referenceHash?: string;
  /** SHA-256 of the raw uploaded slip bytes. */
  fileHash?: string;
  /** SHA-256 of the decoded QR payload, when QR decoding is available. */
  qrPayloadHash?: string;
}

export interface DuplicateEvidence {
  strength: DuplicateEvidenceStrength;
  /** Which strong identifier matched, when `strength === "strong"`. */
  strongKind?: StrongDuplicateKind;
  /**
   * Stable reason code. Strong kinds map to DUPLICATE_REFERENCE /
   * DUPLICATE_FILE / DUPLICATE_QR; a weak match maps to WEAK_DUPLICATE_RISK.
   */
  reasonCode?:
    | "DUPLICATE_REFERENCE"
    | "DUPLICATE_FILE"
    | "DUPLICATE_QR"
    | "WEAK_DUPLICATE_RISK";
  /** Admin-facing English summary. Never contains secrets or raw payloads. */
  detail?: string;
}

// ─── OCR text normalization (parsing only) ────────────────────────────────

/**
 * Strips *formatting* that an LLM wraps around slip labels before the field
 * regexes run. This exists because a real SCB sample rendered its amount as:
 *
 *     **จำนวนเงิน**
 *     100.00
 *
 * The pre-existing `จำนวนเงิน[\s\n]+...` pattern could not match across the
 * trailing `**`, so a perfectly readable amount produced MISSING_AMOUNT.
 *
 * CRITICAL SAFETY PROPERTY: this only removes markdown emphasis/heading/
 * bullet MARKERS and collapses horizontal whitespace. It never edits digits,
 * never removes `.` or `,` (so `100.00` and `1,000` survive intact), never
 * touches letters, and never rewrites a reference token. Financial content
 * is preserved byte-for-byte; only decoration around it is dropped.
 */
export function normalizeOcrTextForParsing(text: string): string {
  if (!text) return "";

  return (
    text
      // Zero-width and BOM characters an LLM sometimes emits mid-token.
      .replace(/[​-‍﻿]/g, "")
      // Bold/italic emphasis markers: **x**, __x__, *x*, _x_.
      // Only the markers go; the wrapped content is kept verbatim.
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/__(.+?)__/g, "$1")
      .replace(/\*(.+?)\*/g, "$1")
      // Leading list bullets / heading hashes / blockquote markers.
      .replace(/^[ \t]*[*+-][ \t]+/gm, "")
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
      .replace(/^[ \t]*>[ \t]?/gm, "")
      // Markdown table pipes around a cell become plain spaces so
      // "| จำนวนเงิน | 100.00 |" still parses.
      .replace(/[ \t]*\|[ \t]*/g, " ")
      // Any leftover unpaired emphasis markers directly adjacent to a label.
      .replace(/\*+/g, "")
      // Collapse horizontal whitespace but PRESERVE newlines - several
      // extractors rely on "label on one line, value on the next".
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
  );
}

// ─── Reference normalization + hashing ────────────────────────────────────

/**
 * Conservative normalization of a bank transaction reference for
 * comparison/hashing. The RAW reference is always kept separately for admin
 * display - this value exists only to be compared.
 *
 * Deliberately does NOT change case. Real references are case-significant:
 * SCB emits values such as `202608225ApOyxElgdOo7YVwv`, and upper-casing
 * would map genuinely different references onto one value - exactly the
 * false-collision class this module is meant to eliminate. Upper-casing is
 * therefore lossy and is not applied, even though it would "look" tidier.
 *
 * Only removes whitespace and zero-width characters, which are OCR
 * line-wrapping artifacts rather than part of the reference itself.
 *
 * Returns `undefined` when nothing usable remains (fewer than 4 characters),
 * which callers must treat as "no reference", never as an empty-string key.
 */
export function normalizeSlipReference(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;

  const normalized = String(raw)
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, "")
    .trim();

  return normalized.length >= 4 ? normalized : undefined;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * SHA-256 of the NORMALIZED reference, namespaced so a reference hash can
 * never collide with a file hash or a QR hash even if the underlying bytes
 * coincided. Returns undefined when there is no usable reference.
 */
export function hashSlipReference(raw: string | null | undefined): string | undefined {
  const normalized = normalizeSlipReference(raw);
  if (!normalized) return undefined;
  return sha256(`slip:reference:v1:${normalized}`);
}

/**
 * SHA-256 of the ACTUAL uploaded slip bytes. A byte-identical re-upload is
 * unambiguous strong evidence of the same slip being replayed.
 *
 * Note this is intentionally sensitive to any re-encode: a screenshot or
 * recompression yields a different hash. That is correct for a STRONG
 * signal - it never produces a false positive, it only misses.
 */
export function hashSlipFileBytes(bytes: Uint8Array | Buffer): string {
  return crypto
    .createHash("sha256")
    .update(Buffer.from(bytes))
    .update("slip:file:v1")
    .digest("hex");
}

/**
 * SHA-256 of a decoded slip QR payload. The payload itself is never
 * persisted or shown - only this hash - because a Thai slip QR encodes
 * account/PromptPay identifiers.
 */
export function hashQrPayload(payload: string | null | undefined): string | undefined {
  if (!payload) return undefined;
  const trimmed = String(payload).trim();
  if (trimmed.length === 0) return undefined;
  return sha256(`slip:qr:v1:${trimmed}`);
}

// ─── Weak semantic fingerprint ────────────────────────────────────────────

export interface SemanticFingerprintInput {
  detectedBank?: string;
  maskedAccount?: string;
  amount?: number;
  transactionDate?: Date;
}

/**
 * Deterministic hash of the coarse financial shape of a slip. This is a RISK
 * SIGNAL, not an identifier.
 *
 * Two genuinely different transfers (same customer, same account, same
 * amount, same day) collide here BY DESIGN, which is precisely why callers
 * must never treat a match as confirmed duplication, never enforce it with a
 * DB unique constraint, and never let it block financial value on its own.
 *
 * Returns undefined when too few fields are present for the value to mean
 * anything at all - an "empty shape" must not collide with every other
 * empty shape.
 */
export function buildSemanticFingerprint(
  input: SemanticFingerprintInput
): string | undefined {
  const bank = (input.detectedBank ?? "").trim().toUpperCase();
  const account = (input.maskedAccount ?? "").replace(/\s+/g, "").trim();
  const amount =
    typeof input.amount === "number" && Number.isFinite(input.amount)
      ? input.amount.toFixed(2)
      : "";
  const date =
    input.transactionDate instanceof Date && !Number.isNaN(input.transactionDate.getTime())
      ? input.transactionDate.toISOString().split("T")[0]
      : "";

  const present = [bank, account, amount, date].filter((v) => v.length > 0).length;
  if (present < 2) return undefined;

  return sha256(`slip:semantic:v1:${[bank, account, amount, date].join("|")}`);
}

// ─── Duplicate evidence classification ────────────────────────────────────

export interface DuplicateLookupResult {
  /** Strong identifiers already claimed by some OTHER submission. */
  matchedStrong?: StrongDuplicateKind;
  /** True when only the weak semantic fingerprint matched. */
  matchedWeak?: boolean;
}

/**
 * Turns a lookup result into a typed evidence verdict.
 *
 * A strong match always wins over a weak one; a weak match alone is reported
 * as `weak` with an explicit caveat so no downstream consumer (API, UI, or
 * admin note) can present it as a confirmed duplicate.
 */
export function classifyDuplicateEvidence(
  lookup: DuplicateLookupResult
): DuplicateEvidence {
  if (lookup.matchedStrong) {
    switch (lookup.matchedStrong) {
      case "reference":
        return {
          strength: "strong",
          strongKind: "reference",
          reasonCode: "DUPLICATE_REFERENCE",
          detail: "This bank transaction reference has already been used.",
        };
      case "file":
        return {
          strength: "strong",
          strongKind: "file",
          reasonCode: "DUPLICATE_FILE",
          detail: "This exact slip image file has already been submitted.",
        };
      case "qr":
        return {
          strength: "strong",
          strongKind: "qr",
          reasonCode: "DUPLICATE_QR",
          detail: "This slip's QR payload has already been used.",
        };
    }
  }

  if (lookup.matchedWeak) {
    return {
      strength: "weak",
      reasonCode: "WEAK_DUPLICATE_RISK",
      detail:
        "Possible duplicate only - same bank, account, amount and date as an earlier " +
        "submission. This is NOT proof of a duplicate transaction: the same customer " +
        "may legitimately transfer the same amount more than once on the same day.",
    };
  }

  return { strength: "none" };
}

/**
 * True only for evidence that may gate financial value. Weak evidence never
 * qualifies - it can route to review, never block.
 */
export function isStrongDuplicate(evidence: DuplicateEvidence): boolean {
  return evidence.strength === "strong";
}
