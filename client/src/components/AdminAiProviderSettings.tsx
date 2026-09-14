import { useEffect, useMemo, useState } from "react";
import { KeyRound, Loader2, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";

type FormState = {
  id?: number;
  revision?: number;
  name: string;
  providerType: string;
  providerName: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  reconcileUrlTemplate: string;
  timeoutMs: string;
  maxInputChars: string;
  status: "enabled" | "disabled";
};

const blankForm = (): FormState => ({
  name: "",
  providerType: "openai_compatible",
  providerName: "",
  apiUrl: "",
  apiKey: "",
  model: "",
  reconcileUrlTemplate: "",
  timeoutMs: "30000",
  maxInputChars: "200000",
  status: "enabled",
});

export function AdminAiProviderSettings() {
  const list = trpc.admin.settings.aiProvider.list.useQuery();
  const audit = trpc.admin.settings.aiProvider.audit.useQuery({ limit: 10 });
  const save = trpc.admin.settings.aiProvider.save.useMutation();
  const setActive = trpc.admin.settings.aiProvider.setActive.useMutation();
  const [form, setForm] = useState<FormState>(blankForm);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const profiles = list.data?.profiles ?? [];
  const selected = useMemo(() => profiles.find((profile) => profile.id === selectedId), [profiles, selectedId]);

  useEffect(() => {
    if (!selected) return;
    setForm({
      id: selected.id,
      revision: selected.revision,
      name: selected.name,
      providerType: selected.providerType,
      providerName: selected.providerName,
      apiUrl: selected.apiUrl,
      apiKey: "",
      model: selected.model,
      reconcileUrlTemplate: selected.reconcileUrlTemplate ?? "",
      timeoutMs: String(selected.timeoutMs),
      maxInputChars: String(selected.maxInputChars),
      status: selected.status,
    });
  }, [selected]);

  const startNew = () => {
    setSelectedId(null);
    setForm(blankForm());
  };
  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const saveProfile = async () => {
    const timeoutMs = Number(form.timeoutMs);
    const maxInputChars = Number(form.maxInputChars);
    try {
      const saved = await save.mutateAsync({
        id: form.id,
        expectedRevision: form.revision,
        name: form.name,
        providerType: form.providerType,
        providerName: form.providerName,
        apiUrl: form.apiUrl,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey } : {}),
        model: form.model,
        reconcileUrlTemplate: form.reconcileUrlTemplate.trim() || null,
        timeoutMs,
        maxInputChars,
        status: form.status,
      });
      toast.success(form.id ? "บันทึก AI Provider แล้ว" : "สร้าง AI Provider แล้ว");
      setSelectedId(saved.id);
      setForm((prev) => ({ ...prev, id: saved.id, revision: saved.revision, apiKey: "" }));
      await Promise.all([list.refetch(), audit.refetch()]);
    } catch (error: any) {
      toast.error(error?.message || "บันทึก AI Provider ไม่สำเร็จ");
    }
  };

  const activate = async (profileId: number | null) => {
    if (!list.data) return;
    try {
      await setActive.mutateAsync({ profileId, expectedStateRevision: list.data.stateRevision });
      toast.success(profileId === null ? "ยกเลิก Active Provider แล้ว" : "เปลี่ยน Active Provider แล้ว");
      await Promise.all([list.refetch(), audit.refetch()]);
    } catch (error: any) {
      toast.error(error?.message || "เปลี่ยน Active Provider ไม่สำเร็จ");
    }
  };

  return (
    <Card className="p-6 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            <h2 className="text-lg font-semibold">Workspace AI Provider</h2>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            จัดการ Provider/API Key โดยไม่ต้อง Redeploy; API Key ถูกเข้ารหัสก่อนบันทึกและจะไม่ถูกส่งกลับมาเป็นข้อความจริง
          </p>
        </div>
        <Button type="button" variant="outline" onClick={startNew}><Plus className="mr-2 h-4 w-4" />เพิ่ม Provider</Button>
      </div>

      {list.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />กำลังโหลด...</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-[220px_1fr]">
          <div className="space-y-2">
            {profiles.length === 0 && <p className="text-sm text-slate-500">ยังไม่มี Provider profile</p>}
            {profiles.map((profile) => {
              const active = list.data?.activeProfileId === profile.id;
              return (
                <button key={profile.id} type="button" onClick={() => setSelectedId(profile.id)}
                  className={`w-full rounded-md border p-3 text-left text-sm ${selectedId === profile.id ? "border-slate-900" : "border-slate-200"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{profile.name}</span>
                    {active && <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">Active</span>}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">{profile.providerType} · {profile.model}</div>
                </button>
              );
            })}
          </div>

          <div className="space-y-4 rounded-md border p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div><Label>Profile name</Label><Input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="Gemini Preview" /></div>
              <div><Label>Provider type</Label><Input value={form.providerType} onChange={(e) => update("providerType", e.target.value)} placeholder="openai_compatible" /></div>
              <div><Label>Provider label</Label><Input value={form.providerName} onChange={(e) => update("providerName", e.target.value)} placeholder="gemini" /></div>
              <div><Label>Model</Label><Input value={form.model} onChange={(e) => update("model", e.target.value)} placeholder="model-id" /></div>
            </div>
            <div><Label>API URL</Label><Input value={form.apiUrl} onChange={(e) => update("apiUrl", e.target.value)} placeholder="https://..." /></div>
            <div>
              <Label>API Key {selected?.apiKeyConfigured ? <span className="font-normal text-slate-500">(ปัจจุบัน {selected.apiKeyMasked}; เว้นว่างเพื่อใช้ค่าเดิม)</span> : null}</Label>
              <Input type="password" autoComplete="new-password" value={form.apiKey} onChange={(e) => update("apiKey", e.target.value)} placeholder={form.id ? "เว้นว่างถ้าไม่เปลี่ยน" : "กรอก API Key"} />
            </div>
            <div><Label>Receipt reconciliation URL template</Label><Input value={form.reconcileUrlTemplate} onChange={(e) => update("reconcileUrlTemplate", e.target.value)} placeholder="https://.../{providerRequestId}" /></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div><Label>Timeout (ms)</Label><Input inputMode="numeric" value={form.timeoutMs} onChange={(e) => update("timeoutMs", e.target.value)} /></div>
              <div><Label>Max input characters</Label><Input inputMode="numeric" value={form.maxInputChars} onChange={(e) => update("maxInputChars", e.target.value)} /></div>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div><Label>Profile enabled</Label><p className="text-xs text-slate-500">ไม่ใช่ execution kill switch; execution ยังควบคุมด้วย ENV</p></div>
              <Switch checked={form.status === "enabled"} onCheckedChange={(checked) => update("status", checked ? "enabled" : "disabled")} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={saveProfile} disabled={save.isPending}>{save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}บันทึก Provider</Button>
              {form.id && list.data?.activeProfileId !== form.id && <Button type="button" variant="outline" onClick={() => activate(form.id!)} disabled={setActive.isPending || form.status !== "enabled"}>ตั้งเป็น Active</Button>}
              {form.id && list.data?.activeProfileId === form.id && <Button type="button" variant="outline" onClick={() => activate(null)} disabled={setActive.isPending}>ยกเลิก Active</Button>}
            </div>
          </div>
        </div>
      )}

      <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
        <div className="flex items-center gap-2 font-medium"><ShieldCheck className="h-4 w-4" />Safety boundary</div>
        <p className="mt-1">การเปลี่ยน Provider ในหน้านี้ไม่สามารถเปิด WORKSPACE_AI_QC_EXECUTION_ENABLED หรือ WORKSPACE_PUBLISH_EXECUTION_ENABLED ได้</p>
      </div>

      {audit.data && audit.data.length > 0 && (
        <div><h3 className="mb-2 text-sm font-semibold">Recent provider changes</h3><div className="space-y-1 text-xs text-slate-600">
          {audit.data.map((row) => <div key={row.id}>#{row.id} · {row.action} · profile {row.profileId ?? "-"} · admin {row.actorAdminId}</div>)}
        </div></div>
      )}
    </Card>
  );
}