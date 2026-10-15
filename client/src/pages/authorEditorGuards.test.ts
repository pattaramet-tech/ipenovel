import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { chapterEditorFindingRanges } from "./workspaceChapterEditor";
import {
  authorCanvasFindings,
  serializeChapterCanvasText,
  type ChapterCanvasParagraph,
} from "./workspaceChapterCanvas";
import {
  AuthorStageButton,
  authorAnchorNeedsDiscardConfirm,
  authorCanvasLoadDecision,
  authorMutationNotice,
  authorQcInteraction,
  confirmDiscardUnsavedEdits,
  createAuthorNavigationGuard,
} from "./authorEditorGuards";

function paragraphs(): ChapterCanvasParagraph[] {
  return [
    { id: "a", paragraphKey: "p-1", text: "ย่อหน้าแรกสะอาด" },
    { id: "b", paragraphKey: "p-2", text: "คำต่างประเทศอยู่ในย่อหน้าสอง" },
    { id: "c", paragraphKey: "p-3", text: "ย่อหน้าสาม" },
  ];
}

describe("author canvas finding coordinates", () => {
  it("places findings from later paragraphs after the earlier paragraph text", () => {
    const nodes = paragraphs();
    const text = serializeChapterCanvasText(nodes);
    const second = "คำต่างประเทศ";
    const third = "ย่อหน้าสาม";
    const ranges = authorCanvasFindings(nodes, [
      {
        sourceTabId: "tab-1",
        paragraphKey: "p-2",
        startOffset: 0,
        endOffset: second.length,
        token: second,
      },
      {
        sourceTabId: "tab-1",
        paragraphKey: "p-3",
        startOffset: 0,
        endOffset: third.length,
        token: third,
      },
      {
        sourceTabId: "tab-1",
        paragraphKey: "deleted",
        startOffset: 0,
        endOffset: 3,
        token: "ย่อห",
      },
      {
        sourceTabId: "tab-1",
        paragraphKey: "p-2",
        startOffset: 80,
        endOffset: 90,
        token: second,
      },
      {
        sourceTabId: "tab-9",
        paragraphKey: "p-2",
        startOffset: 0,
        endOffset: second.length,
        token: second,
      },
    ], "tab-1");
    const secondStart = text.indexOf(second);
    const thirdStart = text.indexOf(third);
    expect(secondStart).toBeGreaterThan(nodes[0]!.text.length);
    expect(ranges).toEqual([
      { startOffset: secondStart, endOffset: secondStart + second.length, token: second },
      { startOffset: thirdStart, endOffset: thirdStart + third.length, token: third },
    ]);
    expect(chapterEditorFindingRanges(text, ranges)).toEqual([
      { start: secondStart, end: secondStart + second.length },
      { start: thirdStart, end: thirdStart + third.length },
    ]);
  });
});

describe("author canvas load after a save attempt", () => {
  it("holds a dirty canvas when the save was rejected", () => {
    expect(authorCanvasLoadDecision({
      forceLoad: false,
      localDirty: true,
      acceptedSaveText: null,
      currentText: "edited",
    })).toBe("hold");
  });

  it("replaces the canvas when the confirmed save still matches the text", () => {
    expect(authorCanvasLoadDecision({
      forceLoad: false,
      localDirty: true,
      acceptedSaveText: "edited",
      currentText: "edited",
    })).toBe("replace");
  });

  it("keeps newer keystrokes after a confirmed save", () => {
    expect(authorCanvasLoadDecision({
      forceLoad: false,
      localDirty: true,
      acceptedSaveText: "edited",
      currentText: "edited more",
    })).toBe("keep-edits");
  });
});

describe("author unsaved navigation guard", () => {
  function harness() {
    const entries: Array<{ state: unknown; url: string }> = [
      { state: null, url: "http://localhost/home" },
      { state: null, url: "http://localhost/workspace" },
    ];
    let index = entries.length - 1;
    const listeners = new Map<string, Array<(event: any) => void>>();
    const documentListeners = new Map<string, Array<(event: any) => void>>();
    const location = { href: entries[index].url };
    const firePop = () => {
      for (const listener of [...(listeners.get("popstate") ?? [])]) {
        listener({ state: entries[index]?.state ?? null });
      }
    };
    const history = {
      get state() {
        return entries[index]?.state ?? null;
      },
      pushState(state: unknown, _title: string, url?: string | null) {
        entries.splice(index + 1);
        entries.push({ state, url: url || location.href });
        index += 1;
        location.href = entries[index].url;
      },
      back() {
        if (index === 0) return;
        index -= 1;
        location.href = entries[index].url;
        firePop();
      },
      forward() {
        if (index >= entries.length - 1) return;
        index += 1;
        location.href = entries[index].url;
        firePop();
      },
    };
    let dirty = false;
    let confirmed = false;
    const guard = createAuthorNavigationGuard({
      isDirty: () => dirty,
      confirmDiscard: () => confirmed,
      windowTarget: {
        location,
        history,
        addEventListener: (type, listener) => {
          listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        removeEventListener: (type, listener) => {
          listeners.set(type, (listeners.get(type) ?? []).filter(item => item !== listener));
        },
      },
      documentTarget: {
        addEventListener: (type, listener) => {
          documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
        },
        removeEventListener: (type, listener) => {
          documentListeners.set(type, (documentListeners.get(type) ?? []).filter(item => item !== listener));
        },
      },
    });
    const followLink = (href: string) => {
      const click = {
        defaultPrevented: false,
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        prevented: false,
        target: {
          closest: () => ({
            href,
            target: "",
            hasAttribute: () => false,
          }),
        },
        preventDefault() { click.prevented = true; },
        stopImmediatePropagation() { click.prevented = true; },
      };
      documentListeners.get("click")?.[0](click);
      if (!click.prevented) history.pushState(null, "", href);
      return click.prevented;
    };
    return {
      guard,
      listeners,
      documentListeners,
      history,
      followLink,
      url: () => location.href,
      index: () => index,
      setDirty: (value: boolean) => { dirty = value; },
      setConfirmed: (value: boolean) => { confirmed = value; },
    };
  }

  it("asks before leaving through an internal link and stays silent for a clean editor", () => {
    expect(authorAnchorNeedsDiscardConfirm({
      dirty: true,
      currentHref: "http://localhost/workspace",
      anchorHref: "http://localhost/admin/novels",
      anchorTarget: "",
      download: false,
    })).toBe(true);
    expect(authorAnchorNeedsDiscardConfirm({
      dirty: false,
      currentHref: "http://localhost/workspace",
      anchorHref: "http://localhost/admin/novels",
      anchorTarget: "",
      download: false,
    })).toBe(false);
  });

  it("blocks refresh while dirty and leaves the route in place", () => {
    const page = harness();
    page.setDirty(true);
    page.guard.sync(true);
    const event = { preventDefault: () => { event.blocked = true; }, returnValue: "x", blocked: false };
    page.listeners.get("beforeunload")?.[0](event);
    expect(event.blocked).toBe(true);
    expect(event.returnValue).toBe("");
    expect(page.url()).toBe("http://localhost/workspace");
  });

  it("removes the listeners on route unmount without moving history", () => {
    const page = harness();
    page.setDirty(true);
    page.guard.sync(true);
    const index = page.index();
    page.guard.release();
    expect(page.url()).toBe("http://localhost/workspace");
    expect(page.index()).toBe(index);
    expect(page.listeners.get("beforeunload")).toEqual([]);
    expect(page.listeners.get("popstate")).toEqual([]);
    expect(page.documentListeners.get("click")).toEqual([]);
  });

  it("does not warn after the editor is clean", () => {
    const page = harness();
    const event = { preventDefault: () => { event.blocked = true; }, returnValue: "x", blocked: false };
    page.listeners.get("beforeunload")?.[0](event);
    expect(event.blocked).toBe(false);
  });

  it("leaves the author page when Back is confirmed and keeps the dirty editor when Back is cancelled", () => {
    const page = harness();
    page.setDirty(true);
    page.guard.sync(true);
    page.history.back();
    expect(page.url()).toBe("http://localhost/workspace");
    expect(page.index()).toBe(2);
    page.setConfirmed(true);
    page.history.back();
    expect(page.url()).toBe("http://localhost/home");
    expect(page.index()).toBe(0);
  });

  it("stays on the author page with the dirty editor when Back is cancelled", () => {
    const page = harness();
    page.setDirty(true);
    page.guard.sync(true);
    page.setConfirmed(false);
    page.history.back();
    expect(page.url()).toBe("http://localhost/workspace");
    expect(page.index()).toBe(2);
    page.history.forward();
    expect(page.url()).toBe("http://localhost/workspace");
    expect(page.index()).toBe(2);
  });

  it("removes only the unsaved sentinel on save, then Back leaves and Forward returns", () => {
    const page = harness();
    page.setDirty(true);
    page.guard.sync(true);
    expect(page.index()).toBe(2);
    page.setDirty(false);
    page.guard.sync(false);
    expect(page.url()).toBe("http://localhost/workspace");
    expect(page.index()).toBe(1);
    page.history.forward();
    expect(page.url()).toBe("http://localhost/workspace");
    page.history.back();
    expect(page.url()).toBe("http://localhost/workspace");
    page.history.back();
    expect(page.url()).toBe("http://localhost/home");
  });

  it("does not call back when a later unrelated history entry is current", () => {
    const page = harness();
    page.setDirty(true);
    page.guard.sync(true);
    page.history.pushState({ other: true }, "", "http://localhost/elsewhere");
    page.setDirty(false);
    page.guard.sync(false);
    expect(page.url()).toBe("http://localhost/elsewhere");
    expect(page.index()).toBe(3);
  });

  it("follows a confirmed internal link and blocks a cancelled one", () => {
    const cancelled = harness();
    cancelled.setDirty(true);
    cancelled.guard.sync(true);
    expect(cancelled.followLink("http://localhost/admin/novels")).toBe(true);
    expect(cancelled.url()).toBe("http://localhost/workspace");

    const confirmed = harness();
    confirmed.setDirty(true);
    confirmed.guard.sync(true);
    confirmed.setConfirmed(true);
    expect(confirmed.followLink("http://localhost/admin/novels")).toBe(false);
    expect(confirmed.url()).toBe("http://localhost/admin/novels");
    const index = confirmed.index();
    confirmed.guard.release();
    expect(confirmed.url()).toBe("http://localhost/admin/novels");
    expect(confirmed.index()).toBe(index);
  });

  it("does not warn for a link click after a successful save", () => {
    const page = harness();
    page.setDirty(true);
    page.guard.sync(true);
    page.setDirty(false);
    page.guard.sync(false);
    expect(page.followLink("http://localhost/admin/novels")).toBe(false);
    expect(page.url()).toBe("http://localhost/admin/novels");
  });
});

describe("author unsaved edit navigation", () => {
  it("leaves a clean editor without asking", () => {
    let asked = false;
    expect(confirmDiscardUnsavedEdits(false, () => {
      asked = true;
      return false;
    })).toBe(true);
    expect(asked).toBe(false);
  });

  it("stays when the author declines to discard", () => {
    expect(confirmDiscardUnsavedEdits(true, () => false)).toBe(false);
  });

  it("leaves when the author confirms the discard", () => {
    expect(confirmDiscardUnsavedEdits(true, () => true)).toBe(true);
  });
});

describe("author QC while the canvas is dirty", () => {
  it("hides findings and disables resolution while the local canvas is dirty", () => {
    expect(authorQcInteraction({
      dirty: true,
      isCurrent: true,
      canResolveFindings: true,
    })).toEqual({
      showFindings: false,
      canMarkFixed: false,
      canConfirmSourceNote: false,
      status: "Save the draft before resolving QC findings.",
    });
  });

  it("restores current-run findings only after the canvas is clean and the run is current", () => {
    expect(authorQcInteraction({
      dirty: false,
      isCurrent: true,
      canResolveFindings: true,
    })).toEqual({
      showFindings: true,
      canMarkFixed: true,
      canConfirmSourceNote: true,
      status: null,
    });
  });

  it("keeps stale server findings hidden after the canvas is saved", () => {
    expect(authorQcInteraction({
      dirty: false,
      isCurrent: false,
      canResolveFindings: false,
    })).toEqual({
      showFindings: false,
      canMarkFixed: false,
      canConfirmSourceNote: false,
      status: null,
    });
  });
});

describe("author mutation notices", () => {
  it("stays silent while the request is still pending", () => {
    expect(authorMutationNotice("pending", "Save")).toBeNull();
  });

  it("reports success only for a completed server response", () => {
    expect(authorMutationNotice("success", "Stage")).toEqual({
      role: "status",
      text: "Stage completed.",
    });
  });

  it("shows the server message for a failed action", () => {
    expect(authorMutationNotice("error", "Save", "Draft version conflict")).toEqual({
      role: "alert",
      text: "Save failed: Draft version conflict",
    });
    expect(authorMutationNotice("error", "Undo", "  ")).toEqual({
      role: "alert",
      text: "Undo failed.",
    });
  });
});

describe("author Stage button", () => {
  function markup(props: {
    busy?: boolean;
    dirty?: boolean;
    stageActionReady: boolean;
    approvalId: number | null;
  }) {
    return renderToStaticMarkup(createElement(AuthorStageButton, {
      busy: props.busy ?? false,
      dirty: props.dirty ?? false,
      stageActionReady: props.stageActionReady,
      approvalId: props.approvalId,
      onStage: () => {},
    }));
  }

  function isDisabled(html: string) {
    return /<button\b[^>]*\sdisabled=""/.test(html);
  }

  it("is enabled for the first Stage when the action is ready", () => {
    const html = markup({ stageActionReady: true, approvalId: 9 });
    expect(html).toContain(">Stage</button>");
    expect(isDisabled(html)).toBe(false);
  });

  it("stays enabled after a valid Stage so replay can be sent", () => {
    expect(isDisabled(markup({ stageActionReady: true, approvalId: 9 }))).toBe(false);
  });

  it("is disabled when approval is stale or the plan is not ready", () => {
    expect(isDisabled(markup({ stageActionReady: false, approvalId: 9 }))).toBe(true);
  });

  it("is disabled without an approval id, while busy, or while the canvas is dirty", () => {
    expect(isDisabled(markup({ stageActionReady: true, approvalId: null }))).toBe(true);
    expect(isDisabled(markup({ stageActionReady: true, approvalId: 9, busy: true }))).toBe(true);
    expect(isDisabled(markup({ stageActionReady: true, approvalId: 9, dirty: true }))).toBe(true);
  });
});
