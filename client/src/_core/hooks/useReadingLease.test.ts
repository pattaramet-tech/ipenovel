// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useReadingLease } from "./useReadingLease";

/**
 * D-ASYNC-01 / D-TEST-01 regression suite (R4R7).
 *
 * Reviewer requirements this file is written against:
 *  - STABLE mock utilities: useUtils() must return the SAME object across
 *    renders, so a state rerender can never churn the acquire/heartbeat
 *    effect dependencies. The previous mock rebuilt the object per render,
 *    which made these tests unable to speak to context ownership at all.
 *  - Deferred settlements are awaited inside `act`, never inferred from a
 *    waitFor-idle (which can pass before the stale promise settles).
 *  - Explicit stale-ownership assertions:
 *      1. B pending → settle stale A (resolve AND reject) → a visibility
 *         event fires → acquire count must NOT increase.
 *      2. B held BEFORE stale A settles → still keeps version B, and the
 *         heartbeat still presents version B.
 *      3. The "renew failure chains into another acquire" case must ACTUALLY
 *        reject the renew and assert the chained acquire started (IR-01).
 */

const mocks = vi.hoisted(() => {
  function makeDeferred<T>() {
    let resolve: (value: T) => void = () => {};
    let reject: (reason?: unknown) => void = () => {};
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const acquireLog: Array<{
    episodeId: number;
    deferred: ReturnType<typeof makeDeferred<{ leaseVersion: number }>>;
  }> = [];
  const renewLog: Array<{ deferred: ReturnType<typeof makeDeferred<{ leaseVersion: number }>> }> = [];
  const transferMutate = vi.fn(async () => ({ leaseVersion: 2 }));

  const acquireMutate = vi.fn(async ({ episodeId }: { episodeId: number }) => {
    const deferred = makeDeferred<{ leaseVersion: number }>();
    acquireLog.push({ episodeId, deferred });
    return deferred.promise;
  });

  const renewMutate = vi.fn(async (_input: { episodeId: number; leaseVersion: number }) => {
    const deferred = makeDeferred<{ leaseVersion: number }>();
    renewLog.push({ deferred });
    return deferred.promise;
  });

  return { makeDeferred, acquireLog, renewLog, acquireMutate, renewMutate, transferMutate };
});

// STABLE utils instance: created ONCE for the whole module. The previous
// mock returned a fresh object per render, which changed `acquireNow`'s
// identity (its useCallback depends on `utils`) and re-ran the effects on
// every state rerender — invalidating any ownership claim these tests make.
vi.mock("@/lib/trpc", () => {
  const utilsInstance = {
    client: {
      reader: {
        lease: {
          acquire: { mutate: mocks.acquireMutate },
          renew: { mutate: mocks.renewMutate },
          transfer: { mutate: mocks.transferMutate },
        },
      },
    },
  };
  return {
    trpc: {
      useUtils: () => utilsInstance,
    },
  };
});

function resetMocks() {
  mocks.acquireLog.length = 0;
  mocks.renewLog.length = 0;
  mocks.acquireMutate.mockClear();
  mocks.renewMutate.mockClear();
}

/** Fires the Page Visibility event the hook listens to (jsdom default = visible). */
async function fireVisible() {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

describe("useReadingLease D-ASYNC-01 / D-TEST-01", () => {
  it("A pending → B starts its own acquire; stale A resolve paints nothing and a visibility event starts NO duplicate acquire", async () => {
    resetMocks();
    const { rerender, result } = renderHook(
      (props: { episodeId: number; enabled: boolean }) => useReadingLease(props),
      { initialProps: { episodeId: 1, enabled: true } }
    );

    await waitFor(() => expect(mocks.acquireMutate).toHaveBeenCalledTimes(1));
    expect(mocks.acquireLog[0].episodeId).toBe(1);

    // Context change while A is still in flight: B must start immediately.
    rerender({ episodeId: 2, enabled: true });
    await waitFor(() => expect(mocks.acquireMutate).toHaveBeenCalledTimes(2));
    expect(mocks.acquireLog[1].episodeId).toBe(2);
    expect(result.current.leaseState.phase).toBe("idle");

    // Settle the STALE A request first (awaited in act, not inferred).
    await act(async () => {
      mocks.acquireLog[0].deferred.resolve({ leaseVersion: 100 });
    });
    // Stale A's success must NOT paint (generation guard).
    expect(result.current.leaseState.phase).toBe("idle");
    // And it must not have re-triggered anything.
    expect(mocks.acquireMutate).toHaveBeenCalledTimes(2);

    // A visibility event while B's acquire is still pending must NOT start
    // a duplicate acquire for the current context (generation-owned
    // in-flight guard) — this is the D-ASYNC-01 starvation inverse.
    await fireVisible();
    expect(mocks.acquireMutate).toHaveBeenCalledTimes(2);

    // Now settle B: the current context becomes held with ITS version.
    await act(async () => {
      mocks.acquireLog[1].deferred.resolve({ leaseVersion: 8 });
    });
    expect(result.current.leaseState).toEqual({ phase: "held", leaseVersion: 8 });
  });

  it("A pending → B starts; stale A REJECTION paints nothing and starts no duplicate acquire; B still becomes held", async () => {
    resetMocks();
    const { rerender, result } = renderHook(
      (props: { episodeId: number; enabled: boolean }) => useReadingLease(props),
      { initialProps: { episodeId: 1, enabled: true } }
    );

    await waitFor(() => expect(mocks.acquireMutate).toHaveBeenCalledTimes(1));
    rerender({ episodeId: 2, enabled: true });
    await waitFor(() => expect(mocks.acquireMutate).toHaveBeenCalledTimes(2));

    await act(async () => {
      mocks.acquireLog[0].deferred.reject(new Error("stale A failed"));
    });
    // The stale rejection must not flip the CURRENT context to held-by-other.
    expect(result.current.leaseState.phase).toBe("idle");
    expect(mocks.acquireMutate).toHaveBeenCalledTimes(2);

    await fireVisible();
    expect(mocks.acquireMutate).toHaveBeenCalledTimes(2);

    await act(async () => {
      mocks.acquireLog[1].deferred.resolve({ leaseVersion: 9 });
    });
    expect(result.current.leaseState).toEqual({ phase: "held", leaseVersion: 9 });
  });

  it("B held BEFORE stale A settles → stale A success/rejection never overwrites version B, heartbeat keeps presenting B", async () => {
    resetMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { rerender, result } = renderHook(
        (props: { episodeId: number; enabled: boolean }) => useReadingLease(props),
        { initialProps: { episodeId: 1, enabled: true } }
      );

      await waitFor(() => expect(mocks.acquireMutate).toHaveBeenCalledTimes(1));
      rerender({ episodeId: 2, enabled: true });
      await waitFor(() => expect(mocks.acquireMutate).toHaveBeenCalledTimes(2));

      // The CURRENT context settles FIRST — B is held before A resolves.
      await act(async () => {
        mocks.acquireLog[1].deferred.resolve({ leaseVersion: 8 });
      });
      expect(result.current.leaseState).toEqual({ phase: "held", leaseVersion: 8 });

      // NOW the stale A request succeeds — it must not paint over B.
      await act(async () => {
        mocks.acquireLog[0].deferred.resolve({ leaseVersion: 100 });
      });
      expect(result.current.leaseState).toEqual({ phase: "held", leaseVersion: 8 });

      // Heartbeat keeps presenting version B (8) — the stale success above
      // never corrupted the heartbeat input.
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(mocks.renewMutate).toHaveBeenCalledTimes(1);
      expect(mocks.renewMutate).toHaveBeenCalledWith({ episodeId: 2, leaseVersion: 8 });
      await act(async () => {
        mocks.renewLog[0].deferred.resolve({ leaseVersion: 9 });
      });
      expect(result.current.leaseState).toEqual({ phase: "held", leaseVersion: 9 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("B held BEFORE stale A settles → stale A REJECTION never flips B to held-by-other, heartbeat keeps version B", async () => {
    resetMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { rerender, result } = renderHook(
        (props: { episodeId: number; enabled: boolean }) => useReadingLease(props),
        { initialProps: { episodeId: 1, enabled: true } }
      );

      await waitFor(() => expect(mocks.acquireMutate).toHaveBeenCalledTimes(1));
      rerender({ episodeId: 2, enabled: true });
      await waitFor(() => expect(mocks.acquireMutate).toHaveBeenCalledTimes(2));

      // B settles FIRST.
      await act(async () => {
        mocks.acquireLog[1].deferred.resolve({ leaseVersion: 8 });
      });
      expect(result.current.leaseState).toEqual({ phase: "held", leaseVersion: 8 });

      // NOW the stale A request REJECTS — the current context must NOT be
      // flipped to held-by-other by a request from the previous generation.
      await act(async () => {
        mocks.acquireLog[0].deferred.reject(new Error("stale A failed late"));
      });
      expect(result.current.leaseState).toEqual({ phase: "held", leaseVersion: 8 });

      // Heartbeat still presents version B.
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(mocks.renewMutate).toHaveBeenCalledWith({ episodeId: 2, leaseVersion: 8 });
      await act(async () => {
        mocks.renewLog[0].deferred.resolve({ leaseVersion: 9 });
      });
      expect(result.current.leaseState).toEqual({ phase: "held", leaseVersion: 9 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("disable→enable starts a fresh acquire without waiting for the prior pending request", async () => {
    resetMocks();
    const { rerender, result } = renderHook(
      (props: { episodeId: number; enabled: boolean }) => useReadingLease(props),
      { initialProps: { episodeId: 1, enabled: true } }
    );

    await waitFor(() => expect(mocks.acquireMutate).toHaveBeenCalledTimes(1));

    rerender({ episodeId: 1, enabled: false });
    rerender({ episodeId: 1, enabled: true });

    await waitFor(() => expect(mocks.acquireMutate).toHaveBeenCalledTimes(2));

    // The first request is stale (generation changed); settling it paints nothing.
    await act(async () => {
      mocks.acquireLog[0].deferred.resolve({ leaseVersion: 100 });
    });
    expect(result.current.leaseState.phase).toBe("idle");

    await act(async () => {
      mocks.acquireLog[1].deferred.resolve({ leaseVersion: 10 });
    });
    expect(result.current.leaseState).toEqual({ phase: "held", leaseVersion: 10 });
  });

  it("IR-01: a renew failure REALLY chains into another acquire on the same return (renew rejected, acquire #2 started, held after it settles)", async () => {
    resetMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = renderHook(
        (props: { episodeId: number; enabled: boolean }) => useReadingLease(props),
        { initialProps: { episodeId: 1, enabled: true } }
      );

      await waitFor(() => expect(mocks.acquireMutate).toHaveBeenCalledTimes(1));
      await act(async () => {
        mocks.acquireLog[0].deferred.resolve({ leaseVersion: 5 });
      });
      expect(result.current.leaseState).toEqual({ phase: "held", leaseVersion: 5 });

      // Heartbeat fires and presents the held version...
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(mocks.renewMutate).toHaveBeenCalledTimes(1);
      expect(mocks.renewMutate).toHaveBeenCalledWith({ episodeId: 1, leaseVersion: 5 });

      // ...the renew FAILS (lapsed/stale/displaced) — no visibility event,
      // no remount: the SAME return must chain into a typed acquire.
      await act(async () => {
        mocks.renewLog[0].deferred.reject(new Error("LEASE_LOST"));
      });
      await waitFor(() => expect(mocks.acquireMutate).toHaveBeenCalledTimes(2));

      // The chained acquire resolves → held again, without any further event.
      await act(async () => {
        mocks.acquireLog[1].deferred.resolve({ leaseVersion: 6 });
      });
      expect(result.current.leaseState).toEqual({ phase: "held", leaseVersion: 6 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("IR-01 inverse: a LIVE lease (renew succeeds) never triggers a chained acquire, and visibility while held does not re-acquire", async () => {
    resetMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = renderHook(
        (props: { episodeId: number; enabled: boolean }) => useReadingLease(props),
        { initialProps: { episodeId: 1, enabled: true } }
      );

      await waitFor(() => expect(mocks.acquireMutate).toHaveBeenCalledTimes(1));
      await act(async () => {
        mocks.acquireLog[0].deferred.resolve({ leaseVersion: 5 });
      });

      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      await act(async () => {
        mocks.renewLog[0].deferred.resolve({ leaseVersion: 5 });
      });
      expect(result.current.leaseState).toEqual({ phase: "held", leaseVersion: 5 });

      // Held + visible: a visibility event must NOT acquire again.
      await fireVisible();
      expect(mocks.acquireMutate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
