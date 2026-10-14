import React from "react";
import { Button } from "@/components/ui/button";

/**
 * replace: load the server canvas.
 * keep-edits: a confirmed save landed, and the author typed more. Move the
 * baseline to the server text and keep the newer keystrokes.
 * hold: the canvas is dirty and no confirmed save or navigation allows a load.
 */
export function authorCanvasLoadDecision(input: {
  forceLoad: boolean;
  localDirty: boolean;
  acceptedSaveText: string | null;
  currentText: string;
}): "replace" | "keep-edits" | "hold" {
  if (input.forceLoad || !input.localDirty) return "replace";
  if (input.acceptedSaveText == null) return "hold";
  if (input.currentText === input.acceptedSaveText) return "replace";
  return "keep-edits";
}

/** Leave a dirty editor only after an explicit discard confirmation. */
export function confirmDiscardUnsavedEdits(dirty: boolean, ask: () => boolean) {
  if (!dirty) return true;
  return ask();
}

/**
 * Pending stays silent. Success is reported only after the server responds.
 * Errors include the server message when it sent one.
 */
export function authorMutationNotice(
  phase: "pending" | "success" | "error",
  action: string,
  serverMessage?: string | null,
) {
  if (phase === "pending") return null;
  if (phase === "success") {
    return { role: "status" as const, text: `${action} completed.` };
  }
  const detail = serverMessage?.trim();
  return {
    role: "alert" as const,
    text: detail ? `${action} failed: ${detail}` : `${action} failed.`,
  };
}

export function AuthorStageButton({
  busy,
  dirty,
  stageActionReady,
  approvalId,
  onStage,
}: {
  busy: boolean;
  dirty: boolean;
  stageActionReady: boolean;
  approvalId: number | null;
  onStage: () => void;
}) {
  return (
    <Button
      type="button"
      data-testid="author-stage"
      disabled={busy || dirty || !stageActionReady || approvalId == null}
      onClick={onStage}
    >
      Stage
    </Button>
  );
}
