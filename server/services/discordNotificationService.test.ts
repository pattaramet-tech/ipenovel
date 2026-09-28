import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendSlipVerificationFailureNotification } from "./discordNotificationService";

describe("sendSlipVerificationFailureNotification", () => {
  beforeEach(() => {
    vi.stubEnv("DISCORD_OCR_REVIEW_WEBHOOK_URL", "https://discord.example.test/webhook");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("posts REVIEW_REQUIRED to the existing OCR review webhook with masked email", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendSlipVerificationFailureNotification({
      type: "payment",
      id: 17,
      userId: 42,
      userName: "Synthetic User",
      userEmail: "person@example.test",
      expectedAmount: 100,
      providerAmount: "99.00",
      outcome: "REVIEW_REQUIRED",
      reason: "AMOUNT_MISMATCH",
      providerCode: "200200",
      httpStatus: 200,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://discord.example.test/webhook");
    expect(request).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const body = JSON.parse(String(request.body));
    expect(body.username).toBe("IPE Slip Verify Bot");
    expect(body.embeds[0]).toMatchObject({
      title: "❌ Slip Verify Failed: Order Payment #17",
      color: 0xFF0000,
    });
    expect(JSON.stringify(body)).toContain("REVIEW_REQUIRED");
    expect(JSON.stringify(body)).toContain("Amount Mismatch");
    expect(JSON.stringify(body)).toContain("pe***@example.test");
    expect(JSON.stringify(body)).not.toContain("person@example.test");
  });

  it("posts ERROR for wallet top-ups", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendSlipVerificationFailureNotification({
      type: "wallet_topup",
      id: 23,
      userId: 42,
      expectedAmount: 250,
      outcome: "ERROR",
      reason: "PROVIDER_TIMEOUT",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.embeds[0].title).toBe("❌ Slip Verify Failed: Wallet Top-up #23");
    expect(JSON.stringify(body)).toContain("ERROR");
    expect(JSON.stringify(body)).toContain("Provider Timeout");
  });

  it("skips cleanly when the webhook is not configured", async () => {
    vi.stubEnv("DISCORD_OCR_REVIEW_WEBHOOK_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await sendSlipVerificationFailureNotification({
      type: "payment",
      id: 31,
      expectedAmount: 100,
      outcome: "ERROR",
      reason: "PROVIDER_REQUEST_FAILED",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws back into the financial flow when Discord returns an error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("no", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(sendSlipVerificationFailureNotification({
      type: "payment",
      id: 32,
      expectedAmount: 100,
      outcome: "ERROR",
      reason: "PROVIDER_REQUEST_FAILED",
    })).resolves.toBeUndefined();
  });
});
