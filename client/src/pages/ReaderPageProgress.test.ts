// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, render } from "@testing-library/react";

/**
 * Component-level regression suite for the ReaderPage progress-save wiring
 * (R1 independent-review repairs).
 *
 * The two P1s these tests pin down:
 *  1. Mutation reference instability: flushProgressSave used to depend on
 *     the tRPC mutation RESULT object, whose identity changes on every
 *     render. Every setLivePercent re-render then tore the lifecycle effect
 *     down, and its cleanup cleared the freshly-armed scroll debounce - so
 *     the debounced save NEVER fired from scrolling. The mocked useMutation
 *     below deliberately returns a fresh object per render to reproduce
 *     that churn; with the controller wiring the debounce survives.
 *  2. Cross-episode navigation: leaving an episode (SPA param change or
 *     unmount) must best-effort save the outgoing episode's pending under
 *     ITS episode id, and a still-airborne old flight must never save the
 *     new episode's pending.
 */

const state = vi.hoisted(() => {
  const flights: Array<{
    input: {
      episodeId: number;
      progressPercent: number;
      scrollPosition: number;
      currentChapterNumber?: string;
      currentChapterTitle?: string;
      anchorKey?: string;
    };
    handlers: { onSuccess(): void; onError(): void; onSettled(): void };
  }> = [];
  // When true, each mutate settles synchronously (success). When false the
  // flight stays airborne until the test settles it manually.
  let autoSettle = true;
  const saveMutate = vi.fn(
    (
      input: (typeof flights)[number]["input"],
      handlers: (typeof flights)[number]["handlers"]
    ) => {
      flights.push({ input, handlers });
      if (autoSettle) {
        handlers.onSuccess();
        handlers.onSettled();
      }
    }
  );
  return {
    episodeId: 1,
    user: { id: "u1", email: "u1@ipe.local", role: "user" as const },
    // "loading" reproduces the initial skeleton render (getEpisode still
    // pending): the episode/user reset effect is written while canRead is
    // still false, and only later renders flip canRead true WITHOUT the
    // effect re-running.
    episodePhase: "resolved" as "resolved" | "loading",
    progressData: null as null | {
      progressPercent: number;
      scrollPosition: number | null;
      currentChapterNumber: string | null;
      currentChapterTitle: string | null;
      anchorKey: string | null;
      lastReadAt: string;
    },
    flights,
    saveMutate,
    setAutoSettle: (v: boolean) => {
      autoSettle = v;
    },
    resetFlights: () => {
      flights.length = 0;
      saveMutate.mockClear();
    },
  };
});

vi.mock("@/lib/trpc", () => {
  const episodePayload = () => ({
    episode: { id: state.episodeId, episodeNumber: 1, title: "ตอนที่ 1", price: "0", isFree: true, fileUrl: null },
    novel: { id: 11, title: "นิยายทดสอบ" },
    previousEpisode: null,
    nextEpisode: null,
    walletBalance: "0",
    canRead: true,
    isLocked: false,
    content: "ย่อหน้าที่หนึ่ง\nย่อหน้าที่สอง\nย่อหน้าที่สาม\n",
    preview: "",
    saleMode: "chapter",
  });
  const noop = () => {};
  return {
    trpc: {
      useUtils: () => ({
        reader: { getEpisode: { invalidate: noop } },
        novels: { episodes: { invalidate: noop } },
        wallet: { getBalance: { invalidate: noop }, getSummary: { invalidate: noop } },
        myNovels: { list: { invalidate: noop } },
      }),
      reader: {
        getEpisode: {
          useQuery: () =>
            state.episodePhase === "loading"
              ? { data: undefined, isLoading: true, error: null }
              : { data: episodePayload(), isLoading: false, error: null },
        },
        getProgress: { useQuery: () => ({ data: state.progressData, isLoading: false, error: null }) },
        saveProgress: {
          // Fresh object per render ON PURPOSE - mirrors the real tRPC
          // mutation result churn that used to break the debounce.
          useMutation: () => ({ mutate: state.saveMutate, isPending: false, mutateAsync: noop }),
        },
        purchaseEpisode: { useMutation: () => ({ mutate: noop, isPending: false, mutateAsync: noop }) },
      },
    },
  };
});

vi.mock("wouter", () => ({
  useParams: () => ({ episodeId: String(state.episodeId) }),
  useLocation: () => ["/read/" + state.episodeId, vi.fn()],
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: state.user }),
}));

vi.mock("@/_core/hooks/useReadingLease", () => ({
  useReadingLease: () => ({ leaseState: { phase: "idle" as const }, transferLease: vi.fn() }),
}));

vi.mock("@/contexts/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useReaderPreferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useReaderPreferences")>();
  return {
    ...actual,
    useReaderPreferences: () => ({
      preferences: actual.DEFAULT_READER_PREFERENCES,
      updatePreference: vi.fn(),
      resetPreferences: vi.fn(),
    }),
  };
});

vi.mock("@/hooks/useDocumentHead", () => ({ useDocumentHead: () => {} }));

vi.mock("@/components/MaintenanceAnnouncementBanner", () => ({
  MAINTENANCE_BANNER_HEIGHT_CSS_VAR: "--test-maintenance-banner",
}));

vi.mock("@/components/LanguageSwitcher", () => ({ default: () => null }));
vi.mock("@/components/ReaderSettings", () => ({ default: () => null }));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import ReaderPage from "./ReaderPage";

// jsdom ships no ResizeObserver; the header/nav measurement observers just
// never fire in this harness.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const SCROLL_DEBOUNCE_MS = 1500;

function getScrollContainer(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="reader-scroll-container"]');
  if (!el) throw new Error("scroll container not mounted (episode not readable yet?)");
  return el;
}

/** jsdom has no layout: drive the reader's scroll math from explicit getters. */
function setScrollMetrics(scrollTop: number, scrollHeight = 20000, clientHeight = 800) {
  const el = getScrollContainer();
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => scrollTop });
}

/**
 * Writable scrollTop (counting sets) for resume tests: the verifier's
 * re-assert writes container.scrollTop, so the test must observe writes.
 */
function setWritableScroll(scrollHeight = 20000, clientHeight = 800) {
  const el = getScrollContainer();
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
  let current = 0;
  let setCount = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => current,
    set: (v: number) => {
      current = v;
      setCount += 1;
    },
  });
  return { setCount: () => setCount, current: () => current };
}

function fireScroll() {
  act(() => {
    getScrollContainer().dispatchEvent(new Event("scroll"));
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  state.resetFlights();
  state.setAutoSettle(true);
  state.episodePhase = "resolved";
  state.progressData = null;
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  state.episodeId = 1;
  state.episodePhase = "resolved";
  state.progressData = null;
});

describe("ReaderPage progress-save wiring (component-level, fake timers)", () => {
  it("scroll burst -> setLivePercent re-renders -> the 1.5s debounce STILL fires the save with the latest position", () => {
    const view = render(React.createElement(ReaderPage));

    // Three scroll stops at different offsets: each dispatch runs
    // setLivePercent with a NEW value, so the component genuinely
    // re-renders between dispatches (React bails out on identical state).
    // Pre-repair, every one of those re-renders tore the lifecycle effect
    // down and cleared the just-armed debounce timer - the save below
    // never happened.
    setScrollMetrics(2000);
    fireScroll();
    setScrollMetrics(4000);
    fireScroll();
    setScrollMetrics(6000);
    fireScroll();

    advance(SCROLL_DEBOUNCE_MS - 1);
    expect(state.saveMutate).not.toHaveBeenCalled();

    advance(1);
    expect(state.saveMutate).toHaveBeenCalledTimes(1);
    // latest pending only: 6000 / (20000 - 800) = 31.25%
    expect(state.flights[0].input.episodeId).toBe(1);
    expect(state.flights[0].input.scrollPosition).toBe(6000);
    expect(state.flights[0].input.progressPercent).toBeCloseTo(31.25, 5);

    view.unmount();
  });

  it("SPA navigation to another episode BEFORE the debounce fires force-saves episode A's pending under A's id, then nothing further fires", () => {
    const view = render(React.createElement(ReaderPage));

    setScrollMetrics(2500);
    fireScroll();
    expect(state.saveMutate).not.toHaveBeenCalled(); // debounce pending

    // Navigate: same component, new route param. The episode/user reset
    // effect's cleanup must best-effort save the OUTGOING episode's
    // position (dispose) synchronously under episode 1's context.
    state.episodeId = 2;
    act(() => {
      view.rerender(React.createElement(ReaderPage));
    });
    expect(state.saveMutate).toHaveBeenCalledTimes(1);
    expect(state.flights[0].input.episodeId).toBe(1);
    expect(state.flights[0].input.scrollPosition).toBe(2500);

    // The old debounce is gone and episode B has no pending: advancing the
    // old debounce window must not produce a second save.
    advance(SCROLL_DEBOUNCE_MS * 3);
    expect(state.saveMutate).toHaveBeenCalledTimes(1);

    view.unmount();
  });

  it("unmount force-saves the current pending position (local recovery alone is not the API contract)", () => {
    const view = render(React.createElement(ReaderPage));

    setScrollMetrics(1500);
    fireScroll();
    expect(state.saveMutate).not.toHaveBeenCalled();

    act(() => {
      view.unmount();
    });
    expect(state.saveMutate).toHaveBeenCalledTimes(1);
    expect(state.flights[0].input.episodeId).toBe(1);
    expect(state.flights[0].input.scrollPosition).toBe(1500);

    // Nothing may fire after unmount (timers cleared).
    advance(SCROLL_DEBOUNCE_MS * 3);
    expect(state.saveMutate).toHaveBeenCalledTimes(1);
  });

  it("a localStorage SecurityError never breaks reading or saving - the save still issues", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("Access is denied", "SecurityError");
      },
    });
    try {
      const view = render(React.createElement(ReaderPage));
      setScrollMetrics(3000);
      expect(() => fireScroll()).not.toThrow();
      advance(SCROLL_DEBOUNCE_MS);
      expect(state.saveMutate).toHaveBeenCalledTimes(1);
      view.unmount();
    } finally {
      if (original) {
        Object.defineProperty(window, "localStorage", original);
      }
    }
  });

  it("airborne episode-A flight settling after navigation saves episode B's queued position WITHOUT another scroll (cross-generation queue)", () => {
    state.setAutoSettle(false); // flights stay airborne until settled manually
    const view = render(React.createElement(ReaderPage));

    setScrollMetrics(2000);
    fireScroll();
    advance(SCROLL_DEBOUNCE_MS);
    expect(state.flights).toHaveLength(1); // episode 1 flight airborne
    expect(state.flights[0].input.episodeId).toBe(1);

    // Navigate to episode 2 mid-flight: dispose force-flush queues behind
    // the airborne A flight, then the generation is fenced.
    state.episodeId = 2;
    act(() => {
      view.rerender(React.createElement(ReaderPage));
    });
    expect(state.flights).toHaveLength(1); // queued, not a second flight

    // Episode B becomes readable and its own scroll debounce fires while
    // A is STILL airborne -> B's flush queues under B's generation.
    setScrollMetrics(9000);
    fireScroll();
    advance(SCROLL_DEBOUNCE_MS);
    expect(state.flights).toHaveLength(1);

    // A finally settles: stale flight, but B's queued flush is served
    // through the CURRENT context - B saves immediately, no re-scroll.
    act(() => {
      state.flights[0].handlers.onSuccess();
      state.flights[0].handlers.onSettled();
    });
    expect(state.flights).toHaveLength(2);
    expect(state.flights[1].input.episodeId).toBe(2);
    expect(state.flights[1].input.scrollPosition).toBe(9000);

    // and B's flight, once settled, marks success without side effects from A
    act(() => {
      state.flights[1].handlers.onSuccess();
      state.flights[1].handlers.onSettled();
    });
    expect(state.flights).toHaveLength(2);

    view.unmount();
  });

  it("loading -> readable -> scroll -> navigate/unmount: the dispose save still fires correctly (cleanup closure never saw canRead=true)", () => {
    // Phase 1: initial skeleton render - the [episodeId, userId] reset
    // effect is written NOW, while canRead is still false.
    state.episodePhase = "loading";
    const view = render(React.createElement(ReaderPage));
    expect(() => getScrollContainer()).toThrow(); // skeleton, no reader yet

    // Phase 2: the episode resolves - canRead flips true WITHOUT the
    // effect re-running (deps unchanged). Pre-repair, the stale closure's
    // canRead=false made the dispose-flush a no-op and the position was
    // lost on navigation.
    act(() => {
      state.episodePhase = "resolved";
    });
    view.rerender(React.createElement(ReaderPage));
    setScrollMetrics(2600);
    fireScroll();

    // Navigate away BEFORE the debounce fires -> dispose must save episode 1.
    state.episodeId = 2;
    state.episodePhase = "loading"; // episode B starts on its own skeleton
    act(() => {
      view.rerender(React.createElement(ReaderPage));
    });
    expect(state.saveMutate).toHaveBeenCalledTimes(1);
    expect(state.flights[0].input.episodeId).toBe(1);
    expect(state.flights[0].input.scrollPosition).toBe(2600);

    // Unmount while episode B never became readable: no pending, no save.
    act(() => {
      view.unmount();
    });
    expect(state.saveMutate).toHaveBeenCalledTimes(1);
  });

  it("navigation key with focus OUTSIDE the scroll container (body) ends the resume window", () => {
    state.progressData = {
      progressPercent: 30,
      scrollPosition: 3000,
      currentChapterNumber: null,
      currentChapterTitle: null,
      anchorKey: null,
      lastReadAt: new Date().toISOString(),
    };
    const view = render(React.createElement(ReaderPage));
    const writable = setWritableScroll();
    const resumeButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "อ่านต่อ"
    );
    expect(resumeButton).toBeTruthy();

    act(() => {
      resumeButton?.click();
    });
    advance(120); // first verify passes apply the restore (timed + the rAF chain, which jsdom also drives through the faked setTimeout)
    const baseline = writable.setCount();
    expect(baseline).toBeGreaterThanOrEqual(1);
    expect(writable.current()).toBe(3000);

    // ArrowDown while focus is on BODY (outside the container) - the
    // document-level listener must still classify this as user scroll intent.
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    advance(400);
    advance(1000);
    expect(writable.setCount()).toBe(baseline); // restore no longer re-asserted

    view.unmount();
  });

  it("keyboard events inside unrelated inputs/controls do NOT cancel the resume (Space on a button activates it, arrows in an input edit it)", () => {
    state.progressData = {
      progressPercent: 30,
      scrollPosition: 3000,
      currentChapterNumber: null,
      currentChapterTitle: null,
      anchorKey: null,
      lastReadAt: new Date().toISOString(),
    };
    const view = render(React.createElement(ReaderPage));
    const writable = setWritableScroll();
    const resumeButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "อ่านต่อ"
    );
    expect(resumeButton).toBeTruthy();
    act(() => {
      resumeButton?.click();
    });
    advance(120);
    const appliesAfterFirstPass = writable.setCount();
    expect(appliesAfterFirstPass).toBeGreaterThanOrEqual(1);

    // Space pressed while a BUTTON holds focus (activates the button - not
    // a scroll intent), and ArrowDown inside an INPUT (moves the caret -
    // not a scroll intent). Neither may end the verify window.
    const button = document.createElement("button");
    const input = document.createElement("input");
    document.body.append(button, input);
    try {
      act(() => {
        button.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
      advance(400);
      advance(1000);
      expect(writable.setCount()).toBeGreaterThan(appliesAfterFirstPass); // restore kept re-asserting
    } finally {
      button.remove();
      input.remove();
    }

    view.unmount();
  });

  it("R3 chain: A saves 10% -> reads to 20% -> navigate B -> A settles -> A's LATEST 20% saved first, then B's save follows", () => {
    state.setAutoSettle(false); // manual settle throughout
    const view = render(React.createElement(ReaderPage));

    // A: scroll to 10%, debounce fires, the save stays airborne
    setScrollMetrics(1920); // 1920 / 19200 = 10%
    fireScroll();
    advance(SCROLL_DEBOUNCE_MS);
    expect(state.flights).toHaveLength(1);
    expect(state.flights[0].input.episodeId).toBe(1);
    expect(state.flights[0].input.progressPercent).toBeCloseTo(10, 5);

    // A: read on to 20% - the next debounce is armed but has NOT fired yet
    setScrollMetrics(3840); // 20%
    fireScroll();

    // Navigate to episode B BEFORE that debounce fires: A's 20% snapshot
    // must be parked by dispose (not lost with the pending reset).
    state.episodeId = 2;
    state.episodePhase = "loading";
    act(() => {
      view.rerender(React.createElement(ReaderPage));
    });
    expect(state.flights).toHaveLength(1); // still only the airborne 10%

    // The 10% flight settles -> A's latest 20% goes out as a background
    // flight under episode 1's context.
    act(() => {
      state.flights[0].handlers.onSuccess();
      state.flights[0].handlers.onSettled();
    });
    expect(state.flights).toHaveLength(2);
    expect(state.flights[1].input.episodeId).toBe(1);
    expect(state.flights[1].input.progressPercent).toBeCloseTo(20, 5);
    expect(state.flights[1].input.scrollPosition).toBe(3840);

    // The handoff settles; B has not scrolled yet, so nothing further fires.
    act(() => {
      state.flights[1].handlers.onSuccess();
      state.flights[1].handlers.onSettled();
    });
    expect(state.flights).toHaveLength(2);

    // B becomes readable, its user scrolls, and B's own save goes out.
    state.episodePhase = "resolved";
    act(() => {
      view.rerender(React.createElement(ReaderPage));
    });
    setScrollMetrics(5760);
    fireScroll();
    advance(SCROLL_DEBOUNCE_MS);
    expect(state.flights).toHaveLength(3);
    expect(state.flights[2].input.episodeId).toBe(2);
    expect(state.flights[2].input.scrollPosition).toBe(5760);

    act(() => {
      state.flights[2].handlers.onSuccess();
      state.flights[2].handlers.onSettled();
    });
    view.unmount();
  });

  it("R4 (P1): navigating A -> B -> C during one airborne save preserves BOTH handoffs - A20 then B30 fire in order", () => {
    state.setAutoSettle(false);
    const view = render(React.createElement(ReaderPage));

    // A: 10% save airborne, then read on to 20% (debounce not fired)
    setScrollMetrics(1920);
    fireScroll();
    advance(SCROLL_DEBOUNCE_MS);
    expect(state.flights).toHaveLength(1);
    setScrollMetrics(3840);
    fireScroll();

    // A -> B: park A@20
    state.episodeId = 2;
    state.episodePhase = "loading";
    act(() => {
      view.rerender(React.createElement(ReaderPage));
    });

    // B: readable, scroll to 30% (debounce not fired), then B -> C: park B@30
    state.episodePhase = "resolved";
    act(() => {
      view.rerender(React.createElement(ReaderPage));
    });
    setScrollMetrics(5760);
    fireScroll();
    state.episodeId = 3;
    state.episodePhase = "loading";
    act(() => {
      view.rerender(React.createElement(ReaderPage));
    });

    // A@10 settles -> A@20 handoff fires; its settle -> B@30 fires
    act(() => {
      state.flights[0].handlers.onSuccess();
      state.flights[0].handlers.onSettled();
    });
    expect(state.flights).toHaveLength(2);
    expect(state.flights[1].input.episodeId).toBe(1);
    expect(state.flights[1].input.scrollPosition).toBe(3840);

    act(() => {
      state.flights[1].handlers.onSuccess();
      state.flights[1].handlers.onSettled();
    });
    expect(state.flights).toHaveLength(3);
    expect(state.flights[2].input.episodeId).toBe(2);
    expect(state.flights[2].input.scrollPosition).toBe(5760);

    view.unmount();
  });

  it("R4 (P2): the A20 handoff FAILING still sends B's queued 55% immediately - no re-scroll needed", () => {
    state.setAutoSettle(false);
    const view = render(React.createElement(ReaderPage));

    // A: 10% airborne, then 20% pending, then navigate to B
    setScrollMetrics(1920);
    fireScroll();
    advance(SCROLL_DEBOUNCE_MS);
    setScrollMetrics(3840);
    fireScroll();
    state.episodeId = 2;
    state.episodePhase = "loading";
    act(() => {
      view.rerender(React.createElement(ReaderPage));
    });

    // B: readable; scroll to 55%; its debounce fires while A@10 is airborne -> queued
    state.episodePhase = "resolved";
    act(() => {
      view.rerender(React.createElement(ReaderPage));
    });
    setScrollMetrics(10560); // 55% of 19200
    fireScroll();
    advance(SCROLL_DEBOUNCE_MS);
    expect(state.flights).toHaveLength(1); // queued behind A@10

    // A@10 settles -> A@20 handoff fires...
    act(() => {
      state.flights[0].handlers.onSuccess();
      state.flights[0].handlers.onSettled();
    });
    expect(state.flights).toHaveLength(2);
    expect(state.flights[1].input.episodeId).toBe(1);
    expect(state.flights[1].input.scrollPosition).toBe(3840);

    // ...and the handoff FAILS: B@55 must still go out IMMEDIATELY (its
    // retry is isolated and must not hold the current episode's queue)
    act(() => {
      state.flights[1].handlers.onError();
      state.flights[1].handlers.onSettled();
    });
    expect(state.flights).toHaveLength(3);
    expect(state.flights[2].input.episodeId).toBe(2);
    expect(state.flights[2].input.progressPercent).toBeCloseTo(55, 5);
    expect(state.flights[2].input.scrollPosition).toBe(10560);

    act(() => {
      state.flights[2].handlers.onSuccess();
      state.flights[2].handlers.onSettled();
    });
    view.unmount();
  });

  it("R5 (P1): the A20 handoff firing while the user is back at A@40 never regresses localStorage recovery to A20", () => {
    state.setAutoSettle(false);
    const view = render(React.createElement(ReaderPage));

    // A: 10% save airborne, then read on to 20%, then navigate to B
    setScrollMetrics(1920);
    fireScroll();
    advance(SCROLL_DEBOUNCE_MS);
    expect(state.flights).toHaveLength(1);
    setScrollMetrics(3840);
    fireScroll();
    state.episodeId = 2;
    state.episodePhase = "loading";
    act(() => {
      view.rerender(React.createElement(ReaderPage));
    });

    // the user RETURNS to episode A and reads on to 40% (the throttled
    // scroll handler writes the A@40 local recovery immediately)
    state.episodeId = 1;
    state.episodePhase = "resolved";
    act(() => {
      view.rerender(React.createElement(ReaderPage));
    });
    setScrollMetrics(7680); // 40% of 19200
    fireScroll();

    const readRecovery = () =>
      JSON.parse(window.localStorage.getItem("ipe.readerResume.v1.uu1.e1") ?? "{}");
    expect(readRecovery().scrollTop).toBe(7680);

    // A@10 settles -> the parked A@20 handoff fires as a background
    // flight - local recovery must STILL say 7680 (A@40)
    act(() => {
      state.flights[0].handlers.onSuccess();
      state.flights[0].handlers.onSettled();
    });
    expect(state.flights).toHaveLength(2);
    expect(state.flights[1].input.episodeId).toBe(1);
    expect(state.flights[1].input.scrollPosition).toBe(3840);
    expect(readRecovery().scrollTop).toBe(7680);

    // the handoff settles (no accepted mark for the current generation);
    // the A@40 debounce flush queued behind it then lands as a foreground
    // flight (which may rewrite the same A@40 recovery)
    act(() => {
      state.flights[1].handlers.onSuccess();
      state.flights[1].handlers.onSettled();
    });
    advance(SCROLL_DEBOUNCE_MS);
    expect(state.flights).toHaveLength(3);
    expect(state.flights[2].input.scrollPosition).toBe(7680);

    act(() => {
      state.flights[2].handlers.onSuccess();
      state.flights[2].handlers.onSettled();
    });
    view.unmount();
  });

  it("R6: A20 handoff failing AFTER a further navigation (generation bump) still retries once, in order with B30, without regressing recovery", () => {
    state.setAutoSettle(false);
    const view = render(React.createElement(ReaderPage));

    // A: 10% airborne -> read to 20% -> navigate to B (park A@20)
    setScrollMetrics(1920);
    fireScroll();
    advance(SCROLL_DEBOUNCE_MS);
    expect(state.flights).toHaveLength(1);
    setScrollMetrics(3840);
    fireScroll();
    state.episodeId = 2;
    state.episodePhase = "loading";
    act(() => {
      view.rerender(React.createElement(ReaderPage));
    });

    // A@10 settles -> A@20 handoff goes airborne (background)
    act(() => {
      state.flights[0].handlers.onSuccess();
      state.flights[0].handlers.onSettled();
    });
    expect(state.flights).toHaveLength(2);
    expect(state.flights[1].input.episodeId).toBe(1);
    expect(state.flights[1].input.scrollPosition).toBe(3840);

    // B: readable -> 30% -> navigate on to C (park B@30; generation bumped
    // AGAIN while the A@20 flight is still airborne)
    state.episodePhase = "resolved";
    act(() => {
      view.rerender(React.createElement(ReaderPage));
    });
    setScrollMetrics(5760);
    fireScroll();
    state.episodeId = 3;
    state.episodePhase = "loading";
    act(() => {
      view.rerender(React.createElement(ReaderPage));
    });

    // A@20 FAILS on the stale generation: its retry must still be
    // scheduled, and its settle must deliver B@30 in order
    act(() => {
      state.flights[1].handlers.onError();
      state.flights[1].handlers.onSettled();
    });
    expect(state.flights).toHaveLength(3);
    expect(state.flights[2].input.episodeId).toBe(2);
    expect(state.flights[2].input.scrollPosition).toBe(5760);
    act(() => {
      state.flights[2].handlers.onSuccess();
      state.flights[2].handlers.onSettled();
    });

    // the A@20 retry fires on its own delay (default 2s) under episode 1
    advance(2000);
    expect(state.flights).toHaveLength(4);
    expect(state.flights[3].input.episodeId).toBe(1);
    expect(state.flights[3].input.scrollPosition).toBe(3840);

    // capped at ONE retry: failing again schedules nothing further
    act(() => {
      state.flights[3].handlers.onError();
      state.flights[3].handlers.onSettled();
    });
    advance(60_000);
    expect(state.flights).toHaveLength(4);

    // local recovery for episode 1 was last written at dispose time (A@20)
    // - background flights and their retries never rewrite it
    const recoveryA = JSON.parse(
      window.localStorage.getItem("ipe.readerResume.v1.uu1.e1") ?? "{}"
    );
    expect(recoveryA.scrollTop).toBe(3840);

    view.unmount();
  });
});
