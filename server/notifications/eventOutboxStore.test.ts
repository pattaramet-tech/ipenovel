import { describe, expect, it, vi } from "vitest";
import { createTransactionalEventOutboxAdapter } from "./eventOutboxStore";
import { notificationEvents, notificationOutbox, notificationDigestEpisodes } from "./tables";
import { qualifyBusinessNotification } from "./eventIngress";

const at=new Date("2026-10-24T01:00:00Z");
const activation=new Date("2026-10-24T00:00:00Z");
const receipt={kind:"wallet_topup_approved" as const,topupId:3,transitionKey:"approved1",settlement:"credited" as const,userId:17};
const event=qualifyBusinessNotification(receipt);

function mockTx() {
  const writes:Array<{table:unknown;value:any}>=[];
  let prior:any=null;
  let nextError:unknown=null;
  const tx={
    insert:(table:unknown)=>({values:async(value:any)=>{
      if(nextError && table===notificationEvents){const e=nextError;nextError=null;throw e;}
      writes.push({table,value});
      if(table===notificationEvents)return [{insertId:55}];
      return [{affectedRows:1}];
    }}),
    select:(_projection:any)=>({from:(_table:unknown)=>({where:(_condition:any)=>({limit:async(_n:number)=>prior?[prior]:[]})})}),
  };
  return {tx,writes,setPrior:(v:any)=>{prior=v;},setNextError:(e:unknown)=>{nextError=e;}};
}
describe("transaction-bound outbox persistence",()=>{
  it("inserts immutable event then outbox inside the same caller transaction",async()=>{
    const m=mockTx();
    const outbox=createTransactionalEventOutboxAdapter(m.tx,at,activation);
    expect(await outbox.insertEventWithOutboxIfAbsent(event)).toBe("created");
    expect(m.writes.map(x=>x.table)).toEqual([notificationEvents,notificationOutbox]);
    expect(m.writes[0].value).toMatchObject({eventKey:event.key,targetUserId:17});
    expect(m.writes[1].value).toMatchObject({state:"pending",eventId:BigInt(55)});
  });
  it("dedupes a genuine competing insert without enqueuing again",async()=>{
    const m=mockTx();
    m.setNextError({cause:{errno:1062,code:"ER_DUP_ENTRY"}});
    m.setPrior({id:BigInt(55),kind:event.kind,sourceType:event.sourceType,
      sourceId:event.sourceId,transitionKey:event.transitionKey,targetUserId:event.targetUserId});
    const outbox=createTransactionalEventOutboxAdapter(m.tx,at,activation);
    expect(await outbox.insertEventWithOutboxIfAbsent(event)).toBe("duplicate");
    expect(m.writes).toHaveLength(0);
  });
  it("does not treat a mismatched source identity as a duplicate",async()=>{
    const m=mockTx();
    m.setNextError({cause:{errno:1062}});
    m.setPrior({id:BigInt(55),kind:event.kind,sourceType:"unrelated",sourceId:event.sourceId,
      transitionKey:event.transitionKey,targetUserId:event.targetUserId});
    await expect(createTransactionalEventOutboxAdapter(m.tx,at,activation)
      .insertEventWithOutboxIfAbsent(event)).rejects.toThrow("identity collision");
    expect(m.writes).toHaveLength(0);
  });
  it("fails closed on invalid recipients and invalid driver insert IDs",async()=>{
    const m=mockTx();
    await expect(createTransactionalEventOutboxAdapter(m.tx,at,activation)
      .insertEventWithOutboxIfAbsent({...event,targetUserId:0})).rejects.toThrow("Invalid notification recipient");
    expect(m.writes).toHaveLength(0);

    const writes:unknown[]=[];
    const invalidIdTx:any={insert:(table:unknown)=>({values:async()=>{
      writes.push(table);
      return [{insertId:"55"}];
    }})};
    await expect(createTransactionalEventOutboxAdapter(invalidIdTx,at,activation)
      .insertEventWithOutboxIfAbsent(event)).rejects.toThrow("Invalid inserted notification event ID");
    expect(writes).toEqual([notificationEvents]);
  });
  it("fails closed when duplicate-key recovery cannot find the original event",async()=>{
    const m=mockTx();
    m.setNextError({cause:{errno:1062,code:"ER_DUP_ENTRY"}});
    await expect(createTransactionalEventOutboxAdapter(m.tx,at,activation)
      .insertEventWithOutboxIfAbsent(event)).rejects.toThrow("Notification event identity collision");
    expect(m.writes).toHaveLength(0);
  });
  it("does not emit historical events before notification activation",async()=>{
    const m=mockTx();
    const adapter=createTransactionalEventOutboxAdapter(m.tx,new Date("2026-10-23T23:00:00Z"),activation);
    expect(await adapter.insertEventWithOutboxIfAbsent(event)).toBe("skipped");
    expect(m.writes).toHaveLength(0);
  });
  it("does not swallow a database outage or a failed outbox write",async()=>{
    const m=mockTx();
    m.setNextError({code:"ECONNREFUSED"});
    await expect(createTransactionalEventOutboxAdapter(m.tx,at,activation)
      .insertEventWithOutboxIfAbsent(event)).rejects.toMatchObject({code:"ECONNREFUSED"});
    const broken:any={
      insert:(table:any)=>({values:async()=>{if(table===notificationOutbox)throw new Error("outbox insert failed");return [{insertId:55}];}}),
    };
    await expect(createTransactionalEventOutboxAdapter(broken,at,activation)
      .insertEventWithOutboxIfAbsent(event)).rejects.toThrow("outbox insert failed");
  });
  it("attaches digest episode IDs with the same event/transaction",async()=>{
    const m=mockTx();
    const e=qualifyBusinessNotification({kind:"wishlist_episodes_published",novelId:20,
      batchKey:"publication42",partIndex:0,transitionKey:"v1",firstPublicEpisodeIds:[9,3,9]});
    expect(await createTransactionalEventOutboxAdapter(m.tx,at,activation)
      .insertEventWithOutboxIfAbsent(e)).toBe("created");
    expect(m.writes.filter(x=>x.table===notificationDigestEpisodes).map(x=>x.value.episodeId)).toEqual([BigInt(3),BigInt(9)]);
  });
});
