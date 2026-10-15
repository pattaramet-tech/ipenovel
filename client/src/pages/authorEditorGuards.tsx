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

export function authorAnchorNeedsDiscardConfirm(input: {
  dirty: boolean;
  currentHref: string;
  anchorHref: string;
  anchorTarget: string;
  download: boolean;
}) {
  if (!input.dirty || input.anchorTarget === "_blank" || input.download) return false;
  const current = new URL(input.currentHref);
  const destination = new URL(input.anchorHref, input.currentHref);
  if (destination.href === current.href) return false;
  if (
    destination.pathname === current.pathname &&
    destination.search === current.search &&
    destination.hash !== current.hash
  ) {
    return false;
  }
  return true;
}

const AUTHOR_HISTORY_SENTINEL = { ipe070AuthorUnsaved: true };

type NavigationHistory = {
  readonly state: unknown;
  pushState: (state: unknown, title: string, url?: string | null) => void;
  back: () => void;
};

type NavigationWindow = {
  addEventListener: (type: string, listener: (event: any) => void) => void;
  removeEventListener: (type: string, listener: (event: any) => void) => void;
  history: NavigationHistory;
  location: { href: string };
};

type NavigationDocument = {
  addEventListener: (type: string, listener: (event: any) => void, capture?: boolean) => void;
  removeEventListener: (type: string, listener: (event: any) => void, capture?: boolean) => void;
};

function historySentinelIsCurrent(history: NavigationHistory) {
  const state = history.state as { ipe070AuthorUnsaved?: boolean } | null;
  return state?.ipe070AuthorUnsaved === true;
}

/**
 * Browser refresh, close, in-app links, and back/forward while the canvas is dirty.
 * The sentinel is an extra entry for this author URL only. Save pops it only while
 * it is still the current entry. A later unrelated entry is left alone.
 * Confirming Back pops once more so the previous route becomes current.
 */
export function createAuthorNavigationGuard(input: {
  isDirty: () => boolean;
  confirmDiscard: () => boolean;
  windowTarget: NavigationWindow;
  documentTarget: NavigationDocument;
}) {
  let ownsSentinel = false;
  let ignoreNextPop = false;
  let leaving = false;
  const authorUrl = input.windowTarget.location.href;
  const history = input.windowTarget.history;
  const sync = (dirty: boolean) => {
    if (leaving) return;
    if (dirty) {
      if (historySentinelIsCurrent(history)) {
        ownsSentinel = true;
        return;
      }
      history.pushState(AUTHOR_HISTORY_SENTINEL, "", input.windowTarget.location.href);
      ownsSentinel = true;
      return;
    }
    if (!ownsSentinel || !historySentinelIsCurrent(history)) {
      ownsSentinel = false;
      return;
    }
    ownsSentinel = false;
    ignoreNextPop = true;
    history.back();
  };
  const beforeUnload = (event: { preventDefault: () => void; returnValue: string }) => {
    if (!input.isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  const onPop = () => {
    if (ignoreNextPop) {
      ignoreNextPop = false;
      ownsSentinel = false;
      return;
    }
    if (leaving || !input.isDirty()) {
      ownsSentinel = historySentinelIsCurrent(history);
      return;
    }
    const stayedOnAuthor = input.windowTarget.location.href === authorUrl;
    if (!stayedOnAuthor) {
      if (input.confirmDiscard()) {
        leaving = true;
        ownsSentinel = false;
        return;
      }
      history.pushState(AUTHOR_HISTORY_SENTINEL, "", authorUrl);
      ownsSentinel = true;
      return;
    }
    if (input.confirmDiscard()) {
      leaving = true;
      ownsSentinel = false;
      history.back();
      return;
    }
    history.pushState(AUTHOR_HISTORY_SENTINEL, "", authorUrl);
    ownsSentinel = true;
  };
  const onClick = (event: {
    defaultPrevented: boolean;
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    target: { closest?: (selector: string) => {
      href?: string;
      target?: string;
      hasAttribute?: (name: string) => boolean;
    } | null } | null;
    preventDefault: () => void;
    stopImmediatePropagation: () => void;
  }) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const anchor = event.target?.closest?.("a[href]");
    if (!anchor?.href) return;
    if (!authorAnchorNeedsDiscardConfirm({
      dirty: input.isDirty(),
      currentHref: input.windowTarget.location.href,
      anchorHref: anchor.href,
      anchorTarget: anchor.target ?? "",
      download: anchor.hasAttribute?.("download") ?? false,
    })) {
      return;
    }
    if (input.confirmDiscard()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  input.windowTarget.addEventListener("beforeunload", beforeUnload);
  input.windowTarget.addEventListener("popstate", onPop);
  input.documentTarget.addEventListener("click", onClick, true);
  return {
    sync,
    release() {
      input.windowTarget.removeEventListener("beforeunload", beforeUnload);
      input.windowTarget.removeEventListener("popstate", onPop);
      input.documentTarget.removeEventListener("click", onClick, true);
    },
  };
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

/**
 * Local edits suspend QC actions even when the last server run is current.
 * Findings return only when the canvas is clean and that run is still current.
 */
export function authorQcInteraction(input: {
  dirty: boolean;
  isCurrent: boolean;
  canResolveFindings: boolean;
}) {
  const showFindings = !input.dirty && input.isCurrent;
  return {
    showFindings,
    canMarkFixed: showFindings && input.canResolveFindings,
    canConfirmSourceNote: showFindings,
    status: input.dirty ? "Save the draft before resolving QC findings." : null,
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
