import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { LogOut, MoveRight, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";

type SessionRow = {
  id: number;
  status: "active" | "pending_choice" | "unslotted_legacy" | "revoked" | "superseded";
  loginAt: string | Date;
  lastSeenAt: string | Date | null;
  clientLabel: string | null;
  createdVia: string;
  current: boolean;
};

function fmt(value: string | Date | null): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleString("th-TH");
}

/**
 * R2 Current logins: the account owner lists and revokes their own sessions,
 * and resolves a pending third login by choosing which standing session to
 * sign out ("ย้ายมาอ่านที่นี่" is the reader-side transfer; this page is the
 * session-side chooser).
 */
export default function CurrentLoginsPage() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const [revokingId, setRevokingId] = useState<number | null>(null);

  const sessionsQuery = trpc.auth.sessions.list.useQuery(undefined, {
    enabled: !!user,
    refetchOnWindowFocus: true,
  });

  const revokeMutation = trpc.auth.sessions.revoke.useMutation({
    onSuccess: async result => {
      if (result.success) toast.success("ออกจาก session ที่เลือกแล้ว");
      await utils.auth.sessions.list.invalidate();
    },
    onError: error => toast.error(error.message || "ยกเลิก session ไม่สำเร็จ"),
    onSettled: () => setRevokingId(null),
  });

  const resolveMutation = trpc.auth.sessions.resolveThirdLogin.useMutation({
    onSuccess: async () => {
      toast.success("ยืนยันแล้ว — session นี้พร้อมใช้งาน");
      await utils.auth.me.invalidate();
      await utils.auth.sessions.list.invalidate();
      setLocation("/");
    },
    onError: error => toast.error(error.message || "ยืนยันไม่สำเร็จ — กรุณาเข้าสู่ระบบใหม่"),
  });

  if (authLoading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-muted-foreground">กำลังโหลด…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-muted-foreground">กรุณาเข้าสู่ระบบก่อนจัดการ session</p>
      </div>
    );
  }

  const enabled = sessionsQuery.data?.readerSessionControls ?? false;
  const rows = (sessionsQuery.data?.sessions ?? []) as SessionRow[];
  // R4/D: the chooser banner belongs to THIS browser's own pending login
  // only — another device's pending chooser must never render resolution
  // controls here (its resolution happens on ITS session).
  const pending = rows.find(row => row.status === "pending_choice" && row.current);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ShieldCheck className="h-6 w-6" /> Current logins
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          บัญชีนี้ค้างได้สูงสุด 2 browser-profile sessions — อ่านเนื้อหาตอนเสียเงินออนไลน์พร้อมกันได้ 1 session
        </p>
      </div>

      {!enabled && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            ระบบจำกัด session ยังไม่เปิดใช้งานสำหรับบัญชีนี้
          </CardContent>
        </Card>
      )}

      {enabled && pending && (
        <Card className="border-amber-500 bg-amber-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">การเข้าสู่ระบบนี้ยังไม่ถือสิทธิ์ใช้งาน</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm">
              บัญชีมี session ครบ 2 แล้ว — เลือก session เดิมที่ต้องการออก เพื่อยืนยันใช้งาน session นี้
              (session ที่เลือกจะออกทันที)
            </p>
            {rows
              .filter(row => row.status === "active")
              .map(row => (
                <Button
                  key={row.id}
                  variant="outline"
                  size="sm"
                  data-testid={`displace-session-${row.id}`}
                  disabled={resolveMutation.isPending}
                  onClick={() => resolveMutation.mutate({ displaceSessionId: row.id })}
                >
                  <MoveRight className="mr-1 h-4 w-4" /> ออกจาก “{row.clientLabel || "อุปกรณ์ไม่ทราบชื่อ"}” และใช้ต่อที่นี่
                </Button>
              ))}
          </CardContent>
        </Card>
      )}

      <div className="space-y-3" data-testid="current-logins-list">
        {rows.map(row => (
          <Card key={row.id} className={row.status === "pending_choice" ? "border-amber-500" : undefined}>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="space-y-1">
                <p className="font-medium">
                  {row.clientLabel || "อุปกรณ์ไม่ทราบชื่อ"}{" "}
                  {row.current && (
                    <span className="ml-1 rounded bg-green-600/15 px-2 py-0.5 text-xs text-green-700 dark:text-green-400">
                      session นี้
                    </span>
                  )}
                  {row.status === "pending_choice" && (
                    <span className="ml-1 rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                      รอยืนยัน
                    </span>
                  )}
                  {row.status === "unslotted_legacy" && (
                    <span className="ml-1 rounded bg-slate-500/15 px-2 py-0.5 text-xs text-slate-600 dark:text-slate-300">
                      เกินโควตา — สิทธิ์อ่านจำกัด
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  เข้าสู่ระบบ {fmt(row.loginAt)} · ใช้ล่าสุด {fmt(row.lastSeenAt)} · ผ่าน {row.createdVia}
                </p>
              </div>
              {!row.current && row.status !== "revoked" && row.status !== "superseded" && (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid={`revoke-session-${row.id}`}
                  disabled={revokingId === row.id}
                  onClick={() => {
                    setRevokingId(row.id);
                    revokeMutation.mutate({ sessionId: row.id });
                  }}
                >
                  <LogOut className="mr-1 h-4 w-4" /> ออกจาก session นี้
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
        {rows.length === 0 && (
          <p className="text-sm text-muted-foreground">ไม่มี session ที่ใช้งานอยู่</p>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        <MoveRight className="mr-1 inline h-3 w-3" />
        หากเปิดหน้าอ่านตอนเสียเงินแล้วพบข้อความ “กำลังอ่านอยู่ที่อุปกรณ์อื่น” ให้กด “ย้ายมาอ่านที่นี่” ที่หน้าอ่านเพื่อย้ายสิทธิ์การอ่าน
      </p>
    </div>
  );
}
