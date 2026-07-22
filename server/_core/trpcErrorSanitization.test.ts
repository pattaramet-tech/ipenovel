import { describe, it, expect } from "vitest";
import { sanitizeTrpcErrorShape, GENERIC_INTERNAL_ERROR_MESSAGE } from "./trpc";

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
  const safeCodes = ["UNAUTHORIZED", "FORBIDDEN", "BAD_REQUEST", "NOT_FOUND", "CONFLICT"];

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
