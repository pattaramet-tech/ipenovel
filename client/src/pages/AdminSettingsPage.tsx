"use client";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
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

  // Move hooks to top level (React rule)
  const getOCRToggleQuery = trpc.admin.settings.getOCRToggle.useQuery();
  const setOCRToggleMutation = trpc.admin.settings.setOCRToggle.useMutation();

  // Fetch OCR status on mount
  useEffect(() => {
    if (getOCRToggleQuery.data) {
      setOcrStatus(getOCRToggleQuery.data);
      setOcrEnabled(getOCRToggleQuery.data?.ocrEnabled ?? true);
    }
  }, [getOCRToggleQuery.data]);

  const handleOCRToggle = async (enabled: boolean) => {
    setOcrLoading(true);
    try {
      const result = await setOCRToggleMutation.mutateAsync({ enabled });
      if (result.success) {
        setOcrEnabled(enabled);
        toast.success(`OCR ${enabled ? "enabled" : "disabled"} successfully`);
        // Refresh status
        getOCRToggleQuery.refetch();
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
                {getOCRToggleQuery.isLoading && (
                  <p className="text-xs text-gray-500 mt-2">Loading OCR settings...</p>
                )}
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
