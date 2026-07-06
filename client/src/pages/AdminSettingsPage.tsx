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

  // Fetch Phase 4 OCR settings
  useEffect(() => {
    if (getOCRSettingsQuery.data?.settings) {
      setOcrSettings(getOCRSettingsQuery.data.settings);
      setOcrSettingsEdited(false);
    }
  }, [getOCRSettingsQuery.data]);

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
