// IPE-064 — the numbered workflow action bar (3.ตรวจ · 4.ยืนยัน · 5.Stage ·
// 6.Publish) sits at the top of the center pane and operates on the bulk
// scope: the packs selected in the left pane, or — when nothing is selected —
// the pack currently open in the editor. One bar replaces the old bulk
// toolbar that lived inside the ops/intake block.
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

interface WorkspaceActionBarProps {
  scopeLabel: string;
  disabled: boolean;
  checkPending: boolean;
  confirmPending: boolean;
  stagePending: boolean;
  publishPending: boolean;
  onCheck: () => void;
  onConfirm: () => void;
  onStage: () => void;
  onPublish: () => void;
}

export function WorkspaceActionBar({
  scopeLabel,
  disabled,
  checkPending,
  confirmPending,
  stagePending,
  publishPending,
  onCheck,
  onConfirm,
  onStage,
  onPublish,
}: WorkspaceActionBarProps) {
  const busy =
    checkPending || confirmPending || stagePending || publishPending;
  return (
    <Card
      className="space-y-2 p-3"
      data-testid="workspace-action-bar"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="workspace-action-check"
          disabled={disabled || busy}
          onClick={onCheck}
        >
          {checkPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          3. ตรวจ
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="workspace-action-confirm"
          disabled={disabled || busy}
          onClick={onConfirm}
        >
          {confirmPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          4. ยืนยัน
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="workspace-action-stage"
          disabled={disabled || busy}
          onClick={onStage}
        >
          {stagePending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          5. Stage
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid="workspace-action-publish"
          disabled={disabled || busy}
          onClick={onPublish}
        >
          {publishPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          6. Publish
        </Button>
        <span
          className="ml-auto text-xs text-muted-foreground"
          data-testid="workspace-action-bar-scope"
        >
          {scopeLabel}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        ขอบเขตการทำงาน: แพ็กที่เลือกในรายการซ้าย (ถ้าไม่เลือก = แพ็กที่เปิดอยู่) ·
        รายการที่ไม่ผ่าน QC/readiness จะไม่ถูกยืนยัน/เผยแพร่
      </p>
    </Card>
  );
}
