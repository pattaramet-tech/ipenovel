// IPE-062 — primary workflow actions (right pane bottom). The buttons call
// the exact handlers the editor toolbar already uses (single boundary for
// save/confirm; Stage/Publish switch the detail tab). No new logic.
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

interface WorkspaceWorkflowActionsProps {
  hasDraft: boolean;
  savePending: boolean;
  dirty: boolean;
  onSaveCheck: () => void;
  confirmDisabled: boolean;
  confirming: boolean;
  onConfirm: () => void;
  stageDisabled: boolean;
  staging: boolean;
  onGoStage: () => void;
  publishReady: boolean;
  onGoPublish: () => void;
}

export function WorkspaceWorkflowActions({
  hasDraft,
  savePending,
  dirty,
  onSaveCheck,
  confirmDisabled,
  confirming,
  onConfirm,
  stageDisabled,
  staging,
  onGoStage,
  publishReady,
  onGoPublish,
}: WorkspaceWorkflowActionsProps) {
  return (
    <Card className="space-y-2 p-3" data-testid="workspace-workflow-actions">
      <div className="text-xs font-medium text-muted-foreground">การทำงานหลัก</div>
      <Button
        type="button"
        className="w-full"
        disabled={!hasDraft || savePending || !dirty}
        onClick={onSaveCheck}
        data-testid="workspace-action-save-check"
      >
        {savePending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        บันทึก Draft + ตรวจซ้ำ
      </Button>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" disabled={confirmDisabled || confirming} onClick={onConfirm}>
          {confirming && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          ยืนยัน Draft
        </Button>
        <Button type="button" variant="outline" disabled={stageDisabled || staging} onClick={onGoStage}>
          {staging && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          ไป Stage
        </Button>
      </div>
      <Button
        type="button"
        variant={publishReady ? "default" : "outline"}
        className="w-full"
        onClick={onGoPublish}
        data-testid="workspace-action-publish"
      >
        Publish{publishReady ? "" : " (ยังไม่พร้อม)"}
      </Button>
    </Card>
  );
}
