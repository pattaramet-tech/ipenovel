import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  bangkokDayKey,
  eventDedupeKey,
  groupWishlistEpisodes,
  includedInBulkSnapshot,
  isCheckinReminderEligible,
  isEventAfterActivation,
  preferenceAllows,
  recipientDedupeKey,
} from "./contract";

describe("notification event and preference contracts", () => {
  it("requires explicit opt-in for catalog and check-in, not transactional events", () => {
    expect(DEFAULT_NOTIFICATION_PREFERENCES.novel_published).toBe(false);
    expect(DEFAULT_NOTIFICATION_PREFERENCES.daily_checkin_reminder).toBe(false);
    expect(DEFAULT_NOTIFICATION_PREFERENCES.wallet_topup_approved).toBe(true);
    expect(DEFAULT_NOTIFICATION_PREFERENCES.order_completed).toBe(true);
    expect(preferenceAllows("wishlist_episodes_published", {})).toBe(true);
    expect(preferenceAllows("wishlist_episodes_published", { wishlist_episodes_published: false })).toBe(false);
  });

  it("makes keys deterministic per first committed transition and recipient", () => {
    const key = eventDedupeKey({kind:"wallet_topup_approved",sourceType:"wallet_topups",sourceId:42,transitionId:"approved1"});
    expect(key).toBe(eventDedupeKey({kind:"wallet_topup_approved",sourceType:"wallet_topups",sourceId:42,transitionId:"approved1"}));
    expect(key).not.toBe(eventDedupeKey({kind:"wallet_topup_rejected",sourceType:"wallet_topups",sourceId:42,transitionId:"rejected1"}));
    expect(recipientDedupeKey(key,7)).not.toBe(recipientDedupeKey(key,8));
    expect(() => eventDedupeKey({kind:"order_completed",sourceType:"orders",sourceId:"abc/token",transitionId:"approved1"})).toThrow();
    expect(() => recipientDedupeKey(key,0)).toThrow();
  });

  it("uses Asia/Bangkok date boundaries independently of UTC server date", () => {
    expect(bangkokDayKey(new Date("2026-10-23T16:59:59Z"))).toBe("2026-10-23");
    expect(bangkokDayKey(new Date("2026-10-23T17:00:00Z"))).toBe("2026-10-24");
    expect(() => bangkokDayKey(new Date("invalid"))).toThrow();
  });

  it("requires campaign, opt-in, active account and not checked in", () => {
    const sample={instant:new Date("2026-10-23T17:00:00Z"),campaignEnabled:true,optedIn:true,hasCheckinForBangkokDay:false,userActive:true};
    expect(isCheckinReminderEligible(sample)).toBe(true);
    for(const property of ["campaignEnabled","optedIn","userActive"] as const){
      expect(isCheckinReminderEligible({...sample,[property]:false})).toBe(false);
    }
    expect(isCheckinReminderEligible({...sample,hasCheckinForBangkokDay:true})).toBe(false);
  });

  it("does not generate catalog historical notifications before activation", () => {
    const activated=new Date("2026-10-24T00:00:00Z");
    expect(isEventAfterActivation(new Date("2026-10-23T23:59:59Z"),activated)).toBe(false);
    expect(isEventAfterActivation(activated,activated)).toBe(true);
  });
});

describe("bounded Wishlist digest contract", () => {
  it("deduplicates, sorts, isolates novels and splits at fifty", () => {
    const rows=Array.from({length:51},(_,i)=>({novelId:9,episodeId:51-i,batchKey:"first"}));
    const result=groupWishlistEpisodes([...rows,rows[0],{novelId:10,episodeId:7,batchKey:"first"}]);
    expect(result.filter(x=>x.novelId===9).map(x=>x.episodeIds.length)).toEqual([50,1]);
    expect(result.filter(x=>x.novelId===9).map(x=>x.partIndex)).toEqual([0,1]);
    expect(result.find(x=>x.novelId===9)?.episodeIds[0]).toBe(1);
    expect(result.find(x=>x.novelId===10)?.episodeIds).toEqual([7]);
    expect(groupWishlistEpisodes(rows)).toEqual(groupWishlistEpisodes([...rows].reverse()));
  });

  it("separates release batches and refuses unbounded grouping", () => {
    const publications=[{novelId:1,episodeId:1,batchKey:"batch1"},{novelId:1,episodeId:2,batchKey:"batch2"}];
    expect(groupWishlistEpisodes(publications)).toHaveLength(2);
    expect(() => groupWishlistEpisodes(publications,51)).toThrow();
    expect(() => groupWishlistEpisodes([{novelId:1,episodeId:2,batchKey:"bad:secret"}])).toThrow();
    expect(() => groupWishlistEpisodes([{novelId:1,episodeId:2,batchKey:"a".repeat(73)}])).toThrow("too long");
  });
});

describe("actor-bound bulk cutoff predicate", () => {
  const snapshot={actorUserId:7,operationKey:"operation_aaa_1",kind:"mark_all_read" as const,cutoffSequence:100n};
  const row={userId:7,receivedSequence:100n,readAt:null,dismissedAt:null};

  it("marks all current unread pages without touching newer arrivals or other actors", () => {
    expect(includedInBulkSnapshot(row,snapshot)).toBe(true);
    expect(includedInBulkSnapshot({...row,receivedSequence:101n},snapshot)).toBe(false);
    expect(includedInBulkSnapshot({...row,userId:8},snapshot)).toBe(false);
    expect(includedInBulkSnapshot({...row,readAt:new Date()},snapshot)).toBe(false);
  });

  it("deletes read and unread inbox recipients but not already dismissed tombstones", () => {
    const deleting={...snapshot,kind:"delete_all" as const};
    expect(includedInBulkSnapshot({...row,readAt:new Date()},deleting)).toBe(true);
    expect(includedInBulkSnapshot({...row,dismissedAt:new Date()},deleting)).toBe(false);
    expect(includedInBulkSnapshot({...row,receivedSequence:101n},deleting)).toBe(false);
    expect(() => includedInBulkSnapshot(row,{...snapshot,operationKey:"bad"})).toThrow();
  });
});
