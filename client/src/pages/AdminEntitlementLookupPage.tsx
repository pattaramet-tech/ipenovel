import AdminLayout from "@/components/AdminLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import { Search, Loader2, Copy } from "lucide-react";

const ACTION_LABELS: Record<string, string> = {
  read_web: "อ่านในเว็บ",
  open_legacy_file: "เปิดไฟล์เดิม",
  both: "อ่านในเว็บ + เปิดไฟล์เดิม",
  no_content_available: "ซื้อแล้วแต่ยังไม่มีเนื้อหาให้อ่าน",
  no_access: "ไม่มีสิทธิ์",
};

/**
 * Phase 1 - Admin User Entitlement Lookup. Strictly read-only: no button on
 * this page ever changes a user's entitlement (use /admin/entitlements for
 * the existing repair tool). fileUrl itself is never shown - only whether
 * one exists (hasLegacyFile) and whether this user's session would be
 * granted it (fileUrlVisible), per the "never expose fileUrl to admins
 * without cause" rule.
 */
export default function AdminEntitlementLookupPage() {
  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState("");
  const [orderId, setOrderId] = useState("");
  const [searchInput, setSearchInput] = useState<{ email?: string; userId?: number; orderId?: number } | null>(null);

  const { data: result, isLoading } = trpc.admin.entitlementLookup.search.useQuery(searchInput as any, {
    enabled: searchInput !== null,
  });

  const handleSearch = () => {
    const input: { email?: string; userId?: number; orderId?: number } = {};
    if (email.trim()) input.email = email.trim();
    if (userId.trim()) input.userId = parseInt(userId, 10);
    if (orderId.trim()) input.orderId = parseInt(orderId, 10);

    if (!input.email && !input.userId && !input.orderId) {
      toast.error("กรุณาระบุ email, userId หรือ orderId อย่างน้อยหนึ่งอย่าง");
      return;
    }
    setSearchInput(input);
  };

  const copyDebugReport = (ep: any) => {
    const lines = [
      `userId: ${result && "userId" in result ? result.userId : ""}`,
      `novelId: ${ep.novelId}`,
      `episodeId: ${ep.episodeId}`,
      `canRead: ${ep.canRead}`,
      `hasContent: ${ep.hasContent}`,
      `hasLegacyFile: ${ep.hasLegacyFile}`,
      `fileUrlVisible: ${ep.fileUrlVisible}`,
      `progress: ${ep.progress ? `${ep.progress.progressPercent}% (chapter: ${ep.progress.currentChapterNumber ?? "-"}, lastReadAt: ${new Date(ep.progress.lastReadAt).toISOString()})` : "ไม่มีข้อมูล progress"}`,
    ];
    navigator.clipboard.writeText(lines.join("\n"));
    toast.success("คัดลอก debug report แล้ว");
  };

  return (
    <AdminLayout>
      <div className="space-y-4">
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-1">Admin User Entitlement Lookup</h2>
          <p className="text-xs text-muted-foreground mb-4">
            ค้นหาว่า user คนนี้อ่านอะไรได้บ้าง - read-only เท่านั้น ไม่มีปุ่มแก้ไขสิทธิ์ในหน้านี้
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Input
              placeholder="ค้นหาด้วย email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            />
            <Input
              type="number"
              placeholder="ค้นหาด้วย userId"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            />
            <Input
              type="number"
              placeholder="ค้นหาด้วย orderId"
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            />
          </div>
          <Button onClick={handleSearch} disabled={isLoading} className="mt-3">
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                กำลังค้นหา...
              </>
            ) : (
              <>
                <Search className="w-4 h-4 mr-2" />
                ค้นหา
              </>
            )}
          </Button>
        </Card>

        {result && "matched" in result && !result.matched && (
          <Card className="p-6">
            {result.reason === "not_found" ? (
              <p className="text-muted-foreground">ไม่พบ user ที่ตรงกับเงื่อนไขที่ค้นหา</p>
            ) : (
              <div>
                <p className="font-medium mb-2">พบ user มากกว่า 1 รายการ กรุณาระบุให้เจาะจงขึ้น (เช่นใช้ userId แทน):</p>
                <div className="space-y-1">
                  {result.candidates.map((c: any) => (
                    <button
                      key={c.userId}
                      onClick={() => {
                        setUserId(String(c.userId));
                        setSearchInput({ userId: c.userId });
                      }}
                      className="block text-sm text-blue-600 hover:underline"
                    >
                      #{c.userId} - {c.email} ({c.name})
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Card>
        )}

        {result && "matched" in result && result.matched && (
          <>
            <Card className="p-6">
              <h3 className="font-semibold mb-2">User</h3>
              <div className="text-sm space-y-1">
                <p><span className="font-semibold">userId:</span> {result.userId}</p>
                <p><span className="font-semibold">email:</span> {result.email ?? "-"}</p>
                <p><span className="font-semibold">name:</span> {result.name ?? "-"}</p>
              </div>

              <h4 className="font-semibold mt-4 mb-2">Orders ({result.orders.length})</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-slate-50">
                      <th className="text-left py-2 px-2">orderId</th>
                      <th className="text-left py-2 px-2">orderNumber</th>
                      <th className="text-left py-2 px-2">status</th>
                      <th className="text-left py-2 px-2">paymentStatus</th>
                      <th className="text-left py-2 px-2">totalAmount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.orders.map((o: any) => (
                      <tr key={o.orderId} className="border-b hover:bg-slate-50">
                        <td className="py-2 px-2">{o.orderId}</td>
                        <td className="py-2 px-2">{o.orderNumber}</td>
                        <td className="py-2 px-2">{o.status}</td>
                        <td className="py-2 px-2">{o.paymentStatus}</td>
                        <td className="py-2 px-2">฿{o.totalAmount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.orders.length === 0 && <p className="text-muted-foreground text-sm py-2">ไม่มี order</p>}
              </div>
            </Card>

            <Card className="p-6">
              <h3 className="font-semibold mb-3">Purchased Episodes ({result.purchasedEpisodes.length})</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-slate-50">
                      <th className="text-left py-2 px-2">Novel</th>
                      <th className="text-left py-2 px-2">episodeId</th>
                      <th className="text-left py-2 px-2">episodeNumber</th>
                      <th className="text-left py-2 px-2">Title</th>
                      <th className="text-left py-2 px-2">saleMode</th>
                      <th className="text-left py-2 px-2">hasContent</th>
                      <th className="text-left py-2 px-2">hasLegacyFile</th>
                      <th className="text-left py-2 px-2">Action ที่มองเห็น</th>
                      <th className="text-left py-2 px-2">Progress</th>
                      <th className="text-left py-2 px-2">lastReadAt</th>
                      <th className="text-left py-2 px-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.purchasedEpisodes.map((ep: any) => (
                      <tr key={ep.episodeId} className="border-b hover:bg-slate-50">
                        <td className="py-2 px-2">{ep.novelTitle}</td>
                        <td className="py-2 px-2 text-muted-foreground">{ep.episodeId}</td>
                        <td className="py-2 px-2 font-medium">{ep.episodeNumber}</td>
                        <td className="py-2 px-2">{ep.episodeTitle}</td>
                        <td className="py-2 px-2">{ep.saleMode}</td>
                        <td className="py-2 px-2">{ep.hasContent ? "✓" : "-"}</td>
                        <td className="py-2 px-2">
                          {ep.hasLegacyFile ? (
                            <Badge className="bg-amber-100 text-amber-800" title="sensitive: มีไฟล์เดิมอยู่ แต่ระบบไม่แสดง URL เต็มที่นี่">
                              มีไฟล์ (sensitive)
                            </Badge>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td className="py-2 px-2">{ACTION_LABELS[ep.visibleAction] ?? ep.visibleAction}</td>
                        <td className="py-2 px-2">{ep.progress ? `${ep.progress.progressPercent}%` : "-"}</td>
                        <td className="py-2 px-2">{ep.progress ? new Date(ep.progress.lastReadAt).toLocaleString("th-TH") : "-"}</td>
                        <td className="py-2 px-2">
                          <Button variant="ghost" size="sm" onClick={() => copyDebugReport(ep)} title="Copy debug report">
                            <Copy className="w-3.5 h-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.purchasedEpisodes.length === 0 && (
                  <p className="text-muted-foreground text-sm py-4">user นี้ยังไม่มีการซื้อตอน/แพ็กใด ๆ</p>
                )}
              </div>
            </Card>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
