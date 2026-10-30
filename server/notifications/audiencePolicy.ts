import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationKind } from "@shared/notificationKindCatalog";

/**
 * A DB audience page MUST already be scoped to one immutable event's
 * publication time, a bounded keyset userId page and current subscription
 * state. The policy below is defense in depth; it is not a full DB query.
 */
export interface AudienceRecipientSnapshot {
  userId:number;
  activeAccount:boolean;
  isAuthor:boolean;
  preferenceOverride:boolean|null;
  /** When an override was first committed; null means using defaults. */
  preferenceUpdatedAt:Date|null;
  /** Only wishlist publications require an active, pre-existing follow. */
  wishlistActive:boolean;
  wishlistCreatedAt:Date|null;
}

/** Revalidate preference eligibility after acquiring the delivery sequence lock. */
export function isEligibleNotificationPreference(
  kind:NotificationKind,eventAt:Date,override:boolean|null,updatedAt:Date|null,
):boolean {
  if(!(eventAt instanceof Date)||Number.isNaN(eventAt.getTime()))return false;
  if(override!==null&&typeof override!=="boolean")return false;
  if(override===false)return false;
  if(override===null)return DEFAULT_NOTIFICATION_PREFERENCES[kind];
  // Strictly earlier: second-resolution MySQL timestamps can make a late
  // opt-in appear equal to the event time. Ambiguous ties fail closed.
  return updatedAt instanceof Date&&!Number.isNaN(updatedAt.getTime())&&
    updatedAt.getTime()<eventAt.getTime();
}

export function isEligibleAudienceRecipient(input:{
  kind:NotificationKind;
  eventAt:Date;
  recipient:AudienceRecipientSnapshot;
}):boolean {
  const {kind,eventAt,recipient:r}=input;
  if(Number.isNaN(eventAt.getTime())||!Number.isSafeInteger(r.userId)||r.userId<1) {
    throw Error("Invalid notification audience identity");
  }
  if(!r.activeAccount)return false;
  if((kind==="novel_published"||kind==="wishlist_episodes_published")&&r.isAuthor)return false;
  // Live opt-out always wins, including a change made after audience paging.
  // A later opt-in cannot resurrect an older event on a delayed retry.
  if(!isEligibleNotificationPreference(kind,eventAt,r.preferenceOverride,r.preferenceUpdatedAt))return false;
  if(kind==="wishlist_episodes_published") {
    if(!r.wishlistActive||!r.wishlistCreatedAt ||
        Number.isNaN(r.wishlistCreatedAt.getTime()) ||
        r.wishlistCreatedAt.getTime()>=eventAt.getTime())return false;
  }
  return true;
}

export interface AudiencePageContract {
  /** Underlying DB query is (event_id, userId > cursor), limit <= 100. */
  cursorUserId:number|null;
  recipients:AudienceRecipientSnapshot[];
  nextCursorUserId:number|null;
}

/** Refuse DB rows that could cause an unbounded or nonprogressing fanout. */
export function validateAudiencePage(page:AudiencePageContract,limit:number):void{
  if(!Number.isSafeInteger(limit)||limit<1||limit>100 ||
      page.recipients.length>limit)throw Error("Invalid audience bound");
  const previous=page.cursorUserId??0;
  if(previous!==0&&(!Number.isSafeInteger(previous)||previous<1))throw Error("Invalid audience cursor");
  let current=previous;
  for(const row of page.recipients){
    if(!Number.isSafeInteger(row.userId)||row.userId<=current)throw Error("Non-increasing audience page");
    current=row.userId;
  }
  if(page.nextCursorUserId!==null &&
      (!Number.isSafeInteger(page.nextCursorUserId) ||
       page.nextCursorUserId<=previous ||
       page.nextCursorUserId!==current ||
       page.recipients.length!==limit))throw Error("Invalid next audience cursor");
}
