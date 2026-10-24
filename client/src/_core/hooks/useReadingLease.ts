import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { READER_LEASE_HEARTBEAT_SECONDS } from "@shared/const";

export type ReadingLeaseState =
  | { phase: "idle" }
  | { phase: "held"; leaseVersion: number }
  | { phase: "held-by-other" }
  | { phase: "lost" };

/**
 * R2 client lease lifecycle for the paid reader (design R1D Part B4):
 *  - acquire on open (the server's C1 gate auto-acquires too; this call hands
 *    the client the leaseVersion its heartbeats must present)
 *  - renew every READER_LEASE_HEARTBEAT_SECONDS while the tab is VISIBLE
 *    (Page Visibility API: mobile background suspends the timer, the lease
 *    lapses by TTL, and the reader cleanly re-acquires on return — no steal)
 *  - no release exists (F2: TTL-only); unload does nothing server-side
 *  - LEASE_HELD (another session reads) → phase "held-by-other": the UI shows
 *    the explicit ย้ายมาอ่านที่นี่ press; nothing happens automatically
 *  - LEASE_LOST (displaced after an explicit transfer elsewhere) → "lost"
 *
 * R4/D + IR-01 repairs:
 *  - FIRST visible-return recovery: a renew that fails (lapsed lease, stale
 *    version, displaced session) immediately chains into a typed ACQUIRE on
 *    the same return — the recovery no longer waits for a later visibility
 *    event, dependency change or remount. The server's acquire NEVER steals
 *    another session's LIVE lease (it answers LEASE_HELD), so the chain is
 *    no-steal by construction: it re-arms our own lapsed lease or flips the
 *    UI to the held-by-other transfer screen.
 *  - Stale-async guard: every acquire/renew/transfer response is tagged with
 *    a generation that increments on episode/enable changes; a response from
 *    a previous episode/session never paints state.
 */
export function useReadingLease(params: { episodeId: number; enabled: boolean }) {
  const { episodeId, enabled } = params;
  const utils = trpc.useUtils();
  const [state, setState] = useState<ReadingLeaseState>({ phase: "idle" });
  const stateRef = useRef<ReadingLeaseState>(state);
  stateRef.current = state;
  // Bumped whenever the lease context (episode/enabled) changes; responses
  // carrying an older generation are stale and discarded (R4/D).
  const generationRef = useRef(0);
  // D-ASYNC-01 repair: in-flight acquire is bound to the generation that
  // started it. A stale request from a previous episode/context must not
  // suppress a new acquire, and its finally must not clear the ownership of
  // the current request.
  const pendingAcquireGenRef = useRef<number | null>(null);

  const applyOk = useCallback((leaseVersion: number) => {
    setState({ phase: "held", leaseVersion });
  }, []);

  // Typed acquire — the server decides: re-arms our own lapsed/absent lease
  // (ok) or answers LEASE_HELD for a live other-session holder (no steal).
  const acquireNow = useCallback(async () => {
    const generation = generationRef.current;
    if (pendingAcquireGenRef.current === generation) return; // already in-flight for this context
    pendingAcquireGenRef.current = generation;
    try {
      const result = await utils.client.reader.lease.acquire.mutate({ episodeId });
      if (generation === generationRef.current && pendingAcquireGenRef.current === generation) {
        applyOk(result.leaseVersion);
      }
    } catch (error) {
      if (generation === generationRef.current && pendingAcquireGenRef.current === generation) {
        setState({ phase: "held-by-other" });
      }
    } finally {
      // Only clear ownership if no newer context has already started.
      if (pendingAcquireGenRef.current === generation) {
        pendingAcquireGenRef.current = null;
      }
    }
  }, [episodeId, applyOk, utils]);

  // Acquire on open + on visible-return when not currently held.
  useEffect(() => {
    if (!enabled || !episodeId) return;
    generationRef.current += 1;
    void acquireNow();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (stateRef.current.phase === "held") return; // live: heartbeat reconciles
      void acquireNow(); // lapsed / held-by-other / lost → typed re-acquire
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      generationRef.current += 1;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, episodeId, acquireNow]);

  // Heartbeat: visible-tab renew every 30s. R4/IR-01: a renew failure
  // (lapsed-by-TTL, stale version, displaced session) IMMEDIATELY chains
  // into a typed acquire on this same return — first-return recovery.
  useEffect(() => {
    if (!enabled || !episodeId) return;
    let cancelled = false;
    const tick = async () => {
      const current = stateRef.current;
      if (document.visibilityState !== "visible") return; // pause; TTL lapses; re-acquire on return
      if (current.phase !== "held") return; // nothing to renew until (re)acquired
      const generation = generationRef.current;
      try {
        const result = await utils.client.reader.lease.renew.mutate({
          episodeId,
          leaseVersion: current.leaseVersion,
        });
        if (!cancelled && generation === generationRef.current) applyOk(result.leaseVersion);
      } catch (error) {
        if (!cancelled && generation === generationRef.current) {
          setState({ phase: "lost" });
          void acquireNow(); // IR-01: don't stay stuck on "lost" until the next event
        }
      }
    };
    const interval = setInterval(tick, READER_LEASE_HEARTBEAT_SECONDS * 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, episodeId, applyOk, utils, acquireNow]);

  const transfer = useCallback(
    async (targetEpisodeId: number) => {
      const generation = generationRef.current;
      const result = await utils.client.reader.lease.transfer.mutate({ episodeId: targetEpisodeId });
      // R4/D: a transfer answered after the reader moved on never paints.
      if (generation === generationRef.current) applyOk(result.leaseVersion);
      return result;
    },
    [applyOk, utils]
  );

  return { leaseState: state, transferLease: transfer, markHeld: () => setState({ phase: "held-by-other" }) };
}
