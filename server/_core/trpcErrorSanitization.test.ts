import { describe, it, expect } from "vitest";
import { sanitizeTrpcErrorShape, looksLikeRawDatabaseError, GENERIC_INTERNAL_ERROR_MESSAGE } from "./trpc";

/**
 * Test 5 - tRPC database error sanitization.
 *
 * Exercises the exact function wired into initTRPC's `errorFormatter`, with
 * a faithful reproduction of the drizzle error that leaked to the browser
 * during the incident:
 *
 *   Failed query: select ... from dailyCheckins
 *   params: 2160001,1
 */

function drizzleDatabaseError() {
  const driverError: any = new Error("Table 'ipenovel.dailyCheckins' doesn't exist");
  driverError.code = "ER_NO_SUCH_TABLE";
  driverError.errno = 1146;
  driverError.sqlState = "42S02";

  const wrapper: any = new Error(
    "Failed query: select `id`, `userId`, `checkinDate` from `dailyCheckins` where `userId` = ? limit ?\nparams: 2160001,1"
  );
  wrapper.cause = driverError;
  wrapper.code = "INTERNAL_SERVER_ERROR";
  return wrapper;
}

/** The shape tRPC would otherwise serialize: raw message plus a stack. */
function shapeFor(message: string) {
  return {
    message,
    code: -32603,
    data: {
      code: "INTERNAL_SERVER_ERROR",
      httpStatus: 500,
      path: "dailyCheckin.getStatus",
      stack: "Error: Failed query: select ...\n    at Object.getStatus (/app/server/db.ts:4480:11)",
      message,
    },
  };
}

function collectingLogger() {
  const lines: string[] = [];
  return { logger: { error: (line: string) => lines.push(line) }, lines };
}

describe("Test 5 - unexpected database errors are never exposed to the client", () => {
  const error = drizzleDatabaseError();
  const { logger, lines } = collectingLogger();
  const result = sanitizeTrpcErrorShape(shapeFor(error.message), error, logger);
  const serialized = JSON.stringify(result);

  it("uses the generic internal error message", () => {
    expect(result.message).toBe(GENERIC_INTERNAL_ERROR_MESSAGE);
    expect(result.data.message).toBe(GENERIC_INTERNAL_ERROR_MESSAGE);
  });

  it("does not contain 'Failed query'", () => {
    expect(serialized).not.toMatch(/failed\s+query/i);
  });

  it("does not contain the table name 'dailyCheckins'", () => {
    expect(serialized).not.toContain("dailyCheckins");
  });

  it("does not contain the bound parameter '2160001'", () => {
    expect(serialized).not.toContain("2160001");
  });

  it("does not contain SQL", () => {
    expect(serialized.toLowerCase()).not.toContain("select");
    expect(serialized).not.toContain("params:");
  });

  it("does not contain a stack trace", () => {
    expect(result.data.stack).toBeUndefined();
    expect(serialized).not.toContain("at Object.getStatus");
    expect(serialized).not.toContain("server/db.ts");
  });

  it("does not expose error.cause", () => {
    expect(serialized).not.toContain("cause");
    expect(serialized).not.toContain("ER_NO_SUCH_TABLE");
  });

  it("logs a sanitized diagnostic server-side with only safe fields", () => {
    expect(lines).toHaveLength(1);
    const logged = lines[0];
    expect(logged).toContain("code=ER_NO_SUCH_TABLE");
    expect(logged).toContain("errno=1146");
    expect(logged).toContain("sqlState=42S02");
    // Useful underlying cause retained...
    expect(logged).toContain("doesn't exist");
    // ...but never the SQL or the parameters.
    expect(logged).not.toMatch(/failed\s+query/i);
    expect(logged).not.toContain("2160001");
    expect(logged.toLowerCase()).not.toContain("select");
  });
});

describe("intentional application errors keep their user-facing message", () => {
  const safeCodes = ["UNAUTHORIZED", "FORBIDDEN", "BAD_REQUEST", "NOT_FOUND", "CONFLICT", "SERVICE_UNAVAILABLE"];

  for (const code of safeCodes) {
    it(`${code} preserves its message`, () => {
      const message = `deliberate ${code} message`;
      const shape = { message, code: -32600, data: { code, httpStatus: 400, message, stack: "some stack" } };
      const { logger, lines } = collectingLogger();

      const result = sanitizeTrpcErrorShape(shape, { code }, logger);

      expect(result.message).toBe(message);
      expect(result.data.message).toBe(message);
      // Still never ships a stack, and does not log noise for expected errors.
      expect(result.data.stack).toBeUndefined();
      expect(lines).toHaveLength(0);
    });
  }
});

describe("the sanitizer applies to every unexpected code, not just one procedure", () => {
  it("replaces the message for any non-allowlisted code", () => {
    for (const code of ["INTERNAL_SERVER_ERROR", "TIMEOUT", "BAD_GATEWAY", "SOMETHING_NEW"]) {
      const { logger } = collectingLogger();
      const result = sanitizeTrpcErrorShape(shapeFor("raw internal detail"), { code }, logger);
      expect(result.message).toBe(GENERIC_INTERNAL_ERROR_MESSAGE);
    }
  });
});

describe("Part 4 - a raw database exception disguised behind an allowlisted code is still sanitized", () => {
  // Real gap this covers: several call sites in server/routers.ts do
  // `throw new TRPCError({ code: "BAD_REQUEST", message: error?.message })`
  // after catching a service call (e.g. orderService.approvePayment) that
  // normally only throws deliberate application errors - but if that
  // service call ever surfaces a raw, un-wrapped drizzle exception instead,
  // its message would flow straight through an allowlisted code unless the
  // message itself is also checked.
  const drizzleMessage =
    "Failed query: select `id`, `userId` from `dailyCheckins` where `userId` = ? limit ?\nparams: 2160001,1";

  const ALLOWLISTED_CODES = [
    "UNAUTHORIZED",
    "FORBIDDEN",
    "BAD_REQUEST",
    "NOT_FOUND",
    "CONFLICT",
    "TOO_MANY_REQUESTS",
    "PAYLOAD_TOO_LARGE",
    "UNPROCESSABLE_CONTENT",
    "PRECONDITION_FAILED",
    "METHOD_NOT_SUPPORTED",
    "SERVICE_UNAVAILABLE",
  ];

  for (const code of ALLOWLISTED_CODES) {
    it(`a drizzle-style error wrapped in ${code} is sanitized, not passed through`, () => {
      const { logger } = collectingLogger();
      const result = sanitizeTrpcErrorShape(shapeFor(drizzleMessage), { code }, logger);
      const serialized = JSON.stringify(result);

      expect(result.message).toBe(GENERIC_INTERNAL_ERROR_MESSAGE);
      expect(result.data.message).toBe(GENERIC_INTERNAL_ERROR_MESSAGE);
      expect(serialized).not.toMatch(/failed\s+query/i);
      expect(serialized).not.toContain("dailyCheckins");
      expect(serialized).not.toContain("2160001");
      expect(serialized).not.toContain("params:");
      expect(serialized.toLowerCase()).not.toContain("select");
      expect(result.data.stack).toBeUndefined();
      expect(serialized).not.toContain("cause");
    });
  }

  it("still logs a sanitized server-side diagnostic even though the code was allowlisted", () => {
    const { logger, lines } = collectingLogger();
    sanitizeTrpcErrorShape(shapeFor(drizzleMessage), { code: "BAD_REQUEST" }, logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("raw DB error behind an allowlisted code");
  });

  it("a raw connection string disguised behind CONFLICT is also sanitized", () => {
    const message = "duplicate entry for mysql://appuser:S3cr3t@db.internal.example.com:3306/ipenovel";
    const result = sanitizeTrpcErrorShape(shapeFor(message), { code: "CONFLICT" });
    expect(result.message).toBe(GENERIC_INTERNAL_ERROR_MESSAGE);
    expect(JSON.stringify(result)).not.toContain("S3cr3t");
  });
});

describe("SERVICE_UNAVAILABLE is allowlisted, INTERNAL_SERVER_ERROR is deliberately not", () => {
  it("SERVICE_UNAVAILABLE preserves a deliberate, hand-written message unchanged", () => {
    const message = "ระบบแนบสลิปยังไม่พร้อมใช้งาน กรุณาติดต่อแอดมิน";
    const { logger, lines } = collectingLogger();
    const result = sanitizeTrpcErrorShape(shapeFor(message), { code: "SERVICE_UNAVAILABLE" }, logger);
    expect(result.message).toBe(message);
    expect(result.data.message).toBe(message);
    expect(lines).toHaveLength(0);
  });

  it("INTERNAL_SERVER_ERROR still replaces the SAME message with the generic fallback (INTERNAL_SERVER_ERROR was never added to the allowlist)", () => {
    const message = "ระบบแนบสลิปยังไม่พร้อมใช้งาน กรุณาติดต่อแอดมิน";
    const { logger } = collectingLogger();
    const result = sanitizeTrpcErrorShape(shapeFor(message), { code: "INTERNAL_SERVER_ERROR" }, logger);
    expect(result.message).toBe(GENERIC_INTERNAL_ERROR_MESSAGE);
    expect(result.message).not.toBe(message);
  });

  it("a SERVICE_UNAVAILABLE message that itself looks like a raw database error is still sanitized (defense in depth is not bypassed by the new allowlist entry)", () => {
    const message = "Failed query: select `id` from `coupons`\nparams: 1";
    const result = sanitizeTrpcErrorShape(shapeFor(message), { code: "SERVICE_UNAVAILABLE" });
    expect(result.message).toBe(GENERIC_INTERNAL_ERROR_MESSAGE);
  });
});

describe("authGateCode - lets the client distinguish the mandatory Google-migration gate from any other FORBIDDEN", () => {
  it("a FORBIDDEN error with cause.code GOOGLE_CONNECTION_REQUIRED exposes it as data.authGateCode", () => {
    const message = "กรุณาเชื่อมบัญชี Google กับบัญชีเดิมของคุณก่อนใช้งานส่วนนี้";
    const error: any = { code: "FORBIDDEN", cause: { code: "GOOGLE_CONNECTION_REQUIRED" } };
    const result = sanitizeTrpcErrorShape(shapeFor(message), error);

    expect(result.data.authGateCode).toBe("GOOGLE_CONNECTION_REQUIRED");
    expect(result.message).toBe(message);
  });

  it("an ordinary FORBIDDEN (e.g. NOT_ADMIN_ERR_MSG, no cause at all) never gets an authGateCode", () => {
    const message = "Admin access required";
    const result = sanitizeTrpcErrorShape(shapeFor(message), { code: "FORBIDDEN" });

    expect(result.data.authGateCode).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("authGateCode");
  });

  it("a FORBIDDEN with an unrelated cause.code never gets an authGateCode either (only the exact literal is allowlisted)", () => {
    const result = sanitizeTrpcErrorShape(shapeFor("x"), { code: "FORBIDDEN", cause: { code: "SOMETHING_ELSE" } } as any);
    expect(result.data.authGateCode).toBeUndefined();
  });
});

describe("regression: payment.uploadSlipFile's customer-facing message must survive tRPC sanitization", () => {
  // Reproduces the exact defect: uploadPaymentSlipFile (slipFileUploadService.ts)
  // threw TRPCError({ code: "SERVICE_UNAVAILABLE" | "INTERNAL_SERVER_ERROR", message: <Thai> }),
  // and every one of those Thai messages was being silently replaced with
  // GENERIC_INTERNAL_ERROR_MESSAGE ("Unable to process this request at this
  // time. Please try again.") before ever reaching the browser - the exact
  // customer-visible symptom reported for the payment-slip-upload
  // regression, because SERVICE_UNAVAILABLE was missing from
  // CLIENT_SAFE_ERROR_CODES. This locks in both halves: the fix (the code
  // this feature actually uses now survives) and the regression it fixed
  // (the code it used to effectively behave like does not survive).
  const configMessage = "ระบบแนบสลิปยังไม่พร้อมใช้งาน กรุณาติดต่อแอดมิน";
  const temporaryMessage = "ไม่สามารถอัปโหลดสลิปได้ชั่วคราว กรุณาลองใหม่อีกครั้ง";

  it("the config-unavailable message (SERVICE_UNAVAILABLE) reaches the client unchanged", () => {
    const result = sanitizeTrpcErrorShape(shapeFor(configMessage), { code: "SERVICE_UNAVAILABLE" });
    expect(result.message).toBe(configMessage);
  });

  it("the temporary-upload-problem message (SERVICE_UNAVAILABLE) reaches the client unchanged", () => {
    const result = sanitizeTrpcErrorShape(shapeFor(temporaryMessage), { code: "SERVICE_UNAVAILABLE" });
    expect(result.message).toBe(temporaryMessage);
  });

  it("the same temporary-upload-problem message, if ever coded as INTERNAL_SERVER_ERROR again, would regress back to the generic English fallback", () => {
    const result = sanitizeTrpcErrorShape(shapeFor(temporaryMessage), { code: "INTERNAL_SERVER_ERROR" });
    expect(result.message).toBe(GENERIC_INTERNAL_ERROR_MESSAGE);
  });
});

describe("looksLikeRawDatabaseError - precision (no false positives on ordinary safe messages)", () => {
  it("detects drizzle's own leak signatures", () => {
    expect(looksLikeRawDatabaseError("Failed query: select `id` from `coupons`")).toBe(true);
    expect(looksLikeRawDatabaseError("something\nparams: 1,2,3")).toBe(true);
    expect(looksLikeRawDatabaseError("boom select `id` from `x`")).toBe(true);
    expect(looksLikeRawDatabaseError("mysql://user:pass@host:3306/db")).toBe(true);
  });

  it("does NOT flag ordinary application messages that happen to contain common English words", () => {
    // These are real, legitimate messages already used in this codebase's
    // allowlisted-code TRPCErrors - the detector must never neuter them.
    expect(looksLikeRawDatabaseError("Please select a payment method")).toBe(false);
    expect(looksLikeRawDatabaseError("Please update your shipping address")).toBe(false);
    expect(looksLikeRawDatabaseError("This episode has already been purchased")).toBe(false);
    expect(looksLikeRawDatabaseError("Your cart is empty")).toBe(false);
    expect(looksLikeRawDatabaseError("Invalid amount")).toBe(false);
  });

  it("handles non-string input safely", () => {
    expect(looksLikeRawDatabaseError(undefined)).toBe(false);
    expect(looksLikeRawDatabaseError(null)).toBe(false);
    expect(looksLikeRawDatabaseError(123)).toBe(false);
  });
});
