import { describe, expect, it } from "vitest";
import {
  buildAccountMergeConfirmationText,
  isAccountMergeConfirmationExact,
} from "../shared/accountMergeConfirmation";

describe("Advanced Account Merge typed confirmation", () => {
  it("builds the exact irreversible Source->Target confirmation", () => {
    expect(buildAccountMergeConfirmationText(12, 34)).toBe(
      "SOURCE:12->TARGET:34"
    );
  });

  it("accepts only the exact Source/Target pair after trimming outer whitespace", () => {
    expect(
      isAccountMergeConfirmationExact(12, 34, "SOURCE:12->TARGET:34")
    ).toBe(true);
    expect(
      isAccountMergeConfirmationExact(12, 34, "  SOURCE:12->TARGET:34  ")
    ).toBe(true);
    expect(
      isAccountMergeConfirmationExact(12, 34, "SOURCE:34->TARGET:12")
    ).toBe(false);
    expect(isAccountMergeConfirmationExact(12, 34, "12->34")).toBe(false);
    expect(
      isAccountMergeConfirmationExact(12, 34, "SOURCE:12 -> TARGET:34")
    ).toBe(false);
  });
});
