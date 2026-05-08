"use client";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, AlertCircle, CheckCircle2, Trash2, Plus } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Switch } from "@/components/ui/switch";
import AdminLayout from "@/components/AdminLayout";

export default function AdminSettingsPage() {
  // ─── State for general settings ────────────────────────────────────────────
  const [settings, setSettings] = useState({
    siteName: "Ipenovel",
    siteDescription: "A digital translated novel store",
    contactEmail: "support@ipenovel.com",
  });
  const [isSaving, setIsSaving] = useState(false);

  // ─── State for new bonus rule form ─────────────────────────────────────────
  const [newRuleThreshold, setNewRuleThreshold] = useState("");
  const [newRuleBonus, setNewRuleBonus] = useState("");
  const [newRuleLabel, setNewRuleLabel] = useState("");

  // ─── tRPC queries (hooks called at render level) ────────────────────────────
  const { data: ocrData, isLoading: ocrLoading } = trpc.admin.settings.getOCRToggle.useQuery();
  const { data: bonusData, isLoading: bonusLoading } = trpc.admin.settings.getWalletBonusRules.useQuery();

  // ─── tRPC mutations (hooks called at render level) ────────────────────────
  const setOCRToggleMutation = trpc.admin.settings.setOCRToggle.useMutation();
  const addBonusRuleMutation = trpc.admin.settings.addWalletBonusRule.useMutation();
  const deleteBonusRuleMutation = trpc.admin.settings.deleteWalletBonusRule.useMutation();
  const toggleBonusRuleMutation = trpc.admin.settings.toggleWalletBonusRule.useMutation();

  const utils = trpc.useUtils();

  // ─── Handlers with proper async/await patterns ─────────────────────────────
  const handleOCRToggle = async (enabled: boolean) => {
    try {
      const result = await setOCRToggleMutation.mutateAsync({ enabled });
      if (result.success) {
        toast.success(`OCR ${enabled ? "enabled" : "disabled"} successfully`);
        // Invalidate query to refresh data
        await utils.admin.settings.getOCRToggle.invalidate();
      } else {
        toast.error("Failed to update OCR toggle");
      }
    } catch (error) {
      console.error("Failed to update OCR toggle:", error);
      toast.error("Failed to update OCR toggle");
    }
  };

  const handleAddBonusRule = async () => {
    if (!newRuleThreshold || !newRuleBonus) {
      toast.error("Please enter threshold and bonus amount");
      return;
    }

    const threshold = parseFloat(newRuleThreshold);
    const bonus = parseFloat(newRuleBonus);

    if (isNaN(threshold) || threshold <= 0) {
      toast.error("Threshold must be a positive number");
      return;
    }
    if (isNaN(bonus) || bonus < 0) {
      toast.error("Bonus must be zero or positive");
      return;
    }

    try {
      await addBonusRuleMutation.mutateAsync({
        threshold,
        bonus,
        label: newRuleLabel || undefined,
      });
      toast.success("Bonus rule added successfully");
      setNewRuleThreshold("");
      setNewRuleBonus("");
      setNewRuleLabel("");
      // Refresh rules
      await utils.admin.settings.getWalletBonusRules.invalidate();
    } catch (error: any) {
      toast.error(error.message || "Failed to add bonus rule");
    }
  };

  const handleDeleteBonusRule = async (ruleId: string) => {
    try {
      await deleteBonusRuleMutation.mutateAsync({ ruleId });
      toast.success("Bonus rule deleted successfully");
      // Refresh rules
      await utils.admin.settings.getWalletBonusRules.invalidate();
    } catch (error: any) {
      toast.error(error.message || "Failed to delete bonus rule");
    }
  };

  const handleToggleBonusRule = async (ruleId: string, enabled: boolean) => {
    try {
      await toggleBonusRuleMutation.mutateAsync({ ruleId, enabled });
      toast.success(`Bonus rule ${enabled ? "enabled" : "disabled"} successfully`);
      // Refresh rules
      await utils.admin.settings.getWalletBonusRules.invalidate();
    } catch (error: any) {
      toast.error(error.message || "Failed to toggle bonus rule");
    }
  };

  // ─── Computed values ───────────────────────────────────────────────────────
  const ocrEnabled = ocrData?.ocrEnabled ?? true;
  const bonusRules = bonusData?.rules || [];
  const isMutating = 
    setOCRToggleMutation.isPending ||
    addBonusRuleMutation.isPending ||
    deleteBonusRuleMutation.isPending ||
    toggleBonusRuleMutation.isPending;

  return (
    <AdminLayout>
      <div className="space-y-6 max-w-2xl">
        {/* General Settings */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-4">General Settings</h2>
          <div className="space-y-4">
            <div>
              <Label>Site Name</Label>
              <Input
                value={settings.siteName}
                onChange={(e) => setSettings({ ...settings, siteName: e.target.value })}
                placeholder="Site name"
              />
            </div>
            <div>
              <Label>Site Description</Label>
              <Textarea
                value={settings.siteDescription}
                onChange={(e) => setSettings({ ...settings, siteDescription: e.target.value })}
                placeholder="Site description"
                rows={3}
              />
            </div>
            <div>
              <Label>Contact Email</Label>
              <Input
                type="email"
                value={settings.contactEmail}
                onChange={(e) => setSettings({ ...settings, contactEmail: e.target.value })}
                placeholder="contact@example.com"
              />
            </div>
          </div>
        </Card>

        {/* OCR Settings */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-4">OCR Settings</h2>
          <div className="space-y-4">
            {ocrLoading ? (
              <div className="flex items-center gap-2 text-gray-600">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading OCR settings...
              </div>
            ) : (
              <div className="flex items-center justify-between p-4 bg-gray-50 rounded">
                <div>
                  <p className="font-medium">Enable OCR Processing</p>
                  <p className="text-sm text-gray-600">
                    {ocrEnabled
                      ? "OCR is enabled - payment slips will be auto-processed"
                      : "OCR is disabled - all slips go to manual review"}
                  </p>
                </div>
                <Switch
                  checked={ocrEnabled}
                  onCheckedChange={handleOCRToggle}
                  disabled={setOCRToggleMutation.isPending}
                />
              </div>
            )}
          </div>
        </Card>

        {/* Payment Settings */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-4">Payment Settings</h2>
          <div className="space-y-4">
            <div className="p-4 bg-blue-50 rounded">
              <p className="text-sm text-blue-900">
                Payment processing is configured through Manus built-in payment system.
                No additional configuration needed.
              </p>
            </div>
          </div>
        </Card>

        {/* Wallet Bonus Settings */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-4">Wallet Top-up Bonus Settings</h2>
          <div className="space-y-4">
            {bonusLoading ? (
              <div className="flex items-center gap-2 text-gray-600">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading bonus rules...
              </div>
            ) : (
              <>
                {/* Existing Rules */}
                <div>
                  <h3 className="font-medium text-sm mb-3">Current Bonus Rules</h3>
                  <div className="space-y-2">
                    {bonusRules.length === 0 ? (
                      <p className="text-sm text-gray-500">No bonus rules configured</p>
                    ) : (
                      bonusRules.map((rule) => (
                        <div key={rule.id} className="flex items-center gap-2 p-3 bg-gray-50 rounded">
                          <Switch
                            checked={rule.enabled}
                            onCheckedChange={(enabled) => handleToggleBonusRule(rule.id, enabled)}
                            disabled={isMutating}
                          />
                          <div className="flex-1">
                            <p className="text-sm font-medium">
                              ฿{rule.threshold} → +฿{rule.bonus}
                              {rule.label && <span className="text-xs text-gray-500 ml-2">({rule.label})</span>}
                            </p>
                            <p className="text-xs text-gray-500">
                              {rule.enabled ? "Enabled" : "Disabled"}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteBonusRule(rule.id)}
                            disabled={isMutating}
                          >
                            <Trash2 className="w-4 h-4 text-red-500" />
                          </Button>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Add New Rule */}
                <div className="border-t pt-4">
                  <h3 className="font-medium text-sm mb-3">Add New Bonus Rule</h3>
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-xs">Threshold (฿)</Label>
                        <Input
                          type="number"
                          value={newRuleThreshold}
                          onChange={(e) => setNewRuleThreshold(e.target.value)}
                          placeholder="250"
                          min="0"
                          step="1"
                          disabled={isMutating}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Bonus (฿)</Label>
                        <Input
                          type="number"
                          value={newRuleBonus}
                          onChange={(e) => setNewRuleBonus(e.target.value)}
                          placeholder="10"
                          min="0"
                          step="1"
                          disabled={isMutating}
                        />
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs">Label (optional)</Label>
                      <Input
                        value={newRuleLabel}
                        onChange={(e) => setNewRuleLabel(e.target.value)}
                        placeholder="e.g., Summer promotion"
                        disabled={isMutating}
                      />
                    </div>
                    <Button
                      onClick={handleAddBonusRule}
                      disabled={isMutating}
                      className="w-full"
                      size="sm"
                    >
                      {isMutating ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Adding...
                        </>
                      ) : (
                        <>
                          <Plus className="w-4 h-4 mr-2" />
                          Add Bonus Rule
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        </Card>
      </div>
    </AdminLayout>
  );
}
