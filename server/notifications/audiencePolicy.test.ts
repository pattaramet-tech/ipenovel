import { describe, expect, it } from "vitest";
import { isEligibleAudienceRecipient, validateAudiencePage,
  type AudienceRecipientSnapshot } from "./audiencePolicy";
const eventAt=new Date("2026-10-24T00:00:00Z");
const candidate:AudienceRecipientSnapshot={
  userId:7,activeAccount:true,isAuthor:false,preferenceOverride:null,
  preferenceUpdatedAt:null,wishlistActive:true,wishlistCreatedAt:new Date("2026-10-23T00:00:00Z"),
};
describe("Notification audience eligibility",()=>{
  it("requires opt-in for novel catalog fanout",()=>{
    expect(isEligibleAudienceRecipient({kind:"novel_published",eventAt,recipient:candidate})).toBe(false);
    expect(isEligibleAudienceRecipient({kind:"novel_published",eventAt,recipient:{
      ...candidate,preferenceOverride:true,preferenceUpdatedAt:new Date("2026-10-23T00:00:00Z"),
    }})).toBe(true);
  });
  it("refuses late opt-in and current opt-out",()=>{
    expect(isEligibleAudienceRecipient({kind:"novel_published",eventAt,recipient:{
      ...candidate,preferenceOverride:true,preferenceUpdatedAt:new Date("2026-10-25T00:00:00Z"),
    }})).toBe(false);
    expect(isEligibleAudienceRecipient({kind:"wishlist_episodes_published",eventAt,recipient:{
      ...candidate,preferenceOverride:false,
    }})).toBe(false);
  });
  it("fails closed on missing, corrupt or untrusted opt-in provenance",()=>{
    for(const kind of ["novel_published","daily_checkin_reminder"] as const){
      expect(isEligibleAudienceRecipient({kind,eventAt,recipient:{
        ...candidate,preferenceOverride:true,preferenceUpdatedAt:null,
      }})).toBe(false);
      expect(isEligibleAudienceRecipient({kind,eventAt,recipient:{
        ...candidate,preferenceOverride:true,preferenceUpdatedAt:new Date("invalid"),
      }})).toBe(false);
      expect(isEligibleAudienceRecipient({kind,eventAt,recipient:{
        ...candidate,preferenceOverride:true,preferenceUpdatedAt:eventAt,
      }})).toBe(false);
    }
    expect(isEligibleAudienceRecipient({kind:"wishlist_episodes_published",eventAt,recipient:{
      ...candidate,preferenceOverride:"false" as unknown as boolean,
    }})).toBe(false);
  });
  it("fails closed when second-resolution timestamps cannot order an opt-in or follow",()=>{
    // MySQL TIMESTAMP without fractional precision can collapse two writes
    // made within the same second; equality must not imply prior consent.
    const sameSecond=new Date("2026-10-24T00:00:00.900Z");
    const earlierSameSecond=new Date("2026-10-24T00:00:00.100Z");
    expect(isEligibleAudienceRecipient({kind:"novel_published",eventAt:sameSecond,recipient:{
      ...candidate,preferenceOverride:true,preferenceUpdatedAt:earlierSameSecond,
    }})).toBe(true);
    expect(isEligibleAudienceRecipient({kind:"novel_published",eventAt,recipient:{
      ...candidate,preferenceOverride:true,preferenceUpdatedAt:eventAt,
    }})).toBe(false);
    expect(isEligibleAudienceRecipient({kind:"wishlist_episodes_published",eventAt,recipient:{
      ...candidate,wishlistCreatedAt:eventAt,
    }})).toBe(false);
  });
  it("does not backfill default-on categories after an opt-out then late opt-in",()=>{
    for(const kind of ["order_completed","wishlist_episodes_published"] as const){
      expect(isEligibleAudienceRecipient({kind,eventAt,recipient:{
        ...candidate,preferenceOverride:true,
        preferenceUpdatedAt:new Date("2026-10-25T00:00:00Z"),
      }})).toBe(false);
      expect(isEligibleAudienceRecipient({kind,eventAt,recipient:{
        ...candidate,preferenceOverride:true,
        preferenceUpdatedAt:new Date("2026-10-23T00:00:00Z"),
      }})).toBe(true);
    }
  });
  it("does not deliver past wishlist publication to a newly subscribed or unsubscribed user",()=>{
    expect(isEligibleAudienceRecipient({kind:"wishlist_episodes_published",eventAt,recipient:{
      ...candidate,wishlistCreatedAt:new Date("2026-10-25T00:00:00Z"),
    }})).toBe(false);
    expect(isEligibleAudienceRecipient({kind:"wishlist_episodes_published",eventAt,recipient:{
      ...candidate,wishlistActive:false,
    }})).toBe(false);
    expect(isEligibleAudienceRecipient({kind:"wishlist_episodes_published",eventAt,recipient:candidate})).toBe(true);
    expect(isEligibleAudienceRecipient({kind:"wishlist_episodes_published",eventAt,recipient:{
      ...candidate,wishlistCreatedAt:eventAt,
    }})).toBe(false);
  });
  it("excludes authors from catalog digests but not their own financial confirmations",()=>{
    const author={...candidate,isAuthor:true};
    expect(isEligibleAudienceRecipient({kind:"wishlist_episodes_published",eventAt,recipient:author})).toBe(false);
    expect(isEligibleAudienceRecipient({kind:"order_completed",eventAt,recipient:author})).toBe(true);
  });
  it("rejects inactive users and validates mandatory audience identity",()=>{
    expect(isEligibleAudienceRecipient({kind:"order_completed",eventAt,recipient:{
      ...candidate,activeAccount:false,
    }})).toBe(false);
    expect(()=>isEligibleAudienceRecipient({kind:"order_completed",eventAt,recipient:{
      ...candidate,userId:-1,
    }})).toThrow();
  });
});
describe("Bounded keyset page contracts",()=>{
  it("requires increasing user IDs and a progressing cursor",()=>{
    const page={cursorUserId:2,recipients:[{...candidate,userId:3},{...candidate,userId:4}],
      nextCursorUserId:4};
    expect(()=>validateAudiencePage(page,2)).not.toThrow();
    expect(()=>validateAudiencePage({...page,recipients:[{...candidate,userId:4},{...candidate,userId:3}]},2)).toThrow();
    expect(()=>validateAudiencePage({...page,nextCursorUserId:2},2)).toThrow();
    expect(()=>validateAudiencePage(page,1)).toThrow();
  });
});
