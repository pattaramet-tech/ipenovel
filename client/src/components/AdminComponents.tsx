import { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LucideIcon } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

/**
 * Shared Admin UI Components
 * Provides consistent styling and layout for admin pages
 */

export function StatCard({
  label,
  value,
  icon: Icon,
  color = "blue",
  trend,
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
  color?: "blue" | "green" | "yellow" | "red" | "purple";
  trend?: { value: number; direction: "up" | "down" };
}) {
  const colorClasses = {
    blue: "bg-blue-50 text-blue-600 ring-blue-100",
    green: "bg-green-50 text-green-600 ring-green-100",
    yellow: "bg-amber-50 text-amber-600 ring-amber-100",
    red: "bg-red-50 text-red-600 ring-red-100",
    purple: "bg-purple-50 text-purple-600 ring-purple-100",
  };

  return (
    <Card className="border-slate-200/80 bg-white shadow-sm transition duration-200 hover:-translate-y-0.5 hover:shadow-md">
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-slate-500 sm:text-sm">{label}</p>
            <p className="mt-1.5 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              {value}
            </p>
            {trend && (
              <p
                className={`mt-2 text-xs font-medium ${
                  trend.direction === "up" ? "text-green-600" : "text-red-600"
                }`}
              >
                {trend.direction === "up" ? "↑" : "↓"} {Math.abs(trend.value)}%
              </p>
            )}
          </div>
          <div className={`shrink-0 rounded-xl p-2.5 ring-1 ${colorClasses[color]}`}>
            <Icon className="h-5 w-5 sm:h-6 sm:w-6" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-lg font-bold tracking-tight text-slate-900 sm:text-xl">{title}</h2>
        {description && <p className="mt-1 text-sm leading-6 text-slate-500">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const { t } = useLanguage();
  const statusConfig: Record<string, { bg: string; text: string; label: string }> = {
    pending: { bg: "bg-amber-100", text: "text-amber-800", label: t("status.pending") },
    approved: { bg: "bg-green-100", text: "text-green-800", label: "Approved" },
    rejected: { bg: "bg-red-100", text: "text-red-800", label: "Rejected" },
    completed: { bg: "bg-green-100", text: "text-green-800", label: "Completed" },
    active: { bg: "bg-green-100", text: "text-green-800", label: "Active" },
    inactive: { bg: "bg-slate-100", text: "text-slate-700", label: "Inactive" },
    draft: { bg: "bg-slate-100", text: "text-slate-700", label: "Draft" },
    published: { bg: "bg-green-100", text: "text-green-800", label: t("status.published") },
    archived: { bg: "bg-slate-100", text: "text-slate-700", label: t("status.archived") },
    ongoing: { bg: "bg-blue-100", text: "text-blue-800", label: t("status.ongoing") },
    finished: { bg: "bg-purple-100", text: "text-purple-800", label: t("status.finished") },
  };

  const config = statusConfig[status.toLowerCase()] || statusConfig.pending;

  return (
    <Badge className={`${config.bg} ${config.text} border-0 font-medium shadow-none`}>
      {config.label}
    </Badge>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Card className="border-slate-200/80 bg-white shadow-sm">
      <CardContent className="px-6 py-12 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100">
          <Icon className="h-6 w-6 text-slate-400" />
        </div>
        <h3 className="mb-2 text-lg font-semibold text-slate-900">{title}</h3>
        <p className="mx-auto mb-6 max-w-md text-sm leading-6 text-slate-500">{description}</p>
        {action && <div>{action}</div>}
      </CardContent>
    </Card>
  );
}

export function DataTable({
  columns,
  data,
  onRowClick,
}: {
  columns: Array<{
    key: string;
    label: string;
    render?: (value: any, row: any) => ReactNode;
    width?: string;
  }>;
  data: any[];
  onRowClick?: (row: any) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full min-w-max">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/80">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-600 ${
                    col.width || ""
                  }`}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.map((row, idx) => (
              <tr
                key={idx}
                className={`bg-white transition-colors hover:bg-slate-50/80 ${
                  onRowClick ? "cursor-pointer" : ""
                }`}
                onClick={() => onRowClick?.(row)}
              >
                {columns.map((col) => (
                  <td key={col.key} className="px-4 py-3 text-sm text-slate-700">
                    {col.render ? col.render(row[col.key], row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
        {description && <p className="mt-1 text-sm leading-6 text-slate-500">{description}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function InfoBox({
  type = "info",
  title,
  message,
}: {
  type?: "info" | "warning" | "success" | "error";
  title?: string;
  message: string;
}) {
  const typeConfig = {
    info: { bg: "bg-blue-50", border: "border-blue-200", icon: "ℹ️", text: "text-blue-900" },
    warning: { bg: "bg-amber-50", border: "border-amber-200", icon: "⚠️", text: "text-amber-900" },
    success: { bg: "bg-green-50", border: "border-green-200", icon: "✓", text: "text-green-900" },
    error: { bg: "bg-red-50", border: "border-red-200", icon: "✕", text: "text-red-900" },
  };

  const config = typeConfig[type];

  return (
    <div className={`${config.bg} rounded-xl border ${config.border} p-4`}>
      <div className="flex gap-3">
        <span className="shrink-0 text-lg">{config.icon}</span>
        <div className="min-w-0">
          {title && <h4 className={`mb-1 font-semibold ${config.text}`}>{title}</h4>}
          <p className={`text-sm leading-6 ${config.text}`}>{message}</p>
        </div>
      </div>
    </div>
  );
}

export function ActionRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}
