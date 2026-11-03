import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationPreferences, effectivePreference } from "./NotificationPreferences";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_KINDS,
  NOTIFICATION_PREFERENCE_DESCRIPTIONS,
} from "@shared/notificationKindCatalog";

const common={
  isLoading:false,error:null,onUpdate:async()=>{},onReload:async()=>{},
};
describe("Notifications account preference UI",()=>{
  it("has exactly the seven public event kinds with Thai descriptions",()=>{
    expect(NOTIFICATION_KINDS).toHaveLength(7);
    for(const kind of NOTIFICATION_KINDS){
      expect(NOTIFICATION_PREFERENCE_DESCRIPTIONS[kind].label.length).toBeGreaterThan(0);
      expect(NOTIFICATION_PREFERENCE_DESCRIPTIONS[kind].description.length).toBeGreaterThan(0);
    }
  });
  it("does not treat unknown authenticated preferences as all disabled",()=>{
    expect(effectivePreference(null,"wallet_topup_approved")).toBeNull();
    expect(effectivePreference({}, "wallet_topup_approved")).toBe(true);
    expect(effectivePreference({}, "novel_published")).toBe(false);
    expect(effectivePreference({wishlist_episodes_published:false},"wishlist_episodes_published")).toBe(false);
  });
  it("renders accessible settings with no invented state",()=>{
    const html=renderToStaticMarkup(createElement(NotificationPreferences,{...common,values:null,isLoading:true}));
    expect(html).toContain("notification-preferences-title");
    expect(html).toContain("disabled");
    expect(html).toContain("กำลังโหลดการตั้งค่า");
  });
  it("renders all kinds based on canonical server/client metadata",()=>{
    const html=renderToStaticMarkup(createElement(NotificationPreferences,{...common,values:{}}));
    for(const kind of NOTIFICATION_KINDS){
      expect(html).toContain(`name="${kind}"`);
    }
    expect(html).toContain("checked");
    expect(DEFAULT_NOTIFICATION_PREFERENCES.daily_checkin_reminder).toBe(false);
  });
});
