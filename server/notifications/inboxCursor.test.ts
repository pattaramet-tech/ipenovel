import { describe, expect, it } from "vitest";
import { decodeInboxCursor, encodeInboxCursor } from "./inboxCursor";
const secret = Buffer.alloc(32, 11);
const otherSecret = Buffer.alloc(32, 12);
const now = new Date("2026-10-24T00:00:00.000Z");
const actorUserId=25;
const position={actorUserId,category:"novel" as const,unreadOnly:false,beforeSequence:BigInt(100)};
describe("authenticated in-app inbox cursors",()=>{
  it("roundtrips self-scoped category and descending position",()=>{
    const token=encodeInboxCursor(position,secret,now);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(decodeInboxCursor(token,actorUserId,"novel",false,secret,now)).toEqual(position);
  });
  it("rejects token replay across users and categories",()=>{
    const token=encodeInboxCursor(position,secret,now);
    expect(()=>decodeInboxCursor(token,24,"novel",false,secret,now)).toThrow("notification cursor");
    expect(()=>decodeInboxCursor(token,actorUserId,"finance",false,secret,now)).toThrow();
  });
  it("rejects replay across unread-only and all-item filters in both directions",()=>{
    const allToken=encodeInboxCursor(position,secret,now);
    const unreadPosition={...position,unreadOnly:true};
    const unreadToken=encodeInboxCursor(unreadPosition,secret,now);
    expect(decodeInboxCursor(unreadToken,actorUserId,"novel",true,secret,now)).toEqual(unreadPosition);
    expect(()=>decodeInboxCursor(allToken,actorUserId,"novel",true,secret,now)).toThrow("notification cursor");
    expect(()=>decodeInboxCursor(unreadToken,actorUserId,"novel",false,secret,now)).toThrow("notification cursor");
    expect(()=>encodeInboxCursor({...position,unreadOnly:"false" as any},secret,now)).toThrow();
    expect(()=>decodeInboxCursor(allToken,actorUserId,"novel","false" as any,secret,now)).toThrow();
  });
  it("rejects tampering or a different server signing key",()=>{
    const token=encodeInboxCursor(position,secret,now);
    expect(()=>decodeInboxCursor(token.slice(0,-1)+"A",actorUserId,"novel",false,secret,now)).toThrow();
    expect(()=>decodeInboxCursor(token,actorUserId,"novel",false,otherSecret,now)).toThrow();
    expect(()=>decodeInboxCursor(token+"junk",actorUserId,"novel",false,secret,now)).toThrow();
  });
  it("expires after ten minutes without changing the database cursor",()=>{
    const token=encodeInboxCursor(position,secret,now);
    const within=new Date(now.getTime()+10*60_000);
    const outside=new Date(now.getTime()+10*60_000+1000);
    expect(decodeInboxCursor(token,actorUserId,"novel",false,secret,within)).toEqual(position);
    expect(()=>decodeInboxCursor(token,actorUserId,"novel",false,secret,outside)).toThrow();
  });
  it("rejects insufficiently strong keys and invalid actor/sequence",()=>{
    expect(()=>encodeInboxCursor(position,Buffer.alloc(16),now)).toThrow("32 random bytes");
    expect(()=>encodeInboxCursor({...position,actorUserId:0},secret,now)).toThrow();
    expect(()=>encodeInboxCursor({...position,beforeSequence:BigInt(0)},secret,now)).toThrow();
    expect(()=>decodeInboxCursor("invalid",actorUserId,"novel",false,secret,now)).toThrow();
  });
});
