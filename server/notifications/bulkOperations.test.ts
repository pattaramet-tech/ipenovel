import { describe, expect, it, vi } from "vitest";
import { executeInboxBulkOperation, type InboxBulkStore, type InboxBulkTransaction, type PersistedBulkOperation } from "./bulkOperations";
import type { BulkActionKind } from "./contract";
const now=new Date("2026-10-24T00:00:00Z");
const key="operation_2026_A";
const user=42;
type Row={id:number, userId:number, seq:bigint, read:boolean, dismissed:boolean};
function harness() {
  let highWater=BigInt(3);
  let rows:Row[]=[
    {id:1,userId:user,seq:BigInt(1),read:false,dismissed:false},
    {id:2,userId:user,seq:BigInt(2),read:true,dismissed:false},
    {id:3,userId:100,seq:BigInt(3),read:false,dismissed:false},
  ];
  const operations=new Map<string,PersistedBulkOperation>();
  let applyCalls=0;
  // Serialize this test store like the DB transaction lock contract. Each
  // transaction stages mutations and commits only when all callbacks pass.
  let queue=Promise.resolve();
  const storage:InboxBulkStore={
    transaction:async<T>(fn:(tx:InboxBulkTransaction)=>Promise<T>)=>{
      const predecessor=queue;
      let release!:()=>void;
      queue=new Promise<void>(resolve=>{release=resolve;});
      await predecessor;
      const stagedRows=rows.map(row=>({...row}));
      const stagedOps=new Map(Array.from(operations,([id,op])=>[id,{...op}]));
      const tx:InboxBulkTransaction={
        lockOrCreateOperation:async(actor,operationKey,kind)=>{
          const id=`${actor}:${operationKey}`;
          let found=stagedOps.get(id);
          if(!found){
            found={actorUserId:actor,operationKey,kind,cutoffSequence:highWater,state:"pending",affected:null};
            stagedOps.set(id,found);
          }
          return {...found};
        },
        applyToRecipients:async(op)=>{
          applyCalls++;
          let affected=0;
          for(const row of stagedRows){
            if(row.userId!==op.actorUserId||row.seq>op.cutoffSequence||row.dismissed)continue;
            if(op.kind==="mark_all_read"){if(row.read)continue;row.read=true;}
            else row.dismissed=true;
            affected++;
          }
          return affected;
        },
        completeOperation:async(op,affected)=>{
          stagedOps.set(`${op.actorUserId}:${op.operationKey}`,{...op,state:"completed",affected});
        },
      };
      try{
        const result=await fn(tx);
        rows=stagedRows; operations.clear();
        for(const [id,op] of stagedOps)operations.set(id,op);
        return result;
      }finally{release();}
    },
  };
  return {
    storage,getRows:()=>rows.map(row=>({...row})),
    add:(actor:number,read=false)=>{highWater+=BigInt(1);rows.push({id:rows.length+1,userId:actor,seq:highWater,read,dismissed:false});},
    getApplyCalls:()=>applyCalls,getOperation:(actor:number,k:string)=>operations.get(`${actor}:${k}`),
  };
}

describe("snapshot bulk operation protocol",()=>{
  it("marks all unread rows at original cutoff across every page, but not another actor",async()=>{
    const h=harness();
    const r=await executeInboxBulkOperation(h.storage,user,key,"mark_all_read",now);
    expect(r).toMatchObject({affected:1,replay:false,cutoffSequence:BigInt(3)});
    expect(h.getRows().map(x=>x.read)).toEqual([true,true,false]);
    expect(h.getRows().every(row=>!row.dismissed)).toBe(true);
  });
  it("returns committed replay without consuming arrivals after snapshot",async()=>{
    const h=harness();
    const first=await executeInboxBulkOperation(h.storage,user,key,"delete_all",now);
    h.add(user);
    const replay=await executeInboxBulkOperation(h.storage,user,key,"delete_all",now);
    expect(replay).toMatchObject({affected:first.affected,replay:true,cutoffSequence:first.cutoffSequence});
    expect(h.getRows().map(row=>row.dismissed)).toEqual([true,true,false,false]);
    expect(h.getApplyCalls()).toBe(1);
  });
  it("refuses kind changes using the same actor/operation key",async()=>{
    const h=harness();
    await executeInboxBulkOperation(h.storage,user,key,"mark_all_read",now);
    await expect(executeInboxBulkOperation(h.storage,user,key,"delete_all",now)).rejects.toThrow("mismatch");
    expect(h.getApplyCalls()).toBe(1);
  });
  it("treats the same key scoped to another user separately",async()=>{
    const h=harness();
    await executeInboxBulkOperation(h.storage,user,key,"delete_all",now);
    const r=await executeInboxBulkOperation(h.storage,100,key,"delete_all",now);
    expect(r.affected).toBe(1);
    expect(h.getRows().map(row=>row.dismissed)).toEqual([true,true,true]);
  });
  it("rejects invalid actor, op key and operation state before mutation",async()=>{
    const h=harness();
    await expect(executeInboxBulkOperation(h.storage,-1,key,"delete_all",now)).rejects.toThrow();
    await expect(executeInboxBulkOperation(h.storage,user,"a","delete_all",now)).rejects.toThrow();
    await expect(executeInboxBulkOperation(h.storage,user,key,"unknown" as BulkActionKind,now)).rejects.toThrow();
    expect(h.getApplyCalls()).toBe(0);
  });
  it("rolls back all changes on a failed commit, including operation identity",async()=>{
    const h=harness();
    const abort:InboxBulkStore={transaction:fn=>h.storage.transaction(async tx=>{
      const wrapped:InboxBulkTransaction={...tx,completeOperation:async()=>{throw Error("DB transaction aborted");}};
      return fn(wrapped);
    })};
    await expect(executeInboxBulkOperation(abort,user,key,"delete_all",now)).rejects.toThrow("aborted");
    expect(h.getRows().some(row=>row.dismissed)).toBe(false);
    expect(h.getOperation(user,key)).toBeUndefined();
    expect((await executeInboxBulkOperation(h.storage,user,key,"delete_all",now)).affected).toBe(2);
  });
  it("serializes concurrent use of the same key and applies it once",async()=>{
    const h=harness();
    const [a,b]=await Promise.all([
      executeInboxBulkOperation(h.storage,user,key,"mark_all_read",now),
      executeInboxBulkOperation(h.storage,user,key,"mark_all_read",now),
    ]);
    expect([a.replay,b.replay].sort()).toEqual([false,true]);
    expect(h.getApplyCalls()).toBe(1);
  });
  it("propagates database outage, never returning fake zero",async()=>{
    const bad:InboxBulkStore={transaction:async()=>{throw Error("Database offline");}};
    await expect(executeInboxBulkOperation(bad,user,key,"mark_all_read",now)).rejects.toThrow("Database offline");
  });
});
