import * as db from "../db";
import { persistAndAutoApprove } from "../payments/providerAutoApproval";
import { getReceiverCondition } from "../payments/receiverSettings";
import { resolveStoredFileValue } from "./r2PrivateStorage";

const SLIP2GO_ORIGIN = "https://connect.slip2go.com";
const MAX_SLIP_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const PROVIDER_TIMEOUT_MS = 15_000;

export type PaymentProviderVerificationResult = {
  provider: "slip2go";
  outcome: "VERIFIED" | "REVIEW_REQUIRED" | "ERROR";
  code?: string;
  providerReference?: string;
  bankTransactionReference?: string;
  amount?: string;
  occurredAt?: string;
  amountMatches?: boolean;
  recipientCheckApplied: boolean;
  httpStatus?: number;
  reason?: string;
  checkedAt?: string;
  approvalOutcome?: string;
  approvalReason?: string;
  approvalCheckedAt?: string;
  approvalPolicyRevision?: number;
};



function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,96}$/.test(value)
    ? value
    : undefined;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeMoney(value: string): string {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) throw new Error("INVALID_EXPECTED_AMOUNT");
  const [whole, fraction = ""] = trimmed.split(".");
  const normalized = `${BigInt(whole).toString()}.${fraction.padEnd(2, "0")}`;
  if (normalized === "0.00") throw new Error("INVALID_EXPECTED_AMOUNT");
  return normalized;
}

async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) throw new Error("EMPTY_BODY");
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > limit) {
    await response.body.cancel();
    throw new Error("BODY_LIMIT");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new Error("BODY_LIMIT");
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readStoredSlipBytes(storedValue: string, signal: AbortSignal): Promise<Uint8Array> {
  // Storage is transport only. We deliberately do NOT classify legacy-vs-R2,
  // derive a local file identity, compare hashes, or gate provider verification
  // on a storage lineage contract. The stored reference is resolved only so the
  // exact submitted bytes can be sent to the external verification provider.
  const resolved = await resolveStoredFileValue(storedValue, "paymentSlip", 60);
  if (!resolved) throw new Error("SLIP_NOT_AVAILABLE");
  const url = new URL(resolved);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("SLIP_NOT_AVAILABLE");
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("SLIP_NOT_AVAILABLE");
  }
  return readBounded(response, MAX_SLIP_BYTES, signal);
}

function detectImage(bytes: Uint8Array): { mime: "image/png" | "image/jpeg"; filename: string } {
  const png = bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (png) return { mime: "image/png", filename: "slip.png" };
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (jpeg) return { mime: "image/jpeg", filename: "slip.jpg" };
  throw new Error("UNSUPPORTED_SLIP_IMAGE");
}

function normalizeSlip2GoResponse(
  raw: unknown,
  httpStatus: number,
  expectedAmount: string,
  recipientCheckApplied: boolean
): PaymentProviderVerificationResult {
  const envelope = object(raw);
  const data = object(envelope.data);
  const code = typeof envelope.code === "string" && /^[0-9]{6}$/.test(envelope.code)
    ? envelope.code
    : undefined;
  const rawAmount = data.amount;
  const amount = typeof rawAmount === "number" && Number.isFinite(rawAmount)
    ? rawAmount.toFixed(2)
    : typeof rawAmount === "string" && /^\d+(\.\d{1,2})?$/.test(rawAmount)
      ? normalizeMoney(rawAmount)
      : undefined;
  const occurredAt = typeof data.dateTime === "string" && !Number.isNaN(Date.parse(data.dateTime))
    ? new Date(data.dateTime).toISOString()
    : undefined;
  const common = {
    provider: "slip2go" as const,
    httpStatus,
    checkedAt: new Date().toISOString(),
    code,
    providerReference: safeToken(data.referenceId),
    bankTransactionReference: safeToken(data.transRef),
    amount,
    occurredAt,
    amountMatches: amount !== undefined ? amount === expectedAmount : undefined,
    recipientCheckApplied,
  };

  // The image endpoint also returns HTTP 201 with a completed verification.
  // Transport success alone never establishes that a payment is valid.
  const supportedStatus = httpStatus === 200 || httpStatus === 201;
  if (!supportedStatus || !code) return { ...common, outcome: "ERROR", reason: !supportedStatus ? "UNEXPECTED_PROVIDER_HTTP_STATUS" : "INVALID_PROVIDER_RESPONSE" };
  // Slip2Go 200200 means the requested check conditions passed. We still
  // require an explicit amount match in the returned bank data. When no
  // receiver condition is configured, keep the result review-required rather
  // than silently treating an unverified destination account as approved.
  if (code === "200200") {
    return {
      ...common,
      reason: !recipientCheckApplied ? "RECEIVER_CHECK_NOT_APPLIED" : amount !== expectedAmount ? "AMOUNT_MISMATCH" : !occurredAt ? "INVALID_TRANSACTION_DATE" : "CHECKS_PASSED",
      outcome:
        amount === expectedAmount && recipientCheckApplied && occurredAt
          ? "VERIFIED"
          : "REVIEW_REQUIRED",
    };
  }
  if (code === "200000" || code === "200202" || code.startsWith("2004") || code.startsWith("2005")) {
    return { ...common, outcome: "REVIEW_REQUIRED", reason: "PROVIDER_REVIEW_REQUIRED" };
  }
  return { ...common, outcome: "ERROR", reason: "UNRECOGNIZED_PROVIDER_CODE" };
}

async function verifyStoredSlip(storedValue: string, expectedAmountValue: string): Promise<PaymentProviderVerificationResult> {
  const secret = process.env.SLIP2GO_SECRET_KEY;
  if (!secret || !/^[\x21-\x7e]{1,4096}$/.test(secret) || secret.startsWith("Bearer ")) {
    return { provider: "slip2go", outcome: "ERROR", recipientCheckApplied: false, reason: "PROVIDER_SECRET_NOT_CONFIGURED", checkedAt: new Date().toISOString() };
  }
  const expectedAmount = normalizeMoney(expectedAmountValue);
  const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  let recipientCheckApplied = false;
  let httpStatus: number | undefined;
  try {
    const bytes = await readStoredSlipBytes(storedValue, signal);
    signal.throwIfAborted();
    const image = detectImage(bytes);
    const receiver = await getReceiverCondition();
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(bytes)], { type: image.mime }), image.filename);
    form.set("payload", JSON.stringify({
      checkDuplicate: true,
      checkAmount: { type: "eq", amount: expectedAmount },
      ...(receiver ? { checkReceiver: [receiver] } : {}),
    }));
    const response = await fetch(`${SLIP2GO_ORIGIN}/api/verify-slip/qr-image/info`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
      body: form,
      signal,
      redirect: "error",
    });
    recipientCheckApplied = !!receiver;
    httpStatus = response.status;
    const payload = await readBounded(response, MAX_RESPONSE_BYTES, signal);
    const text = new TextDecoder().decode(payload);
    // Never surface/log a provider response that echoes the credential.
    if (text.includes(secret)) throw new Error("PROVIDER_SECRET_ECHO");
    return normalizeSlip2GoResponse(JSON.parse(text), response.status, expectedAmount, !!receiver);
  } catch (error) {
    return { provider: "slip2go", outcome: "ERROR", recipientCheckApplied, httpStatus, checkedAt: new Date().toISOString(), reason: diagnosticReason(error) };
  }
}

function diagnosticReason(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "PROVIDER_TIMEOUT";
    if (error instanceof SyntaxError) return "INVALID_PROVIDER_RESPONSE";
    if (["INVALID_PROVIDER_RECEIVER_SETTINGS", "RECEIVER_SETTINGS_UNAVAILABLE", "SLIP_NOT_AVAILABLE",
      "UNSUPPORTED_SLIP_IMAGE", "BODY_LIMIT", "EMPTY_BODY", "PROVIDER_SECRET_ECHO"].includes(error.message)) return error.message;
  }
  return "PROVIDER_REQUEST_FAILED";
}

export async function verifyOrderPaymentWithProvider(paymentId: number): Promise<PaymentProviderVerificationResult> {
  const payment = await db.getPaymentById(paymentId);
  if (!payment) throw new Error("PAYMENT_NOT_FOUND");
  if (!payment.slipImageUrl) throw new Error("PAYMENT_SLIP_REQUIRED");
  const order = await db.getOrderById(payment.orderId);
  if (!order) throw new Error("ORDER_NOT_FOUND");
  const result = await verifyStoredSlip(payment.slipImageUrl, String(order.totalAmount));
  return persistAndAutoApprove("order", payment, result);
}

export async function verifyWalletTopupWithProvider(topupId: number): Promise<PaymentProviderVerificationResult> {
  const topup = await db.getWalletTopupById(topupId);
  if (!topup) throw new Error("TOPUP_NOT_FOUND");
  if (!topup.slipImageUrl) throw new Error("PAYMENT_SLIP_REQUIRED");
  const result = await verifyStoredSlip(topup.slipImageUrl, String(topup.requestedAmount));
  return persistAndAutoApprove("wallet", topup, result);
}

export const __test = { normalizeMoney, normalizeSlip2GoResponse, detectImage };
