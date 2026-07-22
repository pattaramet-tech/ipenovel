"use client";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Loader2, AlertCircle, CheckCircle2, Info } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Switch } from "@/components/ui/switch";
import AdminLayout from "@/components/AdminLayout";
import { X } from "lucide-react";

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState({
    siteName: "Ipenovel",
    siteDescription: "A digital translated novel store",
    contactEmail: "support@ipenovel.com",
  });
  const [isSaving, setIsSaving] = useState(false);

  // OCR Settings state (Phase 4 - single source of truth)
  const [ocrSettings, setOcrSettings] = useState({
    enabled: true,
    autoApproveEnabled: true,
    shadowModeEnabled: false,
    minConfidence: 80,
    maxTimeWindowMinutes: 120,
  });
  const [ocrSettingsLoading, setOcrSettingsLoading] = useState(false);
  const [ocrSettingsEdited, setOcrSettingsEdited] = useState(false);

  // Phase 4 hooks (single source of truth)
  const getOCRSettingsQuery = trpc.admin.settings.getOCRSettings.useQuery();
  const updateOCRSettingsMutation = trpc.admin.settings.updateOCRSettings.useMutation();

  // Wallet Bonus Settings state
  const [bonusSettings, setBonusSettings] = useState({
    enabled: true,
    tiers: [
      { minAmount: 250, bonusAmount: 10, label: "เติมครบ 250 รับโบนัส 10" },
      { minAmount: 500, bonusAmount: 20, label: "เติมครบ 500 รับโบนัส 20" },
    ],
  });
  const [bonusSettingsLoading, setBonusSettingsLoading] = useState(false);
  const [bonusSettingsEdited, setBonusSettingsEdited] = useState(false);
  const [newTierInput, setNewTierInput] = useState({ minAmount: "", bonusAmount: "" });

  // Wallet Bonus hooks
  const getBonusConfigQuery = trpc.wallet.admin.getBonusConfig.useQuery();
  const updateBonusConfigMutation = trpc.wallet.admin.updateBonusConfig.useMutation();

  // Fetch Phase 4 OCR settings
  useEffect(() => {
    if (getOCRSettingsQuery.data?.settings) {
      setOcrSettings(getOCRSettingsQuery.data.settings);
      setOcrSettingsEdited(false);
    }
  }, [getOCRSettingsQuery.data]);

  // Fetch bonus config
  useEffect(() => {
    if (getBonusConfigQuery.data) {
      setBonusSettings(getBonusConfigQuery.data);
      setBonusSettingsEdited(false);
    }
  }, [getBonusConfigQuery.data]);

  const handleOCRSettingChange = (key: keyof typeof ocrSettings, value: any) => {
    setOcrSettings((prev) => ({
      ...prev,
      [key]: value,
    }));
    setOcrSettingsEdited(true);
  };

  const handleSaveOCRSettings = async () => {
    setOcrSettingsLoading(true);
    try {
      const result = await updateOCRSettingsMutation.mutateAsync(ocrSettings);
      if (result.success) {
        toast.success("OCR settings saved successfully!");
        setOcrSettingsEdited(false);
        getOCRSettingsQuery.refetch();
      } else {
        toast.error("Failed to save OCR settings");
      }
    } catch (error: any) {
      console.error("Failed to save OCR settings:", error);
      toast.error(error?.message || "Failed to save OCR settings");
    } finally {
      setOcrSettingsLoading(false);
    }
  };

  const handleBonusSettingChange = (key: keyof typeof bonusSettings, value: any) => {
    setBonusSettings((prev) => ({
      ...prev,
      [key]: value,
    }));
    setBonusSettingsEdited(true);
  };

  const handleAddTier = () => {
    if (!newTierInput.minAmount || !newTierInput.bonusAmount) {
      toast.error("Please fill in both min amount and bonus amount");
      return;
    }

    const minAmount = parseFloat(newTierInput.minAmount);
    const bonusAmount = parseFloat(newTierInput.bonusAmount);

    if (minAmount <= 0 || bonusAmount < 0) {
      toast.error("Min amount must be positive, bonus amount must be non-negative");
      return;
    }

    if (bonusSettings.tiers.some((t) => t.minAmount === minAmount)) {
      toast.error("A tier with this min amount already exists");
      return;
    }

    const newTier = {
      minAmount,
      bonusAmount,
      label: `เติมครบ ${minAmount} รับโบนัส ${bonusAmount}`,
    };

    setBonusSettings((prev) => ({
      ...prev,
      tiers: [...prev.tiers, newTier].sort((a, b) => a.minAmount - b.minAmount),
    }));
    setNewTierInput({ minAmount: "", bonusAmount: "" });
    setBonusSettingsEdited(true);
    toast.success("Tier added successfully");
  };

  const handleRemoveTier = (index: number) => {
    setBonusSettings((prev) => ({
      ...prev,
      tiers: prev.tiers.filter((_, i) => i !== index),
    }));
    setBonusSettingsEdited(true);
  };

  const handleSaveBonusSettings = async () => {
    setBonusSettingsLoading(true);
    try {
      const result = await updateBonusConfigMutation.mutateAsync(bonusSettings);
      if (result.success) {
        toast.success("Bonus settings saved successfully!");
        setBonusSettingsEdited(false);
        getBonusConfigQuery.refetch();
      } else {
        toast.error("Failed to save bonus settings");
      }
    } catch (error: any) {
      console.error("Failed to save bonus settings:", error);
      toast.error(error?.message || "Failed to save bonus settings");
    } finally {
      setBonusSettingsLoading(false);
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
      <div className="space-y-6 max-w-3xl">
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

        {/* OCR Settings - Phase 4 (Single Source of Truth) */}
        <Card className="p-6 border-2 border-blue-200 bg-blue-50">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Info className="w-5 h-5 text-blue-600" />
            OCR Payment Slip Verification
          </h2>
          <div className="space-y-6">
            {/* Status Info */}
            {getOCRSettingsQuery.data && (
              <div className="p-3 bg-white rounded border border-blue-200 text-sm">
                <p className="text-gray-700">
                  <span className="font-medium">Source:</span> {getOCRSettingsQuery.data.source}
                  {getOCRSettingsQuery.data.environmentOverride && (
                    <span className="text-orange-600 ml-2">
                      (Environment override: {getOCRSettingsQuery.data.environmentOverride})
                    </span>
                  )}
                </p>
                {!getOCRSettingsQuery.data.canEdit && (
                  <p className="text-orange-600 mt-2">
                    ⚠️ OCR is hard-disabled by environment. Admin settings cannot override this.
                  </p>
                )}
              </div>
            )}

            {getOCRSettingsQuery.isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                <span>Loading OCR settings...</span>
              </div>
            ) : (
              <>
                {/* Enable OCR */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-base font-medium">OCR Enabled</Label>
                      <p className="text-sm text-gray-600 mt-1">
                        Enable OCR processing for payment slip uploads
                      </p>
                    </div>
                    <Switch
                      checked={ocrSettings.enabled}
                      onCheckedChange={(value) => handleOCRSettingChange("enabled", value)}
                      disabled={ocrSettingsLoading || !getOCRSettingsQuery.data?.canEdit}
                    />
                  </div>
                </div>

                {/* Auto Approval */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-base font-medium">Auto-Approval Enabled</Label>
                      <p className="text-sm text-gray-600 mt-1">
                        Allow high-confidence slips to be automatically approved
                      </p>
                    </div>
                    <Switch
                      checked={ocrSettings.autoApproveEnabled}
                      onCheckedChange={(value) => handleOCRSettingChange("autoApproveEnabled", value)}
                      disabled={ocrSettingsLoading || !getOCRSettingsQuery.data?.canEdit}
                    />
                  </div>
                </div>

                {/* Shadow Mode */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-base font-medium">Shadow Mode</Label>
                      <p className="text-sm text-gray-600 mt-1">
                        Run OCR but don't auto-approve (for testing/staging)
                      </p>
                    </div>
                    <Switch
                      checked={ocrSettings.shadowModeEnabled}
                      onCheckedChange={(value) => handleOCRSettingChange("shadowModeEnabled", value)}
                      disabled={ocrSettingsLoading || !getOCRSettingsQuery.data?.canEdit}
                    />
                  </div>
                </div>

                {/* Min Confidence */}
                <div className="space-y-2">
                  <Label className="text-base font-medium">Minimum Confidence Threshold (%)</Label>
                  <p className="text-sm text-gray-600 mb-2">
                    Minimum score required for auto-approval (0-100)
                  </p>
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    value={ocrSettings.minConfidence}
                    onChange={(e) => handleOCRSettingChange("minConfidence", parseInt(e.target.value) || 0)}
                    disabled={ocrSettingsLoading || !getOCRSettingsQuery.data?.canEdit}
                  />
                </div>

                {/* Max Time Window */}
                <div className="space-y-2">
                  <Label className="text-base font-medium">Maximum Time Window (minutes)</Label>
                  <p className="text-sm text-gray-600 mb-2">
                    Allowed time difference from order creation (1-1440 minutes)
                  </p>
                  <Input
                    type="number"
                    min="1"
                    max="1440"
                    value={ocrSettings.maxTimeWindowMinutes}
                    onChange={(e) => handleOCRSettingChange("maxTimeWindowMinutes", parseInt(e.target.value) || 120)}
                    disabled={ocrSettingsLoading || !getOCRSettingsQuery.data?.canEdit}
                  />
                </div>

                {/* Help Text */}
                <div className="p-4 bg-white rounded border border-blue-200 text-sm space-y-2">
                  <p className="font-medium text-gray-900">How it works:</p>
                  <ul className="list-disc list-inside space-y-1 text-gray-700">
                    <li><strong>OCR Enabled:</strong> Runs OCR when users upload payment slips</li>
                    <li><strong>Auto-Approval:</strong> Allows high-confidence slips to approve automatically</li>
                    <li><strong>Shadow Mode:</strong> Runs OCR but does not auto-approve (for testing)</li>
                    <li><strong>Min Confidence:</strong> Minimum score required for auto-approval</li>
                    <li><strong>Max Time Window:</strong> Allowed time difference from order creation/payment submission</li>
                  </ul>
                </div>

                {/* Save Button */}
                {ocrSettingsEdited && (
                  <Button
                    onClick={handleSaveOCRSettings}
                    disabled={ocrSettingsLoading || !getOCRSettingsQuery.data?.canEdit}
                    className="w-full bg-blue-600 hover:bg-blue-700"
                  >
                    {ocrSettingsLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Saving OCR Settings...
                      </>
                    ) : (
                      "Save OCR Settings"
                    )}
                  </Button>
                )}
              </>
            )}
          </div>
        </Card>

        {/* Wallet Top-up Bonus Settings */}
        <Card className="p-6 border-2 border-green-200 bg-green-50">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Info className="w-5 h-5 text-green-600" />
            Wallet Top-up Bonus Settings
          </h2>
          <div className="space-y-6">
            {getBonusConfigQuery.isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                <span>Loading bonus settings...</span>
              </div>
            ) : (
              <>
                {/* Enable Bonus */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-base font-medium">Bonus Enabled</Label>
                      <p className="text-sm text-gray-600 mt-1">
                        Enable wallet top-up bonus rewards
                      </p>
                    </div>
                    <Switch
                      checked={bonusSettings.enabled}
                      onCheckedChange={(value) => handleBonusSettingChange("enabled", value)}
                      disabled={bonusSettingsLoading}
                    />
                  </div>
                </div>

                {/* Bonus Tiers Editor */}
                <div className="space-y-3">
                  <Label className="text-base font-medium">Bonus Tiers</Label>
                  <p className="text-sm text-gray-600">
                    Configure tier thresholds for bonus rewards. Users get bonus based on top-up amount.
                  </p>

                  {/* Existing Tiers */}
                  <div className="space-y-2 bg-white p-4 rounded border border-green-200">
                    {bonusSettings.tiers.length === 0 ? (
                      <p className="text-gray-500 text-sm">No tiers configured</p>
                    ) : (
                      bonusSettings.tiers.map((tier, index) => (
                        <div
                          key={index}
                          className="flex items-center justify-between p-3 bg-green-50 rounded border border-green-200"
                        >
                          <div className="flex-1">
                            <p className="font-medium text-gray-900">
                              Tier {index + 1}: Min ฿{tier.minAmount} → Bonus ฿{tier.bonusAmount}
                            </p>
                            <p className="text-sm text-gray-600">{tier.label}</p>
                          </div>
                          <button
                            onClick={() => handleRemoveTier(index)}
                            disabled={bonusSettingsLoading || bonusSettings.tiers.length === 1}
                            className="ml-4 p-2 text-red-600 hover:bg-red-100 rounded disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  {/* Add New Tier */}
                  <div className="space-y-3 bg-white p-4 rounded border border-green-200">
                    <p className="text-sm font-medium text-gray-900">Add New Tier</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-sm">Min Amount (฿)</Label>
                        <Input
                          type="number"
                          placeholder="e.g., 300"
                          value={newTierInput.minAmount}
                          onChange={(e) => setNewTierInput({ ...newTierInput, minAmount: e.target.value })}
                          disabled={bonusSettingsLoading}
                          min="1"
                          step="1"
                        />
                      </div>
                      <div>
                        <Label className="text-sm">Bonus Amount (฿)</Label>
                        <Input
                          type="number"
                          placeholder="e.g., 15"
                          value={newTierInput.bonusAmount}
                          onChange={(e) => setNewTierInput({ ...newTierInput, bonusAmount: e.target.value })}
                          disabled={bonusSettingsLoading}
                          min="0"
                          step="1"
                        />
                      </div>
                    </div>
                    <Button
                      onClick={handleAddTier}
                      disabled={bonusSettingsLoading}
                      className="w-full bg-green-600 hover:bg-green-700"
                      variant="default"
                    >
                      Add Tier
                    </Button>
                  </div>
                </div>

                {/* Help Text */}
                <div className="p-4 bg-white rounded border border-green-200 text-sm space-y-2">
                  <p className="font-medium text-gray-900">How it works:</p>
                  <ul className="list-disc list-inside space-y-1 text-gray-700">
                    <li><strong>Bonus Enabled:</strong> Toggle wallet bonus rewards on/off</li>
                    <li><strong>Bonus Tiers:</strong> Define minimum amounts that trigger bonus rewards</li>
                    <li><strong>Examples:</strong> Min ฿250 → Bonus ฿10, Min ฿500 → Bonus ฿20</li>
                    <li><strong>Auto Labels:</strong> Thai labels are auto-generated based on amounts</li>
                  </ul>
                </div>

                {/* Save Button */}
                {bonusSettingsEdited && (
                  <Button
                    onClick={handleSaveBonusSettings}
                    disabled={bonusSettingsLoading}
                    className="w-full bg-green-600 hover:bg-green-700"
                  >
                    {bonusSettingsLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Saving Bonus Settings...
                      </>
                    ) : (
                      "Save Bonus Settings"
                    )}
                  </Button>
                )}
              </>
            )}
          </div>
        </Card>

        <DailyCheckinRolloutSection />

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

/**
 * Minimal Daily Check-in 1-point rollout control.
 *
 * Deliberately NOT a campaign-management UI: the reward is fixed at 1 point
 * per day and the only input is the Bangkok start date. Scheduling is what
 * flips the reward - a deploy on its own never does, because the server only
 * switches at Bangkok midnight on that date.
 */
function DailyCheckinRolloutSection() {
  const [startDate, setStartDate] = useState("");
  const statusQuery = trpc.admin.dailyCheckinRollout.status.useQuery();
  const utils = trpc.useUtils();

  const scheduleMutation = trpc.admin.dailyCheckinRollout.schedule.useMutation({
    onSuccess: (r) => {
      toast.success(r.alreadyScheduled ? "Rollout already scheduled for that date" : `Rollout scheduled for ${r.startDate}`);
      utils.admin.dailyCheckinRollout.status.invalidate();
      setStartDate("");
    },
    onError: (e) => toast.error(e.message),
  });

  const cancelMutation = trpc.admin.dailyCheckinRollout.cancel.useMutation({
    onSuccess: (r) => {
      toast.success(r.cancelled ? "Scheduled rollout cancelled" : "No scheduled rollout to cancel");
      utils.admin.dailyCheckinRollout.status.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const status = statusQuery.data;

  const modeLabel = (() => {
    if (!status) return "-";
    if (status.runtimeMode === "disabled") return "ปิดการเช็กอิน (disabled)";
    if (status.runtimeMode === "points") return "รับ 1 คะแนน (1 point)";
    if (status.scheduledStartDate) return "กำหนดเริ่มรับ 1 คะแนนแล้ว (scheduled)";
    return "คูปองแบบเดิม (legacy coupon)";
  })();

  const canCancel =
    !!status?.scheduledStartDate &&
    !status.hasPointGrants &&
    status.currentBangkokDate < status.scheduledStartDate;

  return (
    <Card className="p-6 border-2 border-amber-200 bg-amber-50">
      <h2 className="text-lg font-semibold mb-1">Daily Check-in — 1 Point Rollout</h2>
      <p className="text-sm text-slate-600 mb-4">
        Fixed at 1 point per day. Scheduling takes effect at Bangkok midnight on the chosen date — no redeploy needed.
      </p>

      {statusQuery.isLoading ? (
        <p className="text-sm text-slate-600">Loading…</p>
      ) : !status ? (
        <p className="text-sm text-red-600">Unable to load rollout status.</p>
      ) : (
        <>
          <div className="space-y-1 text-sm mb-4">
            <p><span className="font-semibold">Current mode:</span> {modeLabel}</p>
            <p><span className="font-semibold">Current Bangkok date:</span> {status.currentBangkokDate}</p>
            <p><span className="font-semibold">Scheduled start date:</span> {status.scheduledStartDate ?? "— not scheduled —"}</p>
            <p><span className="font-semibold">Reward:</span> 1 คะแนนต่อวัน ({status.pointsAmount} point/day)</p>
            <p><span className="font-semibold">Point rewards already granted:</span> {status.hasPointGrants ? "yes" : "no"}</p>
            <p>
              <span className="font-semibold">Global kill switch:</span>{" "}
              {status.killSwitchActive ? "check-in enabled" : "check-in DISABLED"}
            </p>
          </div>

          {!status.hasPointGrants && (
            <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
              <div className="flex-1">
                <Label htmlFor="checkin-rollout-date">Start date (Bangkok, must be a future date)</Label>
                <Input
                  id="checkin-rollout-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <Button
                disabled={!startDate || scheduleMutation.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Schedule the 1-point Daily Check-in reward to begin at Bangkok midnight on ${startDate}?\n\n` +
                        `Until then, legacy coupons continue. Existing coupons remain valid either way.`
                    )
                  ) {
                    scheduleMutation.mutate({ startDate });
                  }
                }}
              >
                {scheduleMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Schedule rollout
              </Button>
              {canCancel && (
                <Button
                  variant="outline"
                  disabled={cancelMutation.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Cancel the scheduled 1-point rollout?\n\n" +
                          "This is only possible because it has not started and no points have been granted. " +
                          "No historical data is deleted."
                      )
                    ) {
                      cancelMutation.mutate();
                    }
                  }}
                >
                  Cancel schedule
                </Button>
              )}
            </div>
          )}

          {status.hasPointGrants && (
            <p className="text-sm text-slate-700">
              Point rewards have already been granted. This rollout can no longer be rescheduled or cancelled — use the
              global Daily Check-in kill switch to stop new claims. Points already granted are never removed.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
