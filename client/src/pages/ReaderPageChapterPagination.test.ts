// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, render } from "@testing-library/react";

/**
 * Component-level regression suite for P1 Reader chapter pagination
 * (package episodes render ONE chapter per page).
 *
 * Pins down:
 *  1. Page isolation - only the current chapter's lines are in the DOM;
 *    other chapters' prose is never rendered (not just scrolled away).
 *  2. Chapter navigation - previous/next buttons switch pages, reset the
 *    scroll viewport, and keep the ?chapter= URL in sync.
 *  3. TOC - entries switch pages; the current chapter is aria-current.
 *  4. Resume - saved progress NEVER auto-jumps on load; clicking "อ่านต่อ"
 *    opens the saved chapter and restores the within-chapter offset.
 *  5. Overall percent - paginated saves report whole-package progress
 *    ((page + within-page)/pages), so the "read X%" shown on My Novels /
 *    Profile / Novel Detail keeps its meaning.
 *  6. Entitlement/legacy shapes - a locked package keeps the purchase
 *    prompt with NO pagination UI, and a single-chapter package keeps the
 *    legacy single-page rendering.
 */

const PACKAGE_CONTENT = [
  "บทที่ 1 จุดเริ่มต้น",
  "บทหนึ่ง ก",
  "บทหนึ่ง ข",
  "",
  "บทที่ 2 ทางแยก",
  "บทสอง ก",
  "",
  "บทที่ 3 ปลายทาง",
  "บทสาม ก",
].join("\n");

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
  // When true (default) each mutate settles synchronously (success). When
  // false the flight stays AIRBORNE until the test settles it manually -
  // used to reproduce slow API saves / in-flight queues (R2 tests).
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
    saleMode: "package" as "package" | "chapter",
    canRead: true,
    isLocked: false,
    content: "",
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
    episode: { id: state.episodeId, episodeNumber: 1, title: "แพ็กทดสอบ", price: "0", isFree: true, fileUrl: null },
    novel: { id: 11, title: "นิยายแพ็ก" },
    previousEpisode: null,
    nextEpisode: null,
    walletBalance: "0",
    canRead: state.canRead,
    isLocked: state.isLocked,
    content: state.content,
    preview: "",
    saleMode: state.saleMode,
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
          useQuery: () => ({ data: episodePayload(), isLoading: false, error: null }),
        },
        getProgress: { useQuery: () => ({ data: state.progressData, isLoading: false, error: null }) },
        saveProgress: {
          // Fresh object per render ON PURPOSE (same churn as the real tRPC
          // mutation result - see ReaderPageProgress.test.ts).
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
  useReadingLease: () => ({ leaseState: { phase: "idle" }, transferLease: vi.fn() }),
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

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

/**
 * jsdom has no layout and no animation frames in this harness: expose
 * explicit scroll metrics AND make scrollTop writable (the switch handler
 * and the resume restore both assign it), and run rAF callbacks
 * synchronously so page-switch scroll resets land inside act().
 */
function setWritableScroll(scrollHeight = 20000, clientHeight = 800) {
  const el = getScrollContainer();
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
  let current = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => current,
    set: (v: number) => {
      current = v;
    },
  });
  return {
    get: () => current,
    set: (v: number) => {
      el.scrollTop = v;
    },
  };
}

function getScrollContainer(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="reader-scroll-container"]');
  if (!el) throw new Error("scroll container not mounted (episode not readable yet?)");
  return el;
}

function paragraphTexts(): string[] {
  return Array.from(getScrollContainer().querySelectorAll("p")).map((p) => p.textContent || "");
}

/** The local recovery record (readerResumePosition storage key), or null.
 *  Key format: "<prefix>.u<userId>.e<episodeId>" - fixture user id is "u1". */
function recoveryRecord(): { chapterNumber: string | null; scrollTop: number; percent: number } | null {
  const raw = window.localStorage.getItem("ipe.readerResume.v1.uu1.e1");
  return raw ? JSON.parse(raw) : null;
}

/** Seed a local recovery record with an EXACT savedAt (merge-timeline control). */
function seedRecovery(record: {
  percent: number;
  scrollTop: number;
  chapterNumber: string | null;
  chapterTitle: string | null;
  anchorId: string | null;
  savedAt: number;
}) {
  window.localStorage.setItem("ipe.readerResume.v1.uu1.e1", JSON.stringify(record));
}

const CH2_SAVED_AT_300 = {
  progressPercent: 33,
  scrollPosition: 300,
  currentChapterNumber: "2",
  currentChapterTitle: "บทที่ 2 ทางแยก",
  anchorKey: "toc-line-4",
  lastReadAt: "2026-10-29T08:00:00.000Z",
};

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

function clickButton(namePattern: RegExp) {
  act(() => {
    const el = Array.from(document.querySelectorAll("button")).find(
      (b) => namePattern.test(b.textContent || "")
    );
    if (!el) throw new Error(`button not found: ${namePattern}`);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    })
  );
  state.resetFlights();
  state.setAutoSettle(true);
  state.saleMode = "package";
  state.canRead = true;
  state.isLocked = false;
  state.content = PACKAGE_CONTENT;
  state.progressData = null;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/read/1");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
  state.episodeId = 1; // the A->B SPA test mutates it - reset for the next test
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});

describe("ReaderPage chapter pagination (package episodes, component-level)", () => {
  it("renders ONLY the current chapter's page; the next button moves on and the URL follows", () => {
    render(React.createElement(ReaderPage));

    const texts = paragraphTexts();
    expect(texts).toContain("บทที่ 1 จุดเริ่มต้น");
    expect(texts).toContain("บทหนึ่ง ก");
    // Page isolation: chapters 2 and 3 are NOT in the DOM at all.
    expect(texts).not.toContain("บทสอง ก");
    expect(texts).not.toContain("บทที่ 2 ทางแยก");
    expect(texts).not.toContain("บทสาม ก");

    // First page: no previous button, next button present, indicator 1/3.
    const buttonNames = () =>
      Array.from(document.querySelectorAll("button")).map((b) => b.textContent || "");
    expect(buttonNames().some((n) => n.includes("reader.previousChapter"))).toBe(false);
    expect(buttonNames().some((n) => n.includes("reader.nextChapter"))).toBe(true);
    expect(document.body.textContent).toContain("1/3");
    clickButton(/reader\.nextChapter/);

    const after = paragraphTexts();
    expect(after).toContain("บทที่ 2 ทางแยก");
    expect(after).toContain("บทสอง ก");
    expect(after).not.toContain("บทหนึ่ง ก");
    expect(buttonNames().some((n) => n.includes("reader.previousChapter"))).toBe(true);
    // URL keeps the visible chapter (deep-link/refresh parity).
    expect(window.location.search).toBe("?chapter=2");

    // Both pages carry exactly ONE chapter heading anchor.
    expect(getScrollContainer().querySelectorAll('[data-toc-anchor="true"]')).toHaveLength(1);
  });

  it("switching pages resets the scroll viewport to the new page's top", () => {
    render(React.createElement(ReaderPage));
    const scroll = setWritableScroll();

    // Read a little on chapter 1, then move on.
    scroll.set(1920);
    fireScroll();
    clickButton(/reader\.nextChapter/);
    expect(scroll.get()).toBe(0);

    // And back again - also from the indicator side (2/3 -> 1/3).
    expect(paragraphTexts()).toContain("บทสอง ก");
    clickButton(/reader\.previousChapter/);
    expect(scroll.get()).toBe(0);
    expect(paragraphTexts()).toContain("บทหนึ่ง ก");
    expect(window.location.search).toBe("?chapter=1");
  });

  it("scrolling chapter 1 then pressing Next saves chapter 1's position IMMEDIATELY (R1: percent bound to the snapshot's chapter)", () => {
    render(React.createElement(ReaderPage));
    const scroll = setWritableScroll();

    scroll.set(1920);
    fireScroll();
    expect(state.flights.length).toBe(0); // debounce armed, not fired yet

    // Next pressed BEFORE the 1.5s debounce completes: the switch force-
    // flushes the outgoing position right now, as chapter 1 data.
    clickButton(/reader\.nextChapter/);
    expect(state.flights.length).toBe(1);
    expect(state.flights[0].input.currentChapterNumber).toBe("1");
    expect(state.flights[0].input.progressPercent).toBe(3); // (0 + 10%)/3 chapters
    expect(state.flights[0].input.scrollPosition).toBe(1920);

    advance(1500); // the cleared debounce must NOT re-send the stale pending
    expect(state.flights.length).toBe(1);

    // Reading continues on chapter 2: a NEW flight carries chapter 2's identity.
    scroll.set(9600);
    fireScroll();
    advance(1500);
    expect(state.flights.length).toBe(2);
    expect(state.flights[1].input.currentChapterNumber).toBe("2");
    expect(state.flights[1].input.progressPercent).toBe(50); // (1 + 50%)/3
  });

  it("Next through several chapters WITHOUT scrolling still records the last chapter on exit (R1)", () => {
    const view = render(React.createElement(ReaderPage));

    clickButton(/reader\.nextChapter/); // -> ch2, records ch1 top
    clickButton(/reader\.nextChapter/); // -> ch3, records ch2 top
    expect(paragraphTexts()).toContain("บทสาม ก");

    act(() => {
      view.unmount();
    });
    advance(100);
    // Switch 1 recorded chapter 1, switch 2 recorded chapter 2, and the
    // unmount dispose recorded the chapter the reader is ON (chapter 3).
    expect(state.flights.map((f) => f.input.currentChapterNumber)).toEqual(["1", "2", "3"]);
    expect(state.flights[2].input.progressPercent).toBe(67); // (2 + 0%)/3
  });

  it("an SPA episode change A -> B re-applies B's own ?chapter= deep link (R1)", () => {
    const view = render(React.createElement(ReaderPage));
    expect(paragraphTexts()).toContain("บทหนึ่ง ก");

    const NOVEL_B = [
      "บทที่ 1 บีหนึ่ง",
      "บีหนึ่ง ก",
      "",
      "บทที่ 2 บีสอง",
      "บีสอง ก",
      "",
      "บทที่ 3 บีสาม",
      "บีสาม ก",
    ].join("\n");
    act(() => {
      state.episodeId = 2;
      state.content = NOVEL_B;
      window.history.replaceState(null, "", "/read/2?chapter=2");
    });
    view.rerender(React.createElement(ReaderPage));

    // B opened at ITS chapter 2 (not chapter 1, not A's chapter 2).
    expect(paragraphTexts()).toContain("บีสอง ก");
    expect(paragraphTexts()).not.toContain("บีหนึ่ง ก");
    expect(paragraphTexts()).not.toContain("บทสอง ก");
    expect(window.location.search).toBe("?chapter=2");
  });

  it("resume restores the within-chapter offset when the saved chapter is already open", () => {
    state.progressData = {
      progressPercent: 4,
      scrollPosition: 300,
      currentChapterNumber: "1",
      currentChapterTitle: "บทที่ 1 จุดเริ่มต้น",
      anchorKey: "toc-line-0",
      lastReadAt: "2026-10-29T08:00:00.000Z",
    };
    render(React.createElement(ReaderPage));
    const scroll = setWritableScroll();

    expect(paragraphTexts()).toContain("บทหนึ่ง ก"); // already the saved chapter
    clickButton(/อ่านต่อ/);
    expect(scroll.get()).toBe(300);
    expect(paragraphTexts()).not.toContain("บทสอง ก"); // no chapter switch
    expect(window.location.search).toBe("?chapter=1");
  });

  it("paginated saves report WHOLE-package progress percent, bound to the right chapter", () => {
    render(React.createElement(ReaderPage));
    const scroll = setWritableScroll();
    const byChapter = (n: string) =>
      state.flights.filter((f) => f.input.currentChapterNumber === n);

    // Chapter 1, 10% into the page: overall = (0 + 0.10)/3 = 3 (int column).
    scroll.set(1920);
    fireScroll();
    advance(1500);
    expect(byChapter("1").length).toBeGreaterThanOrEqual(1);
    expect(byChapter("1")[0].input.progressPercent).toBe(3);
    expect(byChapter("1")[0].input.scrollPosition).toBe(1920);

    // Chapter 2, 50% into the page: overall = (1 + 0.50)/3 = 50.
    clickButton(/reader\.nextChapter/);
    scroll.set(9600);
    fireScroll();
    advance(1500);
    const ch2Flights = byChapter("2");
    expect(ch2Flights.length).toBeGreaterThanOrEqual(1);
    const scrolled = ch2Flights.find((f) => f.input.scrollPosition === 9600);
    expect(scrolled?.input.progressPercent).toBe(50);
  });

  it("a single-heading package saves the RAW within-page percent (no package conversion)", () => {
    state.content = "บทที่ 1 ตอนเดียว\nเนื้อหาทั้งหมด ก\nเนื้อหาทั้งหมด ข";
    render(React.createElement(ReaderPage));
    const scroll = setWritableScroll();

    scroll.set(1920);
    fireScroll();
    advance(1500);
    expect(state.flights.length).toBe(1);
    // Legacy (non-paginated) shape: raw within-page percent passes through
    // untouched - 10% of the page, no package-level conversion.
    expect(state.flights[0].input.progressPercent).toBe(10);
    expect(state.flights[0].input.currentChapterNumber).toBe("1");
  });

  it("a ?chapter= deep link opens that chapter immediately", () => {
    window.history.replaceState(null, "", "/read/1?chapter=3");
    render(React.createElement(ReaderPage));

    const texts = paragraphTexts();
    expect(texts).toContain("บทที่ 3 ปลายทาง");
    expect(texts).toContain("บทสาม ก");
    expect(texts).not.toContain("บทหนึ่ง ก");
  });

  it("TOC entries switch pages and mark the current chapter aria-current", () => {
    render(React.createElement(ReaderPage));

    clickButton(/สารบัญ/);
    // The drawer lists all three chapters (TOC is preserved for picking).
    const chapterItems = () =>
      Array.from(document.querySelectorAll("button")).filter((b) =>
        (b.textContent || "").startsWith("บทที่")
      );
    expect(chapterItems().length).toBe(3);

    clickButton(/บทที่ 3 ปลายทาง/);
    expect(paragraphTexts()).toContain("บทสาม ก");
    expect(paragraphTexts()).not.toContain("บทหนึ่ง ก");

    // Re-open: chapter 3 is the current one.
    clickButton(/สารบัญ/);
    const current = document.querySelector('[aria-current="true"]');
    expect(current?.textContent).toBe("บทที่ 3 ปลายทาง");
  });

  it("saved progress never auto-jumps; อ่านต่อ opens the saved chapter and restores the offset", () => {
    state.progressData = {
      progressPercent: 45,
      scrollPosition: 300,
      currentChapterNumber: "2",
      currentChapterTitle: "บทที่ 2 ทางแยก",
      anchorKey: "toc-line-4",
      lastReadAt: "2026-10-29T08:00:00.000Z",
    };
    render(React.createElement(ReaderPage));
    const scroll = setWritableScroll();

    // Banner up, but the reader still sees chapter 1 from the top.
    expect(paragraphTexts()).toContain("บทหนึ่ง ก");
    expect(document.body.textContent).toContain("อ่านล่าสุดถึง");
    expect(scroll.get()).toBe(0);

    clickButton(/อ่านต่อ/);
    expect(paragraphTexts()).toContain("บทที่ 2 ทางแยก");
    expect(paragraphTexts()).toContain("บทสอง ก");
    expect(scroll.get()).toBe(300);
    expect(window.location.search).toBe("?chapter=2");
  });

  it("R3: อ่านต่อ to saved ch2@300 from ch1 re-asserts EXACTLY ch2@300 on server + local", () => {
    state.progressData = { ...CH2_SAVED_AT_300 };
    render(React.createElement(ReaderPage));
    const scroll = setWritableScroll();

    expect(paragraphTexts()).toContain("บทหนึ่ง ก"); // opens at ch1, banner waits
    clickButton(/อ่านต่อ/);
    expect(paragraphTexts()).toContain("บทสอง ก");
    expect(scroll.get()).toBe(300);

    // Exactly ONE save fires - the DESTINATION itself (an idempotent
    // re-assert of ch2@300, never a ch1-top or ch2-top placeholder), and
    // local recovery holds the same destination with a fresh savedAt.
    advance(20000); // scroll debounce + periodic safety net + verify window
    expect(state.flights.length).toBe(1);
    expect(state.flights[0].input.currentChapterNumber).toBe("2");
    expect(state.flights[0].input.scrollPosition).toBe(300);
    expect(state.flights[0].input.progressPercent).toBe(33);
    expect(recoveryRecord()?.chapterNumber).toBe("2");
    expect(recoveryRecord()?.scrollTop).toBe(300);
    expect(window.location.search).toBe("?chapter=2");
  });

  it("R3: leaving immediately after อ่านต่อ still ends server+local at the destination", () => {
    state.progressData = { ...CH2_SAVED_AT_300 };
    const view = render(React.createElement(ReaderPage));
    setWritableScroll();
    clickButton(/อ่านต่อ/);

    act(() => {
      view.unmount();
    });
    advance(100);
    // The dispose flush re-sends the pending (= destination) - the final
    // write is ch2@300 on both surfaces, never an empty/top placeholder.
    expect(state.flights.length).toBeGreaterThanOrEqual(1);
    const last = state.flights[state.flights.length - 1];
    expect(last.input.currentChapterNumber).toBe("2");
    expect(last.input.scrollPosition).toBe(300);
    expect(recoveryRecord()?.chapterNumber).toBe("2");
    expect(recoveryRecord()?.scrollTop).toBe(300);
  });

  it("R3: Server ch2@300 + stale Local ch1@1920 -> Resume -> Refresh still lands ch2@300", () => {
    // Stale local record written 60s BEFORE the (newer) server record.
    seedRecovery({
      percent: 10,
      scrollTop: 1920,
      chapterNumber: "1",
      chapterTitle: "บทที่ 1 จุดเริ่มต้น",
      anchorId: "toc-line-0",
      savedAt: Date.now() - 60000,
    });
    state.progressData = { ...CH2_SAVED_AT_300, lastReadAt: new Date(Date.now()).toISOString() };

    const view = render(React.createElement(ReaderPage));
    // The merge picked the newer SERVER record for the banner despite the
    // local record existing.
    expect(document.body.textContent).toContain("บทที่ 2 ทางแยก");
    expect(paragraphTexts()).toContain("บทหนึ่ง ก");
    clickButton(/อ่านต่อ/);
    expect(paragraphTexts()).toContain("บทสอง ก");
    // The destination re-stamped local recovery with a fresh savedAt - the
    // stale ch1 record (old chapter data) is gone and can never win again.
    expect(recoveryRecord()?.chapterNumber).toBe("2");
    expect(recoveryRecord()?.scrollTop).toBe(300);

    // REFRESH: fresh mount - the merge must still resolve to ch2@300.
    act(() => {
      view.unmount();
    });
    render(React.createElement(ReaderPage));
    const scroll = setWritableScroll();
    expect(document.body.textContent).toContain("บทที่ 2 ทางแยก");
    clickButton(/อ่านต่อ/);
    expect(paragraphTexts()).toContain("บทสอง ก");
    expect(scroll.get()).toBe(300);
  });

  it("R3: in-flight ch1 save + Resume ch2@300 - the OLD request never ends as the final server state", () => {
    state.setAutoSettle(false); // flight 1 stays airborne until settled
    state.progressData = { ...CH2_SAVED_AT_300 };
    render(React.createElement(ReaderPage));
    const scroll = setWritableScroll();

    scroll.set(1920);
    fireScroll();
    advance(1500); // flight 1 (ch1@1920) AIRBORNE
    expect(state.flights.length).toBe(1);

    clickButton(/อ่านต่อ/); // resume while flight 1 is in flight
    expect(state.flights.length).toBe(1); // the resume flush is QUEUED behind it
    expect(recoveryRecord()?.chapterNumber).toBe("2"); // destination already stamped

    act(() => {
      state.flights[0].handlers.onSuccess(); // old request LANDS ch1@1920...
      state.flights[0].handlers.onSettled();
    });
    expect(state.flights.length).toBe(2); // ...and the queued re-flush fires
    // FINAL server state = the destination, never the old position:
    expect(state.flights[1].input.currentChapterNumber).toBe("2");
    expect(state.flights[1].input.scrollPosition).toBe(300);
    expect(state.flights[1].input.progressPercent).toBe(33);
    void scroll;
  });

  it("R3: resume within the SAME chapter while a scroll save is pending lands the destination", () => {
    // Deep link opens ch2 directly; the server holds a newer-device ch2@300
    // record (newer than anything local by more than the 30s skew window).
    window.history.replaceState(null, "", "/read/1?chapter=2");
    seedRecovery({
      percent: 50,
      scrollTop: 5000,
      chapterNumber: "2",
      chapterTitle: "บทที่ 2 ทางแยก",
      anchorId: "toc-line-4",
      savedAt: Date.now() - 60000,
    });
    state.progressData = { ...CH2_SAVED_AT_300, lastReadAt: new Date(Date.now()).toISOString() };

    render(React.createElement(ReaderPage));
    const scroll = setWritableScroll();
    expect(paragraphTexts()).toContain("บทสอง ก"); // opened ch2 via deep link

    scroll.set(5000);
    fireScroll(); // pending scroll save ch2@5000, debounce armed
    expect(recoveryRecord()?.scrollTop).toBe(5000);

    clickButton(/อ่านต่อ/); // same chapter: no page switch, but the destination...
    expect(recoveryRecord()?.chapterNumber).toBe("2"); // ...replaces the pending
    expect(recoveryRecord()?.scrollTop).toBe(300); // scroll save everywhere
    expect(state.flights.length).toBe(1);
    expect(state.flights[0].input.currentChapterNumber).toBe("2");
    expect(state.flights[0].input.scrollPosition).toBe(300);

    advance(2000); // the CLEARED debounce fires nothing; restore complete
    expect(state.flights.length).toBe(1); // no stale 5000 save ever lands
    expect(scroll.get()).toBe(300);
  });

  it("R3: closing during the restore and after it both end at the destination", () => {
    state.progressData = { ...CH2_SAVED_AT_300 };

    // (a) close WHILE the restore is still settling
    const first = render(React.createElement(ReaderPage));
    setWritableScroll();
    clickButton(/อ่านต่อ/);
    act(() => {
      first.unmount();
    });
    advance(2000);
    expect(state.flights.length).toBeGreaterThanOrEqual(1);
    for (const f of state.flights) {
      expect(f.input.currentChapterNumber).toBe("2");
      expect(f.input.scrollPosition).toBe(300);
    }

    // (b) close AFTER the restore completed
    const second = render(React.createElement(ReaderPage));
    const scroll = setWritableScroll();
    clickButton(/อ่านต่อ/);
    advance(2000); // restore + verify window complete
    expect(scroll.get()).toBe(300);
    act(() => {
      second.unmount();
    });
    advance(2000);
    const last = state.flights[state.flights.length - 1];
    expect(last.input.currentChapterNumber).toBe("2");
    expect(last.input.scrollPosition).toBe(300);
    expect(recoveryRecord()?.chapterNumber).toBe("2");
    expect(recoveryRecord()?.scrollTop).toBe(300);
  });

  it("R3: the resume save fails - recovery holds the destination and the retry re-sends it", () => {
    state.setAutoSettle(false);
    state.progressData = { ...CH2_SAVED_AT_300 };
    render(React.createElement(ReaderPage));
    setWritableScroll();

    clickButton(/อ่านต่อ/);
    expect(state.flights.length).toBe(1); // destination save airborne
    expect(recoveryRecord()?.chapterNumber).toBe("2"); // stamped synchronously
    expect(recoveryRecord()?.scrollTop).toBe(300);

    act(() => {
      state.flights[0].handlers.onError();
      state.flights[0].handlers.onSettled();
    });
    // The save FAILED - local recovery still holds the exact destination.
    expect(recoveryRecord()?.chapterNumber).toBe("2");
    expect(recoveryRecord()?.scrollTop).toBe(300);

    advance(2000); // backoff retry
    expect(state.flights.length).toBe(2);
    expect(state.flights[1].input.currentChapterNumber).toBe("2");
    expect(state.flights[1].input.scrollPosition).toBe(300);
  });

  it("R2: failed API saves never corrupt local recovery; the backoff retry re-sends the same position", () => {
    state.setAutoSettle(false);
    render(React.createElement(ReaderPage));
    const scroll = setWritableScroll();

    clickButton(/reader\.nextChapter/); // -> ch2 (flight 1: ch1-top, airborne)
    scroll.set(9600);
    fireScroll(); // recovery written SYNCHRONOUSLY: ch2@9600

    advance(1500); // debounce queues the follow-up behind airborne flight 1
    expect(state.flights.length).toBe(1);
    expect(recoveryRecord()?.chapterNumber).toBe("2");
    expect(recoveryRecord()?.scrollTop).toBe(9600);

    act(() => {
      state.flights[0].handlers.onError();
      state.flights[0].handlers.onSettled();
    });
    // A FAILED flight defers its queued follow-up to the backoff retry timer
    // (controller design) - nothing new fires until the retry is due.
    expect(state.flights.length).toBe(1);
    expect(recoveryRecord()?.chapterNumber).toBe("2");
    expect(recoveryRecord()?.scrollTop).toBe(9600);

    advance(2000); // backoff retry #1 (2s) re-sends the same correct position
    expect(state.flights.length).toBe(2);
    expect(state.flights[1].input.currentChapterNumber).toBe("2");
    expect(state.flights[1].input.scrollPosition).toBe(9600);

    act(() => {
      state.flights[1].handlers.onError();
      state.flights[1].handlers.onSettled();
    });
    // The retry FAILED too - local recovery still holds the exact position.
    expect(recoveryRecord()?.chapterNumber).toBe("2");
    expect(recoveryRecord()?.scrollTop).toBe(9600);

    advance(6000); // backoff retry #2 (6s), again with the SAME data
    expect(state.flights.length).toBe(3);
    expect(state.flights[2].input.currentChapterNumber).toBe("2");
    expect(state.flights[2].input.progressPercent).toBe(50);
    expect(state.flights[2].input.scrollPosition).toBe(9600);
  });

  it("a locked package keeps the purchase prompt with NO pagination UI", () => {
    state.canRead = false;
    state.isLocked = true;
    state.content = "";
    render(React.createElement(ReaderPage));

    expect(document.body.textContent).toContain("แพ็กนี้ยังไม่ได้ปลดล็อก");
    const buttonNames = () =>
      Array.from(document.querySelectorAll("button")).map((b) => b.textContent || "");
    expect(buttonNames().some((n) => n.includes("reader.nextChapter"))).toBe(false);
    expect(buttonNames().some((n) => n.includes("reader.previousChapter"))).toBe(false);
    expect(buttonNames().some((n) => n.includes("สารบัญ"))).toBe(false);
  });

  it("a single-chapter package keeps the legacy single-page rendering", () => {
    state.content = "บทที่ 1 ตอนเดียว\nเนื้อหาทั้งหมด ก\nเนื้อหาทั้งหมด ข";
    render(React.createElement(ReaderPage));

    // Legacy path: the whole content renders at once, no chapter nav.
    const texts = paragraphTexts();
    expect(texts).toContain("เนื้อหาทั้งหมด ก");
    expect(texts).toContain("เนื้อหาทั้งหมด ข");
    const buttonNames = () =>
      Array.from(document.querySelectorAll("button")).map((b) => b.textContent || "");
    expect(buttonNames().some((n) => n.includes("reader.nextChapter"))).toBe(false);
    expect(buttonNames().some((n) => n.includes("สารบัญ"))).toBe(true);
  });
});
