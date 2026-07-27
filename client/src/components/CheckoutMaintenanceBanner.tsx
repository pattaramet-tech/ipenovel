import { AlertCircle, AlertTriangle, Info } from "lucide-react";
import { cn } from "@/lib/utils";

export type CheckoutMaintenanceBannerStatus = {
  enabled: boolean;
  scope: "notice_only" | "slip_only" | "all_checkout";
  severity: "info" | "warning" | "error";
  title: string;
  message: string;
};

const styles = {
  info: "border-blue-300 bg-blue-50 text-blue-950",
  warning: "border-amber-300 bg-amber-50 text-amber-950",
  error: "border-red-300 bg-red-50 text-red-950",
};

const icons = {
  info: Info,
  warning: AlertTriangle,
  error: AlertCircle,
};

export function CheckoutMaintenanceBanner({
  status,
  className,
}: {
  status?: CheckoutMaintenanceBannerStatus;
  className?: string;
}) {
  if (!status?.enabled) return null;
  const Icon = icons[status.severity];
  const label =
    status.severity === "info" ? "ข้อมูล" : status.severity === "warning" ? "คำเตือน" : "ระบบขัดข้อง";

  return (
    <div
      role={status.severity === "info" ? "status" : "alert"}
      aria-label={label}
      className={cn("rounded-lg border p-4", styles[status.severity], className)}
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide">{label}</p>
          <p className="font-semibold whitespace-pre-wrap break-words">{status.title}</p>
          <p className="mt-1 text-sm whitespace-pre-wrap break-words">{status.message}</p>
        </div>
      </div>
    </div>
  );
}
