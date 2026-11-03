import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DELIVERY_LIMITS,
  NotificationPermanentError,
  retryDelayMs,
  runInAppDeliveryTick,
  type ClaimedEvent,
  type NotificationDeliveryStore,
} from "./deliveryPolicy";

const event: ClaimedEvent = {
  eventId:"1", eventKey:"notification:v1:order_completed:order:11:approved1",
  kind:"order_completed",leaseToken:"lease-1",attempt:1,audienceCursor:null,
};

function store(overrides: Partial<NotificationDeliveryStore> = {}): NotificationDeliveryStore {
  return {
    claimReadyEvents:vi.fn(async() => [event]),
    readAudience:vi.fn(async() => ({userIds:[2,3],nextCursor:null})),
    insertRecipientIfAbsent:vi.fn(async()=> "created" as const),
    checkpointAudience:vi.fn(async()=>{}),
    completeEvent:vi.fn(async()=>{}),
    scheduleRetry:vi.fn(async()=>{}),
    deadLetter:vi.fn(async()=>{}),
    ...overrides,
  };
}
const now = new Date("2026-10-24T00:00:00Z");

describe("bounded in-app delivery worker", () => {
  it("creates at most one audience page, then completes the event", async () => {
    const adapter=store();
    const result=await runInAppDeliveryTick(adapter,now);
    expect(result).toMatchObject({claimed:1,created:2,completed:1,retried:0});
    expect(adapter.readAudience).toHaveBeenCalledWith(event,100);
    expect(adapter.completeEvent).toHaveBeenCalledWith(event);
    expect(adapter.scheduleRetry).not.toHaveBeenCalled();
  });

  it("checkpoints a partial cursor instead of incorrectly completing", async () => {
    const adapter=store({readAudience:vi.fn(async()=>({userIds:[2],nextCursor:"2"}))});
    expect(await runInAppDeliveryTick(adapter,now)).toMatchObject({partial:1,completed:0});
    expect(adapter.checkpointAudience).toHaveBeenCalledWith(event,"2");
    expect(adapter.completeEvent).not.toHaveBeenCalled();
  });

  it("never recreates previously dismissed recipients on replay", async () => {
    const adapter=store({insertRecipientIfAbsent:vi.fn(async(_e,userId)=>userId===2?"dismissed" as const:"already_exists" as const)});
    const r=await runInAppDeliveryTick(adapter,now);
    expect(r).toMatchObject({created:0,dismissed:1,alreadyExists:1,completed:1});
    expect(adapter.completeEvent).toHaveBeenCalledTimes(1);
  });

  it("skips a newly opted-out recipient without retrying or consuming a sequence", async () => {
    const adapter=store({insertRecipientIfAbsent:vi.fn(async(_e,userId)=>
      userId===2?"ineligible" as const:"created" as const)});
    const result=await runInAppDeliveryTick(adapter,now);
    expect(result).toMatchObject({created:1,ineligible:1,completed:1,retried:0});
    expect(adapter.completeEvent).toHaveBeenCalledTimes(1);
  });

  it("retries after a partial write and does not falsely mark complete", async () => {
    let calls=0;
    const adapter=store({insertRecipientIfAbsent:vi.fn(async()=>{if(++calls===2)throw new Error("sensitive detail");return "created" as const;})});
    const r=await runInAppDeliveryTick(adapter,now);
    expect(r).toMatchObject({created:1,retried:1,completed:0});
    expect(adapter.completeEvent).not.toHaveBeenCalled();
    expect(adapter.scheduleRetry).toHaveBeenCalledWith(event,new Date(now.getTime()+30_000),"DELIVERY_ERROR");
  });

  it("uses bounded exponential backoff and terminal dead letters", async () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(100)).toBe(DEFAULT_DELIVERY_LIMITS.maxRetryMs);
    const exhausted={...event,attempt:8};
    const adapter=store({claimReadyEvents:vi.fn(async()=>[exhausted]),readAudience:vi.fn(async()=>{throw Error("private DB connection");})});
    const r=await runInAppDeliveryTick(adapter,now);
    expect(r).toMatchObject({retried:0,deadLettered:1});
    expect(adapter.deadLetter).toHaveBeenCalledWith(exhausted,"DELIVERY_ERROR");
  });

  it("dead-letters structurally invalid audience responses", async () => {
    const adapter=store({readAudience:vi.fn(async()=>({userIds:[2,2],nextCursor:null}))});
    expect(await runInAppDeliveryTick(adapter,now)).toMatchObject({deadLettered:1});
    expect(adapter.deadLetter).toHaveBeenCalledWith(event,"PERMANENT_DELIVERY_ERROR");
  });

  it("rejects cyclic, non-monotonic and malformed audience cursors before insertion", async () => {
    const cases = [
      {claimed:{...event,audienceCursor:"10"},page:{userIds:[11],nextCursor:"10"}},
      {claimed:{...event,audienceCursor:"10"},page:{userIds:[11,10],nextCursor:null}},
      {claimed:event,page:{userIds:[3,2],nextCursor:null}},
      {claimed:event,page:{userIds:[2],nextCursor:"opaque_2"}},
      {claimed:event,page:{userIds:[2],nextCursor:"1"}},
      {claimed:{...event,audienceCursor:"0002"},page:{userIds:[3],nextCursor:null}},
    ];
    for (const {claimed,page} of cases) {
      const adapter=store({
        claimReadyEvents:vi.fn(async()=>[claimed]),
        readAudience:vi.fn(async()=>page),
      });
      expect(await runInAppDeliveryTick(adapter,now)).toMatchObject({deadLettered:1,created:0});
      expect(adapter.insertRecipientIfAbsent).not.toHaveBeenCalled();
      expect(adapter.deadLetter).toHaveBeenCalledWith(claimed,"PERMANENT_DELIVERY_ERROR");
    }
  });

  it("allows a keyset cursor past filtered-out user IDs", async () => {
    const adapter=store({readAudience:vi.fn(async()=>({userIds:[2],nextCursor:"5"}))});
    expect(await runInAppDeliveryTick(adapter,now)).toMatchObject({partial:1,created:1});
    expect(adapter.checkpointAudience).toHaveBeenCalledWith(event,"5");
  });

  it("refuses an over-sized claim instead of breaking operational bounds", async () => {
    const adapter=store({claimReadyEvents:vi.fn(async()=>Array.from({length:11},()=>event))});
    await expect(runInAppDeliveryTick(adapter,now)).rejects.toThrow("claim limit");
  });

  it("propagates persistence failures during retry scheduling", async () => {
    const adapter=store({readAudience:vi.fn(async()=>{throw new Error("temporary");}),scheduleRetry:vi.fn(async()=>{throw new Error("DB down");})});
    await expect(runInAppDeliveryTick(adapter,now)).rejects.toThrow("DB down");
  });

  it("does not call a business money/entitlement operation", async () => {
    const adapter=store();
    await runInAppDeliveryTick(adapter,now);
    expect(Object.keys(adapter).sort()).toEqual([
      "checkpointAudience","claimReadyEvents","completeEvent","deadLetter",
      "insertRecipientIfAbsent","readAudience","scheduleRetry",
    ]);
    expect(NotificationPermanentError.name).toBe("NotificationPermanentError");
  });
});
