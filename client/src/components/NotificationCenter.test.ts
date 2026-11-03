import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationCenter, filterNotifications, safeNotificationItems, unreadBadgeText } from "./NotificationCenter";
const items = [
  {id:"a",category:"finance" as const,title:"เติมเงินสำเร็จ",summary:"เติมเงิน",createdAt:"2026-10-24T00:00:00Z",readAt:null},
  {id:"b",category:"novel" as const,title:"ตอนใหม่",summary:"นิยาย",createdAt:"2026-10-24T00:02:00Z",readAt:"2026-10-24T00:03:00Z"},
];
const handlers = {
  open:false,onOpenChange:(_value:boolean)=>{},items,unreadCount:null,
  activeFilter:"all" as const,onFilterChange:(_next:"all"|"finance"|"novel"|"engagement")=>{},
  hasMore:false,loadingMore:false,onLoadMore:async()=>{},
  loading:true,loadError:null,onRefresh:async()=>{},onMarkRead:async(_id:string)=>{},
  onMarkAllRead:async()=>{},onDeleteAll:async()=>{},onOpenItem:async(_id:string)=>{},
};
describe("NotificationCenter presentation contract",()=>{
  it("does not render a fake zero from unknown count",()=>{
    expect(unreadBadgeText(null)).toBeNull();
    expect(unreadBadgeText(0)).toBeNull();
    expect(unreadBadgeText(5)).toBe("5");
    expect(unreadBadgeText(123)).toBe("99+");
  });
  it("filters the caller-provided account list without mutating it",()=>{
    expect(filterNotifications(items,"all")).toHaveLength(2);
    expect(filterNotifications(items,"finance").map(x=>x.id)).toEqual(["a"]);
    expect(filterNotifications(items,"engagement")).toEqual([]);
    expect(items).toHaveLength(2);
  });
  it("hides stale notification rows when authenticated list fetch fails",()=>{
    expect(safeNotificationItems(items,"failed to fetch")).toEqual([]);
    expect(safeNotificationItems(items,null)).toBe(items);
  });
  it("renders an accessible mobile/desktop-compatible bell",()=>{
    const html=renderToStaticMarkup(createElement(NotificationCenter,handlers));
    expect(html).toContain("aria-haspopup=\"dialog\"");
    expect(html).toContain("เปิดการแจ้งเตือน");
    expect(html).not.toContain("99+");
  });
  it("caps display badge, not underlying count",()=>{
    const html=renderToStaticMarkup(createElement(NotificationCenter,{...handlers,unreadCount:120}));
    expect(html).toContain("99+");
    expect(html).toContain("120 รายการยังไม่อ่าน");
  });
});
