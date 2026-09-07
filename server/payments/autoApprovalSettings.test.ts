import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({getDb:vi.fn()}));
vi.mock("../db",()=>mocks);
import { AUTO_APPROVE_KEY, parseAutoPolicy, readAutoPolicy, saveAutoPolicy, autoApprovalSettingsRouter, isAutoPolicyKey } from "./autoApprovalSettings";
let rows:any[],failAudit:boolean;
const ctx=(role:string|null)=>({user:role?{id:7,role}:null,req:{headers:{}},res:{}}) as any;
beforeEach(()=>{
 rows=[];failAudit=false;
 const tx:any={
  select:()=>({from:()=>({where:()=>({limit:()=>{
   const p:any=Promise.resolve(rows.filter(r=>r.key===AUTO_APPROVE_KEY));p.for=async()=>rows.filter(r=>r.key===AUTO_APPROVE_KEY);return p;
  }})})}),
  insert:()=>({values:(r:any)=>{
   if(r.key===AUTO_APPROVE_KEY)return{onDuplicateKeyUpdate:async()=>{if(!rows.some(x=>x.key===r.key))rows.push(r);}};
   if(failAudit)throw Error("audit failure");rows.push(r);return Promise.resolve();
  }}),
  update:()=>({set:(v:any)=>({where:async()=>{rows=rows.map(r=>r.key===AUTO_APPROVE_KEY?{...r,...v}:r);}})}),
  transaction:async(fn:any)=>{const old=structuredClone(rows);try{return await fn(tx);}catch(e){rows=old;throw e;}},
 };
 mocks.getDb.mockResolvedValue(tx);
});
describe("dynamic provider auto approval settings",()=>{
 it("defaults to disabled",async()=>expect((await readAutoPolicy()).enabled).toBe(false));
 it("saves through admin router and reads changes immediately with audit",async()=>{
  const c=autoApprovalSettingsRouter.createCaller(ctx("admin"));
  await c.update({enabled:true,expectedRevision:0,reason:"Enable tests"});
  expect(await c.get()).toMatchObject({enabled:true,revision:1,updatedBy:7});
  await c.update({enabled:false,expectedRevision:1,reason:"Disable tests"});
  expect((await c.get()).enabled).toBe(false);expect(rows.filter(r=>r.key.includes("autoAudit."))).toHaveLength(2);
 });
 it("rejects stale settings",async()=>{
  await saveAutoPolicy({enabled:true,expectedRevision:0,reason:"test"},7);
  await expect(saveAutoPolicy({enabled:false,expectedRevision:0,reason:"stale"},7)).rejects.toMatchObject({code:"CONFLICT"});
  expect((await readAutoPolicy()).enabled).toBe(true);
 });
 it("rolls back if audit fails",async()=>{
  failAudit=true;await expect(saveAutoPolicy({enabled:true,expectedRevision:0,reason:"test"},7)).rejects.toThrow();expect(rows).toEqual([]);
 });
 it.each([null,"user"])("denies %s reading and changing policy",async role=>{
  const c=autoApprovalSettingsRouter.createCaller(ctx(role));
  await expect(c.get()).rejects.toMatchObject({code:role?"FORBIDDEN":"UNAUTHORIZED"});
  await expect(c.update({enabled:true,expectedRevision:0,reason:"test"})).rejects.toThrow();
 });
 it.each(["{bad",'{"enabled":"true","revision":0}','{"enabled":true,"revision":-1}'])("fails closed for malformed setting %s",v=>expect(()=>parseAutoPolicy(v)).toThrow());
 it("rejects missing database and empty reason",async()=>{
  await expect(saveAutoPolicy({enabled:true,expectedRevision:0,reason:""},7)).rejects.toThrow();
  mocks.getDb.mockResolvedValue(null);await expect(readAutoPolicy()).rejects.toThrow("AUTO_APPROVE_SETTINGS_UNAVAILABLE");
 });
 it("blocks generic settings bypass including case and whitespace",()=>{
  expect(isAutoPolicyKey(" PROVIDER_AUTO_APPROVE ")).toBe(true);
  expect(isAutoPolicyKey("PAYMENTVERIFICATION.AUTOAUDIT.X")).toBe(true);
  expect(isAutoPolicyKey("other")).toBe(false);
 });
});
