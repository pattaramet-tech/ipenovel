import { describe, it, expect } from "vitest";
import { isDuplicateKeyError } from "./databaseErrorClassifier";

/**
 * Regression coverage for the dead-guard bug this helper exists to fix.
 *
 * Every duplicate-key recovery branch in server/db.ts used to read only the
 * TOP-LEVEL error's errno/code. drizzle-orm wraps the mysql2 driver error,
 * so those fields are undefined on the caught error and the real
 * 1062/ER_DUP_ENTRY only appears on `error.cause` - which meant the
 * recovery branches never executed. The "nested cause" cases below are the
 * exact shape observed from a real concurrent daily check-in claim.
 */

describe("isDuplicateKeyError", () => {
  describe("direct (unwrapped) driver errors", () => {
    it("detects a direct numeric errno 1062", () => {
      expect(isDuplicateKeyError({ errno: 1062 })).toBe(true);
    });

    it("detects a direct ER_DUP_ENTRY code", () => {
      expect(isDuplicateKeyError({ code: "ER_DUP_ENTRY" })).toBe(true);
    });

    it("detects a real-shaped mysql2 error object", () => {
      expect(
        isDuplicateKeyError({
          errno: 1062,
          code: "ER_DUP_ENTRY",
          sqlState: "23000",
          sqlMessage: "Duplicate entry '1-2026-07-22-default' for key 'unique_daily_checkin_user_date_campaign'",
        })
      ).toBe(true);
    });
  });

  describe("wrapped (drizzle) driver errors - the bug this helper fixes", () => {
    it("detects errno 1062 one level down on cause", () => {
      // The exact observed shape: top level is blank, cause carries the truth.
      const wrapped = { errno: undefined, code: undefined, cause: { errno: 1062, code: "ER_DUP_ENTRY" } };
      expect(isDuplicateKeyError(wrapped)).toBe(true);
    });

    it("detects ER_DUP_ENTRY one level down on cause", () => {
      expect(isDuplicateKeyError({ cause: { code: "ER_DUP_ENTRY" } })).toBe(true);
    });

    it("detects a deeply nested cause (3 levels)", () => {
      expect(isDuplicateKeyError({ cause: { cause: { cause: { errno: 1062 } } } })).toBe(true);
    });

    it("detects a real Error instance carrying a driver cause", () => {
      const driverError: any = new Error("Duplicate entry");
      driverError.errno = 1062;
      driverError.code = "ER_DUP_ENTRY";
      const wrapped = new Error("Failed query: insert into `dailyCheckins` ...", { cause: driverError });
      expect(isDuplicateKeyError(wrapped)).toBe(true);
    });

    it("gives up past the traversal depth cap instead of walking forever", () => {
      // 12 links deep - beyond MAX_CAUSE_DEPTH (8), so deliberately NOT detected.
      let deep: any = { errno: 1062 };
      for (let i = 0; i < 12; i += 1) deep = { cause: deep };
      expect(isDuplicateKeyError(deep)).toBe(false);
    });
  });

  describe("numeric-string errno", () => {
    it('detects errno as the string "1062"', () => {
      expect(isDuplicateKeyError({ errno: "1062" })).toBe(true);
    });

    it('detects a padded string errno " 1062 "', () => {
      expect(isDuplicateKeyError({ errno: " 1062 " })).toBe(true);
    });

    it('does NOT treat "1062 rows affected" as a duplicate-key errno', () => {
      // parseInt() would return 1062 here - the regex deliberately does not.
      expect(isDuplicateKeyError({ errno: "1062 rows affected" })).toBe(false);
    });
  });

  describe("must NOT false-positive", () => {
    it("rejects an unrelated driver error (ER_NO_SUCH_TABLE)", () => {
      expect(isDuplicateKeyError({ errno: 1146, code: "ER_NO_SUCH_TABLE" })).toBe(false);
    });

    it("rejects a lock-wait timeout", () => {
      expect(isDuplicateKeyError({ errno: 1205, code: "ER_LOCK_WAIT_TIMEOUT" })).toBe(false);
    });

    it("rejects a deadlock", () => {
      expect(isDuplicateKeyError({ errno: 1213, code: "ER_LOCK_DEADLOCK" })).toBe(false);
    });

    it("rejects a connection error", () => {
      expect(isDuplicateKeyError({ code: "ECONNREFUSED", errno: -4078 })).toBe(false);
    });

    it("rejects a generic application validation error", () => {
      expect(isDuplicateKeyError(new Error("Coupon has invalid discount value"))).toBe(false);
    });

    it('rejects a validation message that merely contains the word "unique"', () => {
      // Message text is never consulted - this is the false-positive class
      // the message-matching approach suffered from.
      expect(isDuplicateKeyError(new Error("Email address must be unique"))).toBe(false);
    });

    it('rejects a message mentioning "Duplicate entry" with no driver fields', () => {
      expect(isDuplicateKeyError(new Error("Duplicate entry detected by application logic"))).toBe(false);
    });
  });

  describe("malformed and hostile inputs are safe", () => {
    it("handles a self-referencing (cyclic) cause chain without hanging", () => {
      const a: any = { code: "ER_SOMETHING" };
      const b: any = { code: "ER_OTHER", cause: a };
      a.cause = b; // cycle
      expect(isDuplicateKeyError(a)).toBe(false);
    });

    it("still detects a duplicate that appears before the cycle closes", () => {
      const a: any = { code: "ER_OTHER" };
      const b: any = { errno: 1062, cause: a };
      a.cause = b; // cycle
      expect(isDuplicateKeyError(a)).toBe(true);
    });

    it("handles null", () => {
      expect(isDuplicateKeyError(null)).toBe(false);
    });

    it("handles undefined", () => {
      expect(isDuplicateKeyError(undefined)).toBe(false);
    });

    it("handles a string input", () => {
      expect(isDuplicateKeyError("ER_DUP_ENTRY")).toBe(false);
    });

    it("handles a number input", () => {
      expect(isDuplicateKeyError(1062)).toBe(false);
    });

    it("handles an empty plain object", () => {
      expect(isDuplicateKeyError({})).toBe(false);
    });

    it("handles an object whose cause is a string", () => {
      expect(isDuplicateKeyError({ cause: "ER_DUP_ENTRY" })).toBe(false);
    });

    it("handles an object whose cause is null", () => {
      expect(isDuplicateKeyError({ cause: null })).toBe(false);
    });
  });
});
