import { describe, expect, it } from "vitest";
import { hasRepairTriggerVisibility } from "../scripts/lib/legacySlipRepairTriggerVisibility";

describe("literal current-user SHOW GRANTS proof, never log these strings", () => {
  it.each([
    "GRANT ALL PRIVILEGES ON *.* TO `root`@`%` IDENTIFIED BY PASSWORD '*PRIVATE_HASH' WITH GRANT OPTION",
    "GRANT SELECT, TRIGGER ON `ipenovel`.* TO `repair`@`localhost`",
    "GRANT TRIGGER ON *.* TO 'repair'@'%' REQUIRE SSL",
    "GRANT TRIGGER ON `ipenovel`.* TO `name``quoted`@`%`",
    "GRANT TRIGGER ON *.* TO 'name''quoted'@'%'",
  ])("accepts scoped direct privilege %s", grant => {
    expect(hasRepairTriggerVisibility([{ Grants: grant }])).toBe(true);
  });
  it.each([
    "GRANT SELECT, UPDATE, INSERT ON `ipenovel`.* TO `repair`@`%`",
    "GRANT TRIGGER ON `other`.* TO `repair`@`%`",
    "GRANT TRIGGER ON `ipe%`.* TO `repair`@`%`",
    "GRANT TRIGGER ON `ipenovel`.`payments` TO `repair`@`%`",
    "GRANT TRIGGER ON PROCEDURE `ipenovel`.* TO `repair`@`%`",
    "GRANT TRIGGER (`column`) ON `ipenovel`.* TO `repair`@`%`",
    "GRANT `TRIGGER` TO `repair`@`%`",
    "GRANT ALL PRIVILEGES ON `ipenovel`.* TO PUBLIC",
    "GRANT TRIGGER ON *.* TO repair@localhost",
    "GRANT TRIGGER ON *.* TO `repair`@`%`malformed",
    "GRANT TRIGGER ON *.* TO `repair`@`%",
    "GRANT NOT_TRIGGER ON *.* TO `repair`@`%`",
    "GRANT SELECT ON *.* TO `TRIGGER`@`%`",
    "GRANT SELECT ON *.* TO `repair`@`%` IDENTIFIED BY 'TRIGGER'",
    "garbage GRANT TRIGGER ON *.* TO `repair`@`%`",
    "GRANT TRIGGER ON *.* TO `repair`@`%`\nPRIVATE",
  ])("rejects insufficient/malformed proof %s", grant => {
    expect(hasRepairTriggerVisibility([{ Grants: grant }])).toBe(false);
  });
  it.each([
    null,
    {},
    [],
    [null],
    [{ a: 1 }],
    [{ a: "x", b: "y" }],
    [{ a: "x".repeat(32769) }],
    Array(257).fill({ a: "x" }),
  ])("rejects malformed bounded rows %#", rows => {
    expect(hasRepairTriggerVisibility(rows)).toBe(false);
  });
});
