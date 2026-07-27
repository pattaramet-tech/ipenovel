import { describe, it, expect } from "vitest";
import {
  resolveUploadFailureMessage,
  resolveCheckoutFailureMessage,
  resolveCheckoutSuccessMessage,
} from "./checkoutOutcome";

/**
 * Pure decision-logic coverage for the "upload slip, then checkout" flow -
 * this repo has no DOM/component test harness, so this logic lives outside
 * React specifically so it can be tested directly (see checkoutOutcome.ts's
 * own doc comment).
 *
 * resolveUploadFailureMessage is the client-side half of the payment-slip-
 * upload regression fix: it displays whatever `error.message` the
 * payment.uploadSlipFile mutation rejected with, completely verbatim - the
 * actual fix (server/_core/trpc.ts allowlisting SERVICE_UNAVAILABLE so the
 * real Thai message + safe reference ID survive sanitization) lives
 * server-side; these tests lock in that this client function never
 * reinterprets, truncates, or replaces whatever message it is given.
 */

const t = (key: string) => `[translated:${key}]`;

describe("resolveUploadFailureMessage", () => {
  it("displays the server's error message verbatim, including an appended safe reference ID", () => {
    const message = "ระบบแนบสลิปยังไม่พร้อมใช้งาน กรุณาติดต่อแอดมิน (รหัสอ้างอิง: upload-1706000000000)";
    const error = { message };
    expect(resolveUploadFailureMessage(error, t)).toBe(message);
  });

  it("displays the temporary-retry Thai message verbatim too - never rewritten to a different category", () => {
    const message = "ไม่สามารถอัปโหลดสลิปได้ชั่วคราว กรุณาลองใหม่อีกครั้ง (รหัสอ้างอิง: upload-1706000000001)";
    const error = { message };
    expect(resolveUploadFailureMessage(error, t)).toBe(message);
  });

  it("never displays the raw English tRPC fallback string as if it were a translation key - it is just another `.message` value passed straight through", () => {
    const message = "Unable to process this request at this time. Please try again.";
    const error = { message };
    // This function has no special-case logic for any particular string -
    // it displays whatever message it's given. The actual fix that keeps
    // this generic string from ever reaching here in the first place lives
    // in server/_core/trpc.ts's CLIENT_SAFE_ERROR_CODES allowlist, not here.
    expect(resolveUploadFailureMessage(error, t)).toBe(message);
  });

  it("falls back to the translated payment.uploadFailed key when the error has no usable message", () => {
    expect(resolveUploadFailureMessage({}, t)).toBe(t("payment.uploadFailed"));
    expect(resolveUploadFailureMessage({ message: "" }, t)).toBe(t("payment.uploadFailed"));
    expect(resolveUploadFailureMessage(null, t)).toBe(t("payment.uploadFailed"));
    expect(resolveUploadFailureMessage(undefined, t)).toBe(t("payment.uploadFailed"));
  });

  it("falls back to the translation key when message is not a string (a malformed/unexpected error shape)", () => {
    expect(resolveUploadFailureMessage({ message: 42 }, t)).toBe(t("payment.uploadFailed"));
    expect(resolveUploadFailureMessage({ message: { nested: true } }, t)).toBe(t("payment.uploadFailed"));
  });
});

describe("resolveCheckoutFailureMessage", () => {
  it("displays the server's error message verbatim", () => {
    const message = "Your cart is empty. Please add items before checkout.";
    expect(resolveCheckoutFailureMessage({ message }, t)).toBe(message);
  });

  it("falls back to the translated payment.checkoutFailed key when there is no usable message", () => {
    expect(resolveCheckoutFailureMessage({}, t)).toBe(t("payment.checkoutFailed"));
    expect(resolveCheckoutFailureMessage({ message: "" }, t)).toBe(t("payment.checkoutFailed"));
  });

  it("uses a different fallback key than resolveUploadFailureMessage - an upload success followed by a checkout failure must never be described as an upload failure", () => {
    expect(resolveCheckoutFailureMessage({}, t)).not.toBe(resolveUploadFailureMessage({}, t));
  });
});

describe("resolveCheckoutSuccessMessage", () => {
  it("treats a missing slipResult (no slip submitted) as plain success", () => {
    expect(resolveCheckoutSuccessMessage(undefined, t)).toBe(t("order.createdSuccess"));
    expect(resolveCheckoutSuccessMessage(null, t)).toBe(t("order.createdSuccess"));
  });

  it("shows the auto-approved message when status is approved", () => {
    expect(resolveCheckoutSuccessMessage({ status: "approved" }, t)).toBe(t("payment.autoApprovedOrderMessage"));
  });

  it("shows the OCR-error-review message when processing was deferred", () => {
    expect(
      resolveCheckoutSuccessMessage({ status: "pending_review", processingDeferred: true }, t)
    ).toBe(t("payment.ocrErrorReviewMessage"));
  });

  it("shows the OCR-error-review message when reviewReason is OCR_PROCESSING_ERROR", () => {
    expect(
      resolveCheckoutSuccessMessage({ status: "pending_review", reviewReason: "OCR_PROCESSING_ERROR" }, t)
    ).toBe(t("payment.ocrErrorReviewMessage"));
  });

  it("shows the duplicate-review message when the slip is a duplicate by reference", () => {
    expect(
      resolveCheckoutSuccessMessage(
        { status: "pending_review", duplicateStatus: { isDuplicateReference: true } },
        t
      )
    ).toBe(t("payment.duplicateReviewMessage"));
  });

  it("shows the duplicate-review message when the slip is a duplicate by fingerprint", () => {
    expect(
      resolveCheckoutSuccessMessage(
        { status: "pending_review", duplicateStatus: { isDuplicateFingerprint: true } },
        t
      )
    ).toBe(t("payment.duplicateReviewMessage"));
  });

  it("shows the low-confidence-review message when ocrConfidence is below 85", () => {
    expect(
      resolveCheckoutSuccessMessage({ status: "pending_review", ocrConfidence: 84 }, t)
    ).toBe(t("payment.lowConfidenceReviewMessage"));
  });

  it("shows the plain pending-review message when none of the specific reasons apply", () => {
    expect(resolveCheckoutSuccessMessage({ status: "pending_review" }, t)).toBe(t("payment.pendingReviewOrderMessage"));
  });

  it("falls back to plain success for any other/unrecognized status", () => {
    expect(resolveCheckoutSuccessMessage({ status: "something_else" }, t)).toBe(t("order.createdSuccess"));
  });
});
