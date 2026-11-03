import { describe, expect, it, vi } from "vitest";
import { insertQualifiedNotification, qualifyBusinessNotification, type BusinessOutcomeReceipt } from "./eventIngress";
import { groupWishlistEpisodes } from "./contract";
const tx=(outcome:"created"|"duplicate")=>({insertEventWithOutboxIfAbsent:vi.fn(async()=>outcome)});
describe("qualified business event ingress",()=>{
  it("emits a deterministic topup event only for committed wallet credit",async()=>{
    const receipt:BusinessOutcomeReceipt={kind:"wallet_topup_approved",topupId:45,transitionKey:"approved1",settlement:"credited",userId:7};
    const store=tx("created");
    const first=await insertQualifiedNotification(store,receipt);
    expect(first.created).toBe(true);
    expect(first.eventKey).toContain("wallet_topup_approved");
    expect(store.insertEventWithOutboxIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
      sourceType:"wallet_topups",targetUserId:7,
    }));
    expect((await insertQualifiedNotification(tx("duplicate"),receipt)).eventKey).toBe(first.eventKey);
  });
  it("refuses pending slip or incompletely settled order",()=>{
    expect(()=>qualifyBusinessNotification({
      kind:"wallet_topup_approved",topupId:1,transitionKey:"pending",settlement:"pending_review",userId:7,
    } as unknown as BusinessOutcomeReceipt)).toThrow("credit");
    expect(()=>qualifyBusinessNotification({
      kind:"order_completed",orderId:1,transitionKey:"half",settlement:"pending",userId:7,
    } as unknown as BusinessOutcomeReceipt)).toThrow("finalized");
  });
  it("dedupes the same order no matter the admin/provider/wallet checkout caller",()=>{
    const same:BusinessOutcomeReceipt={kind:"order_completed",orderId:123,transitionKey:"first_completion",settlement:"purchases_finalized",userId:19};
    expect(qualifyBusinessNotification(same).key).toBe(qualifyBusinessNotification({...same}).key);
  });
  it("rejects fake chapter entitlement or unqualified publication",()=>{
    expect(()=>qualifyBusinessNotification({
      kind:"episode_wallet_purchased",purchaseId:5,transitionKey:"x",settlement:"debited_only",userId:7,
    } as unknown as BusinessOutcomeReceipt)).toThrow("not settled");
    expect(()=>qualifyBusinessNotification({
      kind:"novel_published",novelId:2,transitionKey:"x",firstPublicTransition:false,
    } as unknown as BusinessOutcomeReceipt)).toThrow("first");
  });
  it("publishes only first-publication identifiers and at most fifty episodes",()=>{
    const r:BusinessOutcomeReceipt={kind:"wishlist_episodes_published",novelId:1,batchKey:"b1",partIndex:0,transitionKey:"v1",firstPublicEpisodeIds:[3,2,3,1]};
    expect(qualifyBusinessNotification(r).episodeIds).toEqual([1,2,3]);
    expect(qualifyBusinessNotification(r).key).not.toBe(
      qualifyBusinessNotification({...r,novelId:2}).key
    );
    expect(()=>qualifyBusinessNotification({...r,firstPublicEpisodeIds:[]})).toThrow();
    expect(()=>qualifyBusinessNotification({...r,firstPublicEpisodeIds:Array.from({length:51},(_,i)=>i+1)})).toThrow();
  });
  it("assigns distinct stable event keys to each partition of a 51-episode publication",()=>{
    const publications=Array.from({length:51},(_,i)=>({novelId:9,episodeId:51-i,batchKey:"publish9"}));
    const chunks=groupWishlistEpisodes(publications);
    expect(chunks.map(x=>x.partIndex)).toEqual([0,1]);
    const keys=chunks.map(x=>qualifyBusinessNotification({kind:"wishlist_episodes_published",
      novelId:x.novelId,batchKey:x.batchKey,partIndex:x.partIndex,
      transitionKey:"first_publish",firstPublicEpisodeIds:x.episodeIds}).key);
    expect(new Set(keys).size).toBe(2);
    expect(groupWishlistEpisodes([...publications].reverse())).toEqual(chunks);
    expect(()=>qualifyBusinessNotification({kind:"wishlist_episodes_published",
      novelId:9,batchKey:"publish9",partIndex:-1,transitionKey:"first_publish",firstPublicEpisodeIds:[1]})).toThrow("partition");
    expect(()=>qualifyBusinessNotification({kind:"wishlist_episodes_published",
      novelId:9,batchKey:"publish9",partIndex:100000,transitionKey:"first_publish",firstPublicEpisodeIds:[1]})).toThrow("partition");
  });
  it("uses Asia/Bangkok for opt-in checkin only when campaign is open",()=>{
    const r:BusinessOutcomeReceipt={kind:"daily_checkin_reminder",campaignKey:"daily",userId:4,
      day:new Date("2026-10-23T17:00:00.000Z"),campaignEnabled:true,optedIn:true,alreadyCheckedIn:false};
    expect(qualifyBusinessNotification(r).transitionKey).toBe("4_20261024");
    expect(()=>qualifyBusinessNotification({...r,optedIn:false} as unknown as BusinessOutcomeReceipt)).toThrow();
  });
  it("rejects invalid insert return instead of reporting success",async()=>{
    const store={insertEventWithOutboxIfAbsent:vi.fn(async()=> "unexpected" as "created")};
    await expect(insertQualifiedNotification(store,{kind:"wallet_topup_rejected",topupId:1,
      transitionKey:"rejected",settlement:"rejected",userId:4})).rejects.toThrow("Invalid notification");
  });
});
