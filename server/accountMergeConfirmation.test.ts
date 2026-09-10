import { describe, expect, it } from "vitest";
import {
  buildAccountMergeConfirmationText,
  isAccountMergeConfirmationExact,
} from "../shared/accountMergeConfirmation";

describe("Advanced Account Merge typed confirmation", () => {
  it("builds the exact irreversible Donor->Survivor confirmation", () => {
    expect(buildAccountMergeConfirmationText(12, 34)).toBe(
      "DONOR:12->SURVIVOR:34"
    );
  });

  it("accepts only the exact Donor/Survivor pair after trimming outer whitespace", () => {
    expect(
      isAccountMergeConfirmationExact(12, 34, "DONOR:12->SURVIVOR:34")
    ).toBe(true);
    expect(
      isAccountMergeConfirmationExact(12, 34, "  DONOR:12->SURVIVOR:34  ")
    ).toBe(true);
    expect(
      isAccountMergeConfirmationExact(12, 34, "DONOR:34->SURVIVOR:12")
    ).toBe(false);
    expect(isAccountMergeConfirmationExact(12, 34, "12->34")).toBe(false);
    expect(
      isAccountMergeConfirmationExact(12, 34, "DONOR:12 -> SURVIVOR:34")
    ).toBe(false);
    expect(
      isAccountMergeConfirmationExact(12, 34, "SOURCE:12->TARGET:34")
    ).toBe(false);
  });
});
