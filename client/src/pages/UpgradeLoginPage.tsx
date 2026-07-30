import { useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BookOpen, Wallet, Clock, Heart, Loader2 } from "lucide-react";
import { resolveSupportUrl } from "./upgradeLoginPresentation";

// The mandatory-migration counterpart to /login's optional Google-connect
// flow (see App.tsx's <MigrationGate>, which is what actually routes a
// signed-in, not-yet-connected user here when AUTH_PROVIDER=transition AND
// VITE_AUTH_REQUIRE_GOOGLE_CONNECTION="true"). This page itself never
// enforces anything - MigrationGate (client-side UX) and
// server/_core/googleMigrationGate.ts (the real, server-side boundary) both
// already decided the user belongs here before this component ever
// mounts. This page's only job is explaining why, and offering exactly the
// three sanctioned ways out: connect Google, log out, or reach support -
// never a "skip for now" escape hatch.
export default function UpgradeLoginPage() {
  const { user, loading, logout } = useAuth();
  const [, navigate] = useLocation();

  const googleConnectedQuery = trpc.auth.googleConnected.useQuery(undefined, {
    enabled: !!user,
  });

  // Self-correcting: if this user turns out to already be connected (a
  // stale bookmark, browser back button, another tab having just
  // connected), leave immediately rather than showing a stale "please
  // connect" screen - "ปลด Gate" + "Redirect กลับหน้าแรก" without requiring
  // any special-case navigation from the connect flow itself, since the
  // server's callback already lands the browser on /profile (see
  // server/_core/googleOAuth.ts's ACCOUNT_PAGE_PATH - reused unmodified),
  // a page this same self-correction logic keeps unlocked.
  useEffect(() => {
    if (googleConnectedQuery.data?.googleConnected) {
      navigate("/", { replace: true });
    }
  }, [googleConnectedQuery.data?.googleConnected, navigate]);

  if (loading || !user || googleConnectedQuery.data?.googleConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" aria-hidden="true" />
      </div>
    );
  }

  const supportUrl = resolveSupportUrl(import.meta.env.VITE_SUPPORT_URL);

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
      <Card className="w-full max-w-lg p-8">
        <h1 className="text-2xl font-bold text-slate-900 text-center mb-3">อัปเกรดวิธีเข้าสู่ระบบ</h1>
        <p className="text-sm text-slate-600 text-center leading-relaxed mb-6">
          เพื่อให้คุณสามารถเข้าใช้งานบัญชีเดิมได้อย่างต่อเนื่อง กรุณาเชื่อมบัญชี Google กับบัญชี IpeNovel ของคุณ
        </p>

        <div className="bg-blue-50 rounded-lg p-4 mb-6 space-y-2.5">
          <div className="flex items-center gap-3 text-sm text-slate-700">
            <BookOpen className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
            <span>บัญชีเดิมและชั้นหนังสือของคุณยังคงอยู่ครบถ้วน</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-700">
            <Wallet className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
            <span>ยอดคงเหลือในกระเป๋ายังอยู่เหมือนเดิม</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-700">
            <Clock className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
            <span>ประวัติการซื้อยังอยู่ครบถ้วน</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-700">
            <Heart className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
            <span>Wishlist ยังอยู่เหมือนเดิม</span>
          </div>
        </div>

        <p className="text-xs text-slate-500 leading-relaxed mb-6">
          หากคุณเคยเข้าสู่ระบบด้วย Apple และใช้ฟีเจอร์ Hide My Email ไม่จำเป็นต้องใช้อีเมลเดียวกับบัญชี Google ของคุณ
          ระบบจะเชื่อมบัญชี Google เข้ากับบัญชีที่คุณกำลังเข้าสู่ระบบอยู่ในขณะนี้โดยตรง
        </p>

        <div className="flex flex-col gap-3">
          <Button asChild size="lg" className="w-full">
            <a href="/api/auth/google/connect/start">เชื่อมบัญชี Google</a>
          </Button>
          <Button variant="outline" size="lg" className="w-full" onClick={() => logout()}>
            ออกจากระบบ
          </Button>
          {supportUrl && (
            <Button asChild variant="ghost" size="sm" className="w-full">
              <a href={supportUrl} target="_blank" rel="noopener noreferrer">
                ติดต่อฝ่ายช่วยเหลือ
              </a>
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
