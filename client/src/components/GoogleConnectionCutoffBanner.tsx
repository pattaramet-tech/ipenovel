import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";

/**
 * The "visible but not disruptive" banner rule 13 of the targeted-cutoff
 * feature requires: shown ABOVE normal page content (never blocking it -
 * unlike <MigrationGate>'s post-cutoff redirect) once a cutoff has been
 * configured but hasn't arrived yet, for a signed-in user who hasn't
 * connected Google. Visibility itself is decided by
 * client/src/_core/hooks/migrationGate.ts's shouldShowUpcomingCutoffBanner
 * (server-status-driven, never the client's own clock) - this component is
 * purely presentational, rendered by <MigrationGate> once that's already
 * true.
 */
export default function GoogleConnectionCutoffBanner({ cutoffAt }: { cutoffAt: string | null }) {
  const [, navigate] = useLocation();

  const formattedCutoff = cutoffAt
    ? new Date(cutoffAt).toLocaleString("th-TH", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div className="bg-amber-50 border-b border-amber-200 px-4 py-3">
      <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-2 text-sm text-amber-900">
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            {formattedCutoff
              ? `ระบบจะเริ่มบังคับเชื่อมบัญชี Google ตั้งแต่วันที่ ${formattedCutoff} กรุณาเชื่อมบัญชี Google ล่วงหน้าเพื่อไม่ให้การใช้งานสะดุด`
              : "ระบบจะเริ่มบังคับเชื่อมบัญชี Google เร็ว ๆ นี้ กรุณาเชื่อมบัญชี Google ล่วงหน้าเพื่อไม่ให้การใช้งานสะดุด"}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button asChild size="sm">
            <a href="/api/auth/google/connect/start">เชื่อมบัญชี Google</a>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigate("/account/upgrade-login")}>
            ดูรายละเอียด
          </Button>
        </div>
      </div>
    </div>
  );
}
