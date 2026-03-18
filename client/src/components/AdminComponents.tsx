import { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LucideIcon } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

/**
 * Shared Admin UI Components
 * Provides consistent styling and layout for admin pages
 */

// Stat Card - for dashboard summary
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
    blue: "bg-blue-50 text-blue-600",
    green: "bg-green-50 text-green-600",
    yellow: "bg-yellow-50 text-yellow-600",
    red: "bg-red-50 text-red-600",
    purple: "bg-purple-50 text-purple-600",
  };

  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-slate-600">{label}</p>
            <p className="text-3xl font-bold text-slate-900 mt-2">{value}</p>
            {trend && (
              <p className={`text-xs mt-2 ${trend.direction === "up" ? "text-green-600" : "text-red-600"}`}>
                {trend.direction === "up" ? "↑" : "↓"} {Math.abs(trend.value)}%
              </p>
            )}
          </div>
          <div className={`p-3 rounded-lg ${colorClasses[color]}`}>
            <Icon className="w-6 h-6" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Section Header - for page sections
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
    <div className="flex items-start justify-between mb-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">{title}</h2>
        {description && <p className="text-sm text-slate-600 mt-1">{description}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

// Status Badge - for order/payment status
export function StatusBadge({ status }: { status: string }) {
  const { t } = useLanguage();
  const statusConfig: Record<string, { bg: string; text: string; label: string }> = {
    pending: { bg: "bg-yellow-100", text: "text-yellow-800", label: t("status.pending") },
    approved: { bg: "bg-green-100", text: "text-green-800", label: "Approved" },
    rejected: { bg: "bg-red-100", text: "text-red-800", label: "Rejected" },
    completed: { bg: "bg-green-100", text: "text-green-800", label: "Completed" },
    active: { bg: "bg-green-100", text: "text-green-800", label: "Active" },
    inactive: { bg: "bg-slate-100", text: "text-slate-800", label: "Inactive" },
    draft: { bg: "bg-slate-100", text: "text-slate-800", label: "Draft" },
    published: { bg: "bg-green-100", text: "text-green-800", label: t("status.published") },
    archived: { bg: "bg-slate-100", text: "text-slate-800", label: t("status.archived") },
    ongoing: { bg: "bg-blue-100", text: "text-blue-800", label: t("status.ongoing") },
    finished: { bg: "bg-purple-100", text: "text-purple-800", label: t("status.finished") },
  };

  const config = statusConfig[status.toLowerCase()] || statusConfig.pending;

  return (
    <Badge className={`${config.bg} ${config.text} border-0`}>
      {config.label}
    </Badge>
  );
}

// Empty State - for empty lists
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
    <Card>
      <CardContent className="pt-12 pb-12 text-center">
        <Icon className="w-12 h-12 text-slate-300 mx-auto mb-4" />
        <h3 className="text-lg font-semibold text-slate-900 mb-2">{title}</h3>
        <p className="text-sm text-slate-600 mb-6">{description}</p>
        {action && <div>{action}</div>}
      </CardContent>
    </Card>
  );
}

// Data Table - for lists
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
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="w-full">
        <thead>
          <tr className="border-b bg-slate-50">
            {columns.map((col) => (
              <th
                key={col.key}
                className={`text-left px-4 py-3 font-semibold text-slate-700 text-sm ${col.width || ""}`}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, idx) => (
            <tr
              key={idx}
              className={`border-b hover:bg-slate-50 transition-colors ${onRowClick ? "cursor-pointer" : ""}`}
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
  );
}

// Form Section - for grouping form fields
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
    <div className="mb-8">
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
        {description && <p className="text-sm text-slate-600 mt-1">{description}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

// Info Box - for displaying important information
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
    warning: { bg: "bg-yellow-50", border: "border-yellow-200", icon: "⚠️", text: "text-yellow-900" },
    success: { bg: "bg-green-50", border: "border-green-200", icon: "✓", text: "text-green-900" },
    error: { bg: "bg-red-50", border: "border-red-200", icon: "✕", text: "text-red-900" },
  };

  const config = typeConfig[type];

  return (
    <div className={`${config.bg} border ${config.border} rounded-lg p-4`}>
      <div className="flex gap-3">
        <span className="text-lg flex-shrink-0">{config.icon}</span>
        <div>
          {title && <h4 className={`font-semibold ${config.text} mb-1`}>{title}</h4>}
          <p className={`text-sm ${config.text}`}>{message}</p>
        </div>
      </div>
    </div>
  );
}

// Action Row - for row actions
export function ActionRow({ children }: { children: ReactNode }) {
  return <div className="flex gap-2 items-center">{children}</div>;
}
