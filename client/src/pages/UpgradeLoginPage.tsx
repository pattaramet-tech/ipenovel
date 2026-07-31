import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AlertTriangle, BookOpen, Wallet, Clock, Heart, Loader2, XCircle } from "lucide-react";
import { resolveSupportUrl, resolveUpgradeLoginPageAction } from "./upgradeLoginPresentation";
import { parseGoogleConnectStatus } from "./profileGoogleConnectStatus";

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
  const { user, loading: authLoading, logout } = useAuth();
  const [, navigate] = useLocation();
  const isAuthenticated = Boolean(user);

  // Captured ONCE at mount (lazy initializer, never re-derived from a
  // later URL read) - this is the server's one-shot signal
  // (server/_core/googleOAuth.ts's resolveConnectCallbackDestination) that
  // a just-attempted Google connect failed while the mandatory gate was
  // active. Kept in state (not re-read from window.location on every
  // render) specifically so the query-param cleanup effect below can strip
  // it from the URL without also making the error banner disappear -
  // "ต้องไม่ลบก่อนที่ Error UI จะถูกแสดง".
  const [connectErrorRequested] = useState(
    () => typeof window !== "undefined" && parseGoogleConnectStatus(window.location.search) === "error"
  );

  useEffect(() => {
    if (connectErrorRequested) {
      navigate("/account/upgrade-login", { replace: true });
    }
    // Deliberately empty deps beyond the captured-at-mount value itself -
    // this must run at most once, right after the error banner has already
    // rendered from the state above, never before.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectErrorRequested]);

  // Never fires at all while anonymous - there is no Google-connection
  // status to ask about without a session, and firing it anyway would just
  // produce a confusing UNAUTHORIZED error masquerading as "not connected".
  // Same server-authoritative status query <MigrationGate> uses (see
  // client/src/_core/hooks/migrationGate.ts's top-of-file docstring) - this
  // page additionally reads `exempt` so an admin who navigates here
  // directly (never server-forced, but nothing stops manual navigation) is
  // sent home immediately too, same as an already-connected user.
  const statusQuery = trpc.auth.googleConnectionCutoffStatus.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  const action = resolveUpgradeLoginPageAction({
    authLoading,
    isAuthenticated,
    connectErrorRequested,
    googleConnectedLoading: isAuthenticated && statusQuery.isLoading,
    googleConnectedError: isAuthenticated && statusQuery.isError,
    googleConnected: statusQuery.data?.googleConnected,
    exempt: statusQuery.data?.exempt,
  });

  // Anonymous visitor (no session at all, or it expired while this page was
  // open) -> back to /login, never an infinite spinner. replace: true so
  // the browser's back button doesn't return here and loop.
  useEffect(() => {
    if (action === "redirect_login") {
      navigate("/login", { replace: true });
    }
  }, [action, navigate]);

  // Self-correcting: if this user turns out to already be connected (a
  // stale bookmark, browser back button, another tab having just
  // connected), leave immediately rather than showing a stale "please
  // connect" screen - "ปลด Gate" + "Redirect กลับหน้าแรก" without requiring
  // any special-case navigation from the connect flow itself, since the
  // server's callback already lands the browser on /profile (see
  // server/_core/googleOAuth.ts's ACCOUNT_PAGE_PATH - reused unmodified),
  // a page this same self-correction logic keeps unlocked.
  useEffect(() => {
    if (action === "redirect_home") {
      navigate("/", { replace: true });
    }
  }, [action, navigate]);

  if (action === "loading" || action === "redirect_login" || action === "redirect_home") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" aria-hidden="true" />
      </div>
    );
  }

  if (action === "render_connect_error") {
    // The connect ATTEMPT itself failed (server redirect with
    // ?googleConnect=error) - distinct from render_error below, which is
    // about the auth.googleConnected STATUS QUERY failing. Never shows the
    // internal conflict outcome, Google sub, user id, another account's
    // email, a raw error, an OAuth code/token, or a database error - the
    // server never sent any of that in the redirect, and this page has no
    // other source to leak it from.
    const supportUrl = resolveSupportUrl(import.meta.env.VITE_SUPPORT_URL);
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
        <Card className="w-full max-w-md p-8 text-center">
          <XCircle className="w-10 h-10 text-red-500 mx-auto mb-4" aria-hidden="true" />
          <h1 className="text-xl font-bold text-slate-900 mb-2">เชื่อมบัญชี Google ไม่สำเร็จ</h1>
          <p className="text-sm text-slate-600 leading-relaxed mb-6">
            ไม่สามารถเชื่อมบัญชี Google ได้ กรุณาลองใหม่อีกครั้ง หรือติดต่อฝ่ายช่วยเหลือ
          </p>
          <div className="flex flex-col gap-3">
            <Button asChild size="lg" className="w-full">
              <a href="/api/auth/google/connect/start">ลองเชื่อมบัญชี Google อีกครั้ง</a>
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

  if (action === "render_error") {
    const supportUrl = resolveSupportUrl(import.meta.env.VITE_SUPPORT_URL);
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
        <Card className="w-full max-w-md p-8 text-center">
          <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-4" aria-hidden="true" />
          <h1 className="text-xl font-bold text-slate-900 mb-2">ไม่สามารถตรวจสอบสถานะบัญชีได้</h1>
          <p className="text-sm text-slate-600 leading-relaxed mb-6">
            เกิดข้อผิดพลาดชั่วคราว กรุณาลองใหม่อีกครั้ง หากยังไม่สำเร็จ กรุณาติดต่อฝ่ายช่วยเหลือ
          </p>
          <div className="flex flex-col gap-3">
            <Button size="lg" className="w-full" onClick={() => statusQuery.refetch()}>
              ลองใหม่
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
