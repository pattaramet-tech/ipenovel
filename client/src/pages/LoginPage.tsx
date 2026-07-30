import { useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { buildManusLoginUrl, GOOGLE_LOGIN_START_PATH } from "@/const";
import { isMandatoryGoogleConnectionEnabled } from "@/_core/hooks/migrationGate";

// In-app login page for AUTH_PROVIDER=transition (VITE_AUTH_PROVIDER=
// "transition" - see client/src/const.ts's resolveLoginUrl, which is the
// only thing that ever routes a user here: getLoginUrl() and every
// existing "Sign in" button across the site already point at
// getLoginUrl(), so nothing else needed to change for those call sites to
// land here automatically). Built entirely from this app's existing
// design system (Card/Button) - no separate visual identity from the rest
// of the site.
//
// This page never generates state/nonce/PKCE itself - the "Sign in with
// Google" button is a plain link to the server route
// (server/_core/googleOAuth.ts's /api/auth/google/start), which is where
// all of that is generated, cookied, and redirected from. The "sign in
// the old way" button is the exact same Manus authorization URL
// getLoginUrl() itself would have returned before this flag existed
// (appId, redirectUri, state, type=signIn all identical - see
// buildManusLoginUrl in const.ts, the same pure function this page and
// resolveLoginUrl's "manus" branch both call).
//
// Admin login (/admin/login) is a completely separate page/component and
// never renders through here, never links here, and is untouched by this
// file.
export default function LoginPage() {
  const { user, loading } = useAuth();
  const [, navigate] = useLocation();

  // A visitor who is already signed in has no reason to see a login page -
  // send them home instead. Never redirects an UNAUTHENTICATED visitor
  // away (useAuth() is called here without redirectOnUnauthenticated,
  // which defaults to false) - this page IS the destination for that case.
  useEffect(() => {
    if (!loading && user) {
      navigate("/", { replace: true });
    }
  }, [loading, user, navigate]);

  if (loading || user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" aria-hidden="true" />
      </div>
    );
  }

  const manusLoginUrl = buildManusLoginUrl({
    oauthPortalUrl: import.meta.env.VITE_OAUTH_PORTAL_URL,
    appId: import.meta.env.VITE_APP_ID,
    redirectUri: `${window.location.origin}/api/oauth/callback`,
  });

  // During the mandatory-migration window (AUTH_PROVIDER=transition AND
  // VITE_AUTH_REQUIRE_GOOGLE_CONNECTION="true" - same exact-literal check
  // App.tsx's <MigrationGate> uses), the old-way login button is promoted
  // to primary and its copy explicitly steers existing members - especially
  // anyone who signed in via Apple's Hide My Email, who would otherwise
  // reasonably assume the Google button is "their" button - toward signing
  // in the old way FIRST so their existing account gets Google linked to
  // it, rather than accidentally creating a second, empty account via a
  // fresh Google sign-in. When the flag is off, this page is unchanged from
  // PR #26's original transition-mode UI (Google primary, old-way
  // secondary, generic "connect later from your account page" copy).
  const mandatoryConnection = isMandatoryGoogleConnectionEnabled(
    import.meta.env.VITE_AUTH_PROVIDER,
    import.meta.env.VITE_AUTH_REQUIRE_GOOGLE_CONNECTION
  );

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md p-8">
        <h1 className="text-2xl font-bold text-slate-900 text-center mb-8">เข้าสู่ระบบ</h1>

        {mandatoryConnection ? (
          <>
            <div className="flex flex-col gap-3">
              <Button asChild size="lg" className="w-full">
                <a href={manusLoginUrl}>เข้าสู่ระบบบัญชีเดิม</a>
              </Button>
              <Button asChild variant="outline" size="lg" className="w-full">
                <a href={GOOGLE_LOGIN_START_PATH}>เข้าสู่ระบบด้วย Google สำหรับสมาชิกใหม่</a>
              </Button>
            </div>
            <p className="mt-8 text-sm text-slate-600 text-center leading-relaxed">
              สมาชิกเดิม โดยเฉพาะผู้ที่เคยเข้าสู่ระบบด้วย Apple หรือ Hide My Email
              กรุณาเข้าสู่ระบบด้วยวิธีเดิมก่อน เพื่อเชื่อม Google เข้ากับบัญชีและข้อมูลเดิม
            </p>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              <Button asChild size="lg" className="w-full">
                <a href={GOOGLE_LOGIN_START_PATH}>เข้าสู่ระบบด้วย Google</a>
              </Button>
              <Button asChild variant="outline" size="lg" className="w-full">
                <a href={manusLoginUrl}>เข้าสู่ระบบด้วยวิธีเดิม</a>
              </Button>
            </div>
            <p className="mt-8 text-sm text-slate-600 text-center leading-relaxed">
              สมาชิกเดิมยังสามารถเข้าสู่ระบบด้วยวิธีเดิมได้ หากต้องการเปลี่ยนมาใช้ Google
              กรุณาเข้าสู่ระบบด้วยวิธีเดิมก่อน แล้วเชื่อมบัญชี Google ในหน้าบัญชีของฉัน
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
