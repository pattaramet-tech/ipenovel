import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("../db", () => dbMock);

import {
  DEFAULT_CHECKOUT_MAINTENANCE_STATUS,
  assertCheckoutAvailable,
  assertSlipCheckoutAvailable,
  getCheckoutMaintenanceStatus,
  saveCheckoutMaintenanceStatus,
} from "./checkoutMaintenanceService";

describe("checkoutMaintenanceService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails open when the setting is missing", async () => {
    dbMock.getSetting.mockResolvedValue(undefined);
    await expect(getCheckoutMaintenanceStatus()).resolves.toEqual(DEFAULT_CHECKOUT_MAINTENANCE_STATUS);
  });

  it("fails open when JSON is malformed", async () => {
    dbMock.getSetting.mockResolvedValue({ value: "{not-json" });
    await expect(getCheckoutMaintenanceStatus()).resolves.toEqual(DEFAULT_CHECKOUT_MAINTENANCE_STATUS);
  });

  it("fails open when reading the setting throws", async () => {
    dbMock.getSetting.mockRejectedValue(new Error("Failed query: select secret"));
    await expect(assertCheckoutAvailable("test")).resolves.toBeUndefined();
  });

  it("trims and saves admin text with a server timestamp", async () => {
    dbMock.setSetting.mockResolvedValue(undefined);
    const result = await saveCheckoutMaintenanceStatus({
      enabled: true,
      scope: "slip_only",
      severity: "warning",
      title: "  Maintenance  ",
      message: "  Try later  ",
    });
    expect(result.title).toBe("Maintenance");
    expect(result.message).toBe("Try later");
    const stored = JSON.parse(dbMock.setSetting.mock.calls[0][1]);
    expect(stored.updatedAt).toMatch(/Z$/);
  });

  it("rejects HTML and enabled blank messages", async () => {
    await expect(
      saveCheckoutMaintenanceStatus({
        enabled: true,
        scope: "notice_only",
        severity: "info",
        title: "<b>Internal</b>",
        message: " ",
      })
    ).rejects.toThrow();
    expect(dbMock.setSetting).not.toHaveBeenCalled();
  });

  it("notice_only does not block checkout or slip", async () => {
    dbMock.getSetting.mockResolvedValue({
      value: JSON.stringify({
        enabled: true,
        scope: "notice_only",
        severity: "info",
        title: "Notice",
        message: "Still available",
      }),
    });
    await expect(assertCheckoutAvailable("checkout")).resolves.toBeUndefined();
    await expect(assertSlipCheckoutAvailable("slip")).resolves.toBeUndefined();
  });

  it("slip_only blocks slip but leaves wallet/points checkout available", async () => {
    dbMock.getSetting.mockResolvedValue({
      value: JSON.stringify({
        enabled: true,
        scope: "slip_only",
        severity: "warning",
        title: "Slip",
        message: "Unavailable",
      }),
    });
    await expect(assertCheckoutAvailable("wallet")).resolves.toBeUndefined();
    await expect(assertSlipCheckoutAvailable("upload")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "ระบบแนบสลิปปิดให้บริการชั่วคราว กรุณาลองใหม่ภายหลัง",
      cause: { code: "SLIP_PAYMENT_MAINTENANCE" },
    });
  });

  it("all_checkout blocks every checkout before callers can write", async () => {
    dbMock.getSetting.mockResolvedValue({
      value: JSON.stringify({
        enabled: true,
        scope: "all_checkout",
        severity: "error",
        title: "Checkout",
        message: "Unavailable",
      }),
    });
    await expect(assertCheckoutAvailable("checkout.create")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      cause: { code: "CHECKOUT_MAINTENANCE" },
    });
  });

  it("takes effect immediately after an admin disables maintenance", async () => {
    dbMock.getSetting
      .mockResolvedValueOnce({
        value: JSON.stringify({
          enabled: true,
          scope: "all_checkout",
          severity: "error",
          title: "Stop",
          message: "Stop",
        }),
      })
      .mockResolvedValueOnce({
        value: JSON.stringify({
          enabled: false,
          scope: "all_checkout",
          severity: "error",
          title: "Stop",
          message: "Stop",
        }),
      });
    await expect(assertCheckoutAvailable("checkout")).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await expect(assertCheckoutAvailable("checkout")).resolves.toBeUndefined();
  });
});
