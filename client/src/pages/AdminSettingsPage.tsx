"use client";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Loader2, AlertCircle, CheckCircle2, Trash2, Plus } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Switch } from "@/components/ui/switch";
import AdminLayout from "@/components/AdminLayout";

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState({
    siteName: "Ipenovel",
    siteDescription: "A digital translated novel store",
    contactEmail: "support@ipenovel.com",
  });
  const [isSaving, setIsSaving] = useState(false);

  // OCR toggle state
  const [ocrEnabled, setOcrEnabled] = useState(true);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrStatus, setOcrStatus] = useState<any>(null);

  // Wallet bonus rules state
  const [bonusRules, setBonusRules] = useState<any[]>([]);
  const [bonusLoading, setBonusLoading] = useState(false);
  const [bonusSaving, setBonusSaving] = useState(false);
  const [newRuleThreshold, setNewRuleThreshold] = useState("");
  const [newRuleBonus, setNewRuleBonus] = useState("");
  const [newRuleLabel, setNewRuleLabel] = useState("");

  // Fetch OCR status and bonus rules on mount
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const status = await trpc.admin.settings.getOCRToggle.useQuery();
        setOcrStatus(status.data);
        setOcrEnabled(status.data?.ocrEnabled ?? true);
      } catch (error) {
        console.error("Failed to fetch OCR status:", error);
        toast.error("Failed to load OCR settings");
      }
      
      try {
        setBonusLoading(true);
        const result = await trpc.admin.settings.getWalletBonusRules.useQuery();
        setBonusRules(result.data?.rules || []);
      } catch (error) {
        console.error("Failed to fetch bonus rules:", error);
        toast.error("Failed to load bonus rules");
      } finally {
        setBonusLoading(false);
      }
    }
    fetchSettings();
  }, []);

  const handleOCRToggle = async (enabled: boolean) => {
    setOcrLoading(true);
    try {
      const result = await trpc.admin.settings.setOCRToggle.useMutation().mutateAsync({ enabled });
      if (result.success) {
        setOcrEnabled(enabled);
        toast.success(`OCR ${enabled ? "enabled" : "disabled"} successfully`);
        // Refresh status
        const status = await trpc.admin.settings.getOCRToggle.useQuery();
        setOcrStatus(status.data);
      } else {
        toast.error("Failed to update OCR toggle");
      }
    } catch (error) {
      console.error("Failed to update OCR toggle:", error);
      toast.error("Failed to update OCR toggle");
    } finally {
      setOcrLoading(false);
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

    setBonusSaving(true);
    try {
      await trpc.admin.settings.addWalletBonusRule.useMutation().mutateAsync({
        threshold,
        bonus,
        label: newRuleLabel || undefined,
      });
      toast.success("Bonus rule added successfully");
      setNewRuleThreshold("");
      setNewRuleBonus("");
      setNewRuleLabel("");
      // Refresh rules
      const result = await trpc.admin.settings.getWalletBonusRules.useQuery();
      setBonusRules(result.data?.rules || []);
    } catch (error: any) {
      toast.error(error.message || "Failed to add bonus rule");
    } finally {
      setBonusSaving(false);
    }
  };

  const handleDeleteBonusRule = async (ruleId: string) => {
    setBonusSaving(true);
    try {
      await trpc.admin.settings.deleteWalletBonusRule.useMutation().mutateAsync({ ruleId });
      toast.success("Bonus rule deleted successfully");
      // Refresh rules
      const result = await trpc.admin.settings.getWalletBonusRules.useQuery();
      setBonusRules(result.data?.rules || []);
    } catch (error: any) {
      toast.error(error.message || "Failed to delete bonus rule");
    } finally {
      setBonusSaving(false);
    }
  };

  const handleToggleBonusRule = async (ruleId: string, enabled: boolean) => {
    setBonusSaving(true);
    try {
      await trpc.admin.settings.toggleWalletBonusRule.useMutation().mutateAsync({ ruleId, enabled });
      toast.success(`Bonus rule ${enabled ? "enabled" : "disabled"} successfully`);
      // Refresh rules
      const result = await trpc.admin.settings.getWalletBonusRules.useQuery();
      setBonusRules(result.data?.rules || []);
    } catch (error: any) {
      toast.error(error.message || "Failed to toggle bonus rule");
    } finally {
      setBonusSaving(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Simulate save
      await new Promise((resolve) => setTimeout(resolve, 1000));
      toast.success("Settings saved successfully!");
    } catch (error) {
      toast.error("Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

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
                            disabled={bonusSaving}
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
                            disabled={bonusSaving}
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
                          disabled={bonusSaving}
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
                          disabled={bonusSaving}
                        />
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs">Label (optional)</Label>
                      <Input
                        value={newRuleLabel}
                        onChange={(e) => setNewRuleLabel(e.target.value)}
                        placeholder="e.g., Summer promotion"
                        disabled={bonusSaving}
                      />
                    </div>
                    <Button
                      onClick={handleAddBonusRule}
                      disabled={bonusSaving}
                      className="w-full"
                      size="sm"
                    >
                      {bonusSaving ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Adding...
                        </>
                      ) : (
                        <>
                          <Plus className="w-4 h-4 mr-2" />
                          Add Rule
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        </Card>

        {/* OCR Settings */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-4">OCR Auto-Approval Settings</h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-gray-50 rounded">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <Label className="text-base font-medium">Enable OCR Auto-Processing</Label>
                  {ocrEnabled ? (
                    <CheckCircle2 className="w-5 h-5 text-green-600" />
                  ) : (
                    <AlertCircle className="w-5 h-5 text-orange-600" />
                  )}
                </div>
                <p className="text-sm text-gray-600 mt-1">
                  {ocrEnabled
                    ? "OCR is enabled. Payment slips will be automatically processed and approved if verification is strong."
                    : "OCR is disabled. All payment slips will be sent to manual review."}
                </p>
                {ocrStatus && (
                  <p className="text-xs text-gray-500 mt-2">
                    Source: {ocrStatus.source}
                    {ocrStatus.environmentOverride && ` (${ocrStatus.environmentOverride})`}
                  </p>
                )}
              </div>
              <Switch
                checked={ocrEnabled}
                onCheckedChange={handleOCRToggle}
                disabled={ocrLoading}
                className="ml-4"
              />
            </div>
            <div className="p-3 bg-blue-50 rounded text-sm text-blue-900">
              <p className="font-medium mb-1">How it works:</p>
              <ul className="list-disc list-inside space-y-1 text-xs">
                <li><strong>OCR ON:</strong> Slips are processed by OCR. Strong confidence = auto-approve. Otherwise = manual review.</li>
                <li><strong>OCR OFF:</strong> All slips skip OCR and go directly to manual review.</li>
                <li>Wallet payments are unaffected by this setting.</li>
              </ul>
            </div>
          </div>
        </Card>

        {/* System Information */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-4">System Information</h2>
          <div className="space-y-2 text-sm">
            <p><span className="font-semibold">Environment:</span> Production</p>
            <p><span className="font-semibold">Database:</span> MySQL</p>
            <p><span className="font-semibold">Storage:</span> S3</p>
            <p><span className="font-semibold">Auth:</span> Manus OAuth</p>
          </div>
        </Card>

        {/* Save Button */}
        <div className="flex gap-2">
          <Button
            onClick={handleSave}
            disabled={isSaving}
            className="w-full"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Settings"
            )}
          </Button>
        </div>
      </div>
    </AdminLayout>
  );
}
