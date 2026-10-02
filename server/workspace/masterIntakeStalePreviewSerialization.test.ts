// IPE-061R1A — serialized STALE_PREVIEW detection: proves the exact HTTP
// serialization boundary for the Master Intake stale-preview error.
//
// Two stages are proven separately, matching production exactly:
//   1. procedure stage: mapWorkspaceError(WorkspaceMasterIntakeError) -> TRPCError
//   2. HTTP stage:      sanitizeTrpcErrorShape(shape, error) -> client shape
//
// The global sanitizer contract ("cause is never copied into the response")
// must hold: the client discriminator is data.code === "PRECONDITION_FAILED"
// and the raw cause object (carrying the STALE_PREVIEW literal) never
// crosses the boundary.

import { describe, expect, it } from "vitest";

import { WorkspaceMasterIntakeError } from "./masterIntake.service";
import { mapWorkspaceError } from "./router";
import { sanitizeTrpcErrorShape } from "../_core/trpc";

function serializeStalePreviewError() {
  let thrown: unknown;
  try {
    mapWorkspaceError(
      new WorkspaceMasterIntakeError(
        "STALE_PREVIEW",
        "Google Sheet or Workspace state changed after preview. Preview again before syncing."
      )
    );
  } catch (error) {
    thrown = error;
  }
  // The procedure stage must have produced a real TRPCError-shaped throw.
  expect((thrown as any)?.code).toBeDefined();

  const trpcError = thrown as { code: string; message: string; cause?: unknown };
  // Emulate the tRPC default error shape the HTTP adapter builds (including a
  // sensitive stack that must never ship).
  const shape = {
    message: trpcError.message,
    data: {
      code: trpcError.code,
      httpStatus: 412,
      path: "workspace.editorial.masterIntakeSync",
      stack: "SENSITIVE-STACK",
    },
  };
  return sanitizeTrpcErrorShape(shape, { code: trpcError.code, cause: trpcError.cause });
}

describe("IPE-061R1A serialized STALE_PREVIEW detection", () => {
  it("serializes the stale-preview error as data.code PRECONDITION_FAILED", () => {
    const serialized = serializeStalePreviewError();
    expect(serialized.data.code).toBe("PRECONDITION_FAILED");
    expect(serialized.message).toContain("Preview again before syncing");
  });

  it("never leaks the raw cause object or the STALE_PREVIEW literal across the boundary", () => {
    const serialized = serializeStalePreviewError();
    const json = JSON.stringify(serialized);
    expect(json).not.toContain("STALE_PREVIEW");
    expect(serialized.data).not.toHaveProperty("cause");
    expect(serialized).not.toHaveProperty("cause");
    // The only sanctioned cause-derived fields stay untouched/absent.
    expect(serialized.data.maintenanceCode).toBeUndefined();
    expect(serialized.data.authGateCode).toBeUndefined();
    // Stack never ships.
    expect(serialized.data.stack).toBeUndefined();
  });

  it("keeps non-stale Master Intake errors on their existing codes (no false recovery)", () => {
    let thrown: unknown;
    try {
      mapWorkspaceError(new WorkspaceMasterIntakeError("INVALID_RANGE", "Master Intake supports 1-100 rows per sync."));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as any).code).toBe("BAD_REQUEST");
  });
});
