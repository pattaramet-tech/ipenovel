// IPE-062 — multi-story overview: one compact card per story (novel) plus the
// numbered workflow strip. Presentational only; all data comes from the board
// evidence the page already loads.
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  STORY_OVERALL_LABEL,
  STORY_PACK_STATUS_LABEL,
  type StoryOverallStatus,
  type StoryPackSummary,
} from "./workspaceMultiStory";

const OVERALL_BADGE_CLASS: Record<StoryOverallStatus, string> = {
  anomalous: "border-red-300 bg-red-50 text-red-700",
  needs_fix: "border-orange-300 bg-orange-50 text-orange-700",
  in_progress: "border-slate-300 bg-slate-50 text-slate-600",
  passed: "border-teal-300 bg-teal-50 text-teal-700",
  published: "border-emerald-300 bg-emerald-50 text-emerald-700",
};

export interface WorkspaceStoryOverviewStory {
  key: string;
  title: string;
  novelId: number | null;
  summary: StoryPackSummary;
  overall: StoryOverallStatus;
  focused: boolean;
}

interface WorkspaceStoryOverviewProps {
  stories: WorkspaceStoryOverviewStory[];
  onFocusStory: (storyKey: string) => void;
}

const WORKFLOW_STEPS = [
  "เลือกแพ็ก / ตอน",
  "แก้ / ตรวจซ้ำ",
  "ยืนยัน Draft",
  "Stage",
  "Publish",
] as const;

export function WorkspaceStoryOverview({ stories, onFocusStory }: WorkspaceStoryOverviewProps) {
  return (
    <div className="space-y-2" data-testid="workspace-story-overview">
      <div className="flex flex-wrap items-center gap-2" data-testid="workflow-steps" aria-label="ลำดับงานของแพ็ก">
        <span className="text-xs font-medium text-muted-foreground">ลำดับงาน:</span>
        {WORKFLOW_STEPS.map((step, index) => (
          <span
            key={step}
            className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground"
          >
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
              {index + 1}
            </span>
            {step}
          </span>
        ))}
      </div>
      {stories.length ? (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" data-testid="workspace-story-cards">
          {stories.map((story) => (
            <Card
              key={story.key}
              data-testid="workspace-story-card"
              data-story-key={story.key}
              data-focused={story.focused ? "true" : undefined}
              className={`space-y-2 p-3 ${story.focused ? "border-primary bg-primary/5 ring-1 ring-primary/30" : ""}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold" title={story.title}>
                    {story.title}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {story.summary.total} แพ็ก · Novel #{story.novelId ?? "—"}
                  </div>
                </div>
                <span
                  data-testid="workspace-story-overall"
                  className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${OVERALL_BADGE_CLASS[story.overall]}`}
                >
                  {STORY_OVERALL_LABEL[story.overall]}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                {story.summary.published > 0 && <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5">ลงแล้ว {story.summary.published}</span>}
                {story.summary.passed > 0 && <span className="rounded-full border border-teal-200 bg-teal-50 px-1.5">ผ่าน {story.summary.passed}</span>}
                {story.summary.needsFix > 0 && <span className="rounded-full border border-orange-200 bg-orange-50 px-1.5">ต้องแก้ {story.summary.needsFix}</span>}
                {story.summary.anomalous > 0 && <span className="rounded-full border border-red-200 bg-red-50 px-1.5">ผิดปกติ {story.summary.anomalous}</span>}
                {story.summary.notChecked > 0 && <span className="rounded-full border border-slate-200 bg-slate-50 px-1.5">ยังไม่ตรวจ {story.summary.notChecked}</span>}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">
                  {story.focused
                    ? "กำลังทำงานอยู่ — state ของเรื่องนี้ถูกจำไว้"
                    : story.summary.needsFix + story.summary.anomalous > 0
                      ? `มีงานรอแก้ ${story.summary.needsFix + story.summary.anomalous} แพ็ก`
                      : STORY_PACK_STATUS_LABEL.passed}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant={story.focused ? "secondary" : "outline"}
                  data-testid="workspace-story-focus"
                  onClick={() => onFocusStory(story.key)}
                >
                  {story.focused ? "ทำงานเรื่องนี้" : "เปิดเรื่องนี้"}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          ยังไม่มีเรื่องใน Workspace นี้ — เพิ่มเรื่องผ่านเครื่องมือนำเข้าด้านล่าง
        </div>
      )}
    </div>
  );
}
