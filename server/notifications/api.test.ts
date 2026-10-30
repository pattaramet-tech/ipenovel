import { describe, expect, it, vi } from "vitest";
import { createNotificationsRouter, type NotificationApiStore, type InboxView } from "./api";
import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";

vi.mock("../_core/accountMergeSessionGate",()=>({
  isCompletedAccountMergeSource:vi.fn(async()=>false),
  ACCOUNT_MERGED_RELOGIN_REQUIRED_CODE:"MERGED_SOURCE",
  ACCOUNT_MERGED_RELOGIN_REQUIRED_MESSAGE:"Relogin required",
}));
vi.mock("../_core/googleMigrationGate",()=>({
  isBlockedByGoogleMigrationGate:vi.fn(async()=>false),
  GOOGLE_CONNECTION_REQUIRED_CODE:"GOOGLE_REQUIRED",
  GOOGLE_CONNECTION_REQUIRED_MESSAGE:"Google required",
}));
const now=new Date("2026-10-24T00:00:00.000Z");
const row:InboxView={id:"11",category:"finance",title:"Order completed",summary:"Payment approved",receivedSequence:BigInt(100),createdAt:now,readAt:null};
const key=randomBytes(32);
function deps(){
  const store:NotificationApiStore={
    listOwnInbox:vi.fn(async()=>[row]),
    countOwnUnread:vi.fn(async()=>1),
    markOwnRead:vi.fn(async(_actor,id)=>id==="11"),
    getOwnPreferences:vi.fn(async()=>({novel_published:true})),
    setOwnPreference:vi.fn(async()=>{}),
    bulk:{transaction:vi.fn(async(fn)=>fn({
      lockOrCreateOperation:async (actor,operationKey,kind)=>({
        actorUserId:actor,operationKey,kind,cutoffSequence:BigInt(100),state:"pending" as const,affected:null,
      }),
      applyToRecipients:async()=>1,
      completeOperation:async()=>{},
    }))},
  };
  const notifications=createNotificationsRouter({store,cursorSigningKey:key,now:()=>now});
  const caller=(userId:number)=>notifications.createCaller({user:{id:userId,role:"admin"}} as any);
  return {store,notifications,caller};
}
describe("Notification API authenticated actor contract",()=>{
  it("rejects anonymous callers before any inbox access",async()=>{
    const {store,notifications}=deps();
    await expect(notifications.createCaller({user:null} as any).unreadCount()).rejects.toMatchObject({code:"UNAUTHORIZED"});
    expect(store.countOwnUnread).not.toHaveBeenCalled();
  });
  it("derives actor from session, refuses foreign IDs and never sends sequence",async()=>{
    const {store,caller}=deps();
    const page=await caller(7).list({});
    expect(page.items).toEqual([{
      id:"11",category:"finance",title:"Order completed",summary:"Payment approved",
      createdAt:now,readAt:null,
    }]);
    expect(store.listOwnInbox).toHaveBeenCalledWith(expect.objectContaining({actorUserId:7,beforeSequence:null,limit:20}));
    await expect(caller(8).markRead({id:"999"})).rejects.toMatchObject({code:"NOT_FOUND"});
    expect(store.markOwnRead).toHaveBeenCalledWith(8,"999");
  });
  it("returns real error for DB outage instead of fabricated zero",async()=>{
    const {store,caller}=deps();
    vi.mocked(store.countOwnUnread).mockRejectedValueOnce(new Error("DB disconnected"));
    await expect(caller(7).unreadCount()).rejects.toMatchObject({code:"INTERNAL_SERVER_ERROR"});
  });
  it("validates forged input and bounds category/limit/ID",async()=>{
    const {store,caller}=deps();
    await expect(caller(7).list({limit:1000})).rejects.toMatchObject({code:"BAD_REQUEST"});
    await expect(caller(7).markRead({id:"not_an_id"})).rejects.toMatchObject({code:"BAD_REQUEST"});
    await expect(caller(7).list({category:"secret" as any})).rejects.toMatchObject({code:"BAD_REQUEST"});
    expect(store.listOwnInbox).not.toHaveBeenCalled();
  });
  it("validates signed cursor against the session actor",async()=>{
    const {store,caller}=deps();
    const first=await caller(7).list({limit:1});
    expect(first.nextCursor).toEqual(expect.any(String));
    await expect(caller(8).list({limit:1,cursor:first.nextCursor!})).rejects.toMatchObject({code:"BAD_REQUEST"});
    expect(store.listOwnInbox).toHaveBeenCalledTimes(1);
  });
  it("rejects cursor reuse after unread-only filter changes both ways",async()=>{
    const {store,caller}=deps();
    const actor=caller(7);
    const unread=await actor.list({limit:1,category:"finance",unreadOnly:true});
    const all=await actor.list({limit:1,category:"finance",unreadOnly:false});
    expect(unread.nextCursor).toEqual(expect.any(String));
    expect(all.nextCursor).toEqual(expect.any(String));
    await expect(actor.list({limit:1,category:"finance",unreadOnly:false,cursor:unread.nextCursor!}))
      .rejects.toMatchObject({code:"BAD_REQUEST"});
    await expect(actor.list({limit:1,category:"finance",unreadOnly:true,cursor:all.nextCursor!}))
      .rejects.toMatchObject({code:"BAD_REQUEST"});
    expect(store.listOwnInbox).toHaveBeenCalledTimes(2);
    // A properly scoped next page contains only rows strictly below sequence 100.
    vi.mocked(store.listOwnInbox).mockResolvedValueOnce([]);
    await actor.list({limit:1,category:"finance",unreadOnly:true,cursor:unread.nextCursor!});
    expect(store.listOwnInbox).toHaveBeenLastCalledWith(expect.objectContaining({
      actorUserId:7,category:"finance",unreadOnly:true,beforeSequence:BigInt(100),limit:1,
    }));
  });
  it("binds preference writes and bulk operations to current actor only",async()=>{
    const {store,caller}=deps();
    expect((await caller(50).unreadCount()).count).toBe(1);
    await caller(50).setPreference({kind:"novel_published",enabled:true});
    expect(store.setOwnPreference).toHaveBeenCalledWith(50,"novel_published",true);
    const result=await caller(50).deleteAll({operationKey:"operation_key_1"});
    expect(result).toMatchObject({kind:"delete_all",affected:1,cutoffSequence:"100"});
    expect(store.bulk.transaction).toHaveBeenCalledOnce();
    await expect(caller(50).markAllRead({operationKey:"bad"})).rejects.toMatchObject({code:"BAD_REQUEST"});
  });
});
