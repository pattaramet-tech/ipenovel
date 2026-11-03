import {describe,expect,it} from "vitest";
import {
  DEFAULT_NOTIFICATION_RETENTION,resolveNotificationSwitches,
  mayCaptureNotification,mayProcessNotificationWorker,validateNotificationRetention,
} from "./operationsPolicy";
describe("fail-closed Notification kill switches",()=>{
  it("defaults all capture/delivery/UI and optional fanout disabled",()=>{
    const s=resolveNotificationSwitches({});
    expect(Object.values(s).every(v=>v===false)).toBe(true);
    expect(mayCaptureNotification("wallet_topup_approved",s)).toBe(false);
    expect(mayProcessNotificationWorker(s)).toBe(false);
  });
  it("does not accept accidental truthy env values",()=>{
    for(const value of ["1","yes","TRUE","false ","on"]){
      expect(resolveNotificationSwitches({NOTIFICATIONS_ENABLED:value}).producerEnabled).toBe(false);
    }
  });
  it("separates catalog and check-in from transactional notifications",()=>{
    const s=resolveNotificationSwitches({NOTIFICATIONS_ENABLED:"true"});
    expect(mayCaptureNotification("order_completed",s)).toBe(true);
    expect(mayCaptureNotification("wishlist_episodes_published",s)).toBe(false);
    expect(mayCaptureNotification("daily_checkin_reminder",s)).toBe(false);
    const next=resolveNotificationSwitches({
      NOTIFICATIONS_ENABLED:"true",NOTIFICATIONS_CATALOG_FANOUT_ENABLED:"true",
      NOTIFICATIONS_CHECKIN_REMINDERS_ENABLED:"true",
    });
    expect(mayCaptureNotification("novel_published",next)).toBe(true);
    expect(mayCaptureNotification("daily_checkin_reminder",next)).toBe(true);
    expect(mayProcessNotificationWorker(next)).toBe(false);
  });
});
describe("retention versus replay protection",()=>{
  it("defaults to no dead-letter data loss",()=>{
    expect(()=>validateNotificationRetention(DEFAULT_NOTIFICATION_RETENTION)).not.toThrow();
    expect(DEFAULT_NOTIFICATION_RETENTION.failedAndDeadLetterRetained).toBe(true);
  });
  it("rejects tombstones shorter than replay horizon or premature outbox cleanup",()=>{
    expect(()=>validateNotificationRetention({...DEFAULT_NOTIFICATION_RETENTION,tombstoneDays:20})).toThrow();
    expect(()=>validateNotificationRetention({...DEFAULT_NOTIFICATION_RETENTION,replayDedupeDays:10})).toThrow();
    expect(()=>validateNotificationRetention({...DEFAULT_NOTIFICATION_RETENTION,failedAndDeadLetterRetained:false})).toThrow();
  });
});
