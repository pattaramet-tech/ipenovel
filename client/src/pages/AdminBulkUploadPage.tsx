import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { Download, Upload, CheckCircle, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import AdminLayout from "@/components/AdminLayout";
import { SectionHeader, EmptyState, FormSection } from "@/components/AdminComponents";

export default function AdminBulkUploadPage() {
  const { user, isAuthenticated } = useAuth();
  const [activeTab, setActiveTab] = useState("novels");
  const [uploadMode, setUploadMode] = useState<"manual" | "byTitle">("byTitle");
  const [novelCsvText, setNovelCsvText] = useState("");
  const [episodeCsvText, setEpisodeCsvText] = useState("");
  const [selectedNovelId, setSelectedNovelId] = useState<number | null>(null);
  const [novelPreview, setNovelPreview] = useState<Array<{ title: string }> | null>(null);
  const [episodePreview, setEpisodePreview] = useState<Array<any> | null>(null);

  // Queries
  const { data: novels } = trpc.admin.novels.list.useQuery(
    undefined,
    { enabled: !!user && user.role === "admin" }
  );

  // Mutations
  const bulkUploadNovelsMutation = trpc.admin.bulkUpload.novels.useMutation({
    onSuccess: (result) => {
      toast.success(`Created ${result.success.length} novels`);
      if (result.errors.length > 0) {
        toast.error(`${result.errors.length} rows had errors`);
      }
      setNovelCsvText("");
      setNovelPreview(null);
    },
    onError: () => {
      toast.error("Failed to upload novels");
    },
  });

  const bulkUploadEpisodesMutation = trpc.admin.bulkUpload.episodes.useMutation({
    onSuccess: (result) => {
      toast.success(`Created ${result.success.length} episodes`);
      if (result.errors.length > 0) {
        toast.error(`${result.errors.length} rows had errors`);
      }
      setEpisodeCsvText("");
      setEpisodePreview(null);
    },
    onError: () => {
      toast.error("Failed to upload episodes");
    },
  });

  const bulkUploadEpisodesWithNovelTitleMutation = trpc.admin.bulkUpload.episodesWithNovelTitle.useMutation({
    onSuccess: (result) => {
      toast.success(`Created ${result.success.length} episodes`);
      if (result.errors.length > 0) {
        toast.error(`${result.errors.length} rows had errors`);
      }
      setEpisodeCsvText("");
      setEpisodePreview(null);
    },
    onError: () => {
      toast.error("Failed to upload episodes");
    },
  });

  if (!isAuthenticated || user?.role !== "admin") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-slate-600 mb-4">Admin access required</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Parse CSV
  const parseCSV = (text: string): Array<Record<string, string>> => {
    const lines = text.trim().split("\n");
    if (lines.length < 2) return [];

    const headers = lines[0].split(",").map((h) => h.trim());
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(",").map((v) => v.trim());
      const row: Record<string, string> = {};
      headers.forEach((header, idx) => {
        row[header] = values[idx] || "";
      });
      rows.push(row);
    }

    return rows;
  };

  // Handle novel preview
  const handleNovelPreview = () => {
    const rows = parseCSV(novelCsvText);
    if (rows.length === 0) {
      toast.error("No valid rows found in CSV");
      return;
    }
    setNovelPreview(rows as any);
  };

  // Handle episode preview (manual mode)
  const handleEpisodePreview = () => {
    if (!selectedNovelId) {
      toast.error("Please select a novel first");
      return;
    }
    const rows = parseCSV(episodeCsvText);
    if (rows.length === 0) {
      toast.error("No valid rows found in CSV");
      return;
    }
    setEpisodePreview(rows as any);
  };

  // Handle episode preview (by title mode)
  const handleEpisodePreviewByTitle = () => {
    const rows = parseCSV(episodeCsvText);
    if (rows.length === 0) {
      toast.error("No valid rows found in CSV");
      return;
    }
    setEpisodePreview(rows as any);
  };

  // Download sample CSVs
  const downloadNovelSample = () => {
    const csv = "title\nMy First Novel\nAnother Great Novel";
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "novels-sample.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadEpisodeSample = () => {
    const csv = "title,price,episodeNumber,fileUrl\nEpisode 1,0,1,https://example.com/ep1.pdf\nEpisode 2,99,2,https://example.com/ep2.pdf";
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "episodes-sample.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadEpisodeWithNovelTitleSample = () => {
    const csv = "novelTitle,title,price,episodeNumber,fileUrl\nเกิดใหม่ที่โตเกียว ปี 1986,001 - 050,0,001 - 050,https://docs.google.com/...\nเกิดใหม่ที่โตเกียว ปี 1986,051 - 100,99,051 - 100,https://docs.google.com/...";
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "episodes-with-novel-title-sample.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AdminLayout>
      <div className="space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Bulk Upload</h1>
          <p className="text-slate-600 mt-1">Import novels and episodes in bulk using CSV files</p>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-2 lg:w-auto">
            <TabsTrigger value="novels">Novels</TabsTrigger>
            <TabsTrigger value="episodes">Episodes</TabsTrigger>
          </TabsList>

          {/* Novels Tab */}
          <TabsContent value="novels" className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <CardTitle>Novel Bulk Upload</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Instructions */}
                <FormSection title="Instructions">
                  <ul className="space-y-2 text-sm text-slate-700">
                    <li>• CSV must have a header row with column: <code className="bg-slate-100 px-2 py-1 rounded">title</code></li>
                    <li>• Each row creates one novel with the given title</li>
                    <li>• Slug is auto-generated from the title</li>
                    <li>• If slug conflicts, a unique suffix is added automatically</li>
                  </ul>
                </FormSection>

                {/* Download Sample */}
                <Button variant="outline" onClick={downloadNovelSample} className="w-full">
                  <Download className="w-4 h-4 mr-2" />
                  Download Sample CSV
                </Button>

                {/* CSV Input */}
                <div>
                  <label className="text-sm font-semibold text-slate-700 block mb-2">Paste CSV Content</label>
                  <textarea
                    value={novelCsvText}
                    onChange={(e) => setNovelCsvText(e.target.value)}
                    placeholder="title&#10;My First Novel&#10;Another Great Novel"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                    rows={8}
                  />
                </div>

                {/* Preview Button */}
                <Button onClick={handleNovelPreview} variant="outline" className="w-full">
                  Preview CSV
                </Button>

                {/* Preview */}
                {novelPreview && (
                  <div className="border border-slate-200 rounded-lg p-4 bg-slate-50">
                    <h3 className="font-semibold mb-3">Preview ({novelPreview.length} rows)</h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b">
                            <th className="text-left px-2 py-2">Title</th>
                          </tr>
                        </thead>
                        <tbody>
                          {novelPreview.map((row, idx) => (
                            <tr key={idx} className="border-b hover:bg-slate-100">
                              <td className="px-2 py-2">{row.title || <span className="text-red-500">Missing</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Upload Button */}
                    <Button
                      onClick={() => bulkUploadNovelsMutation.mutate({ rows: novelPreview })}
                      disabled={bulkUploadNovelsMutation.isPending}
                      className="w-full mt-4"
                    >
                      <Upload className="w-4 h-4 mr-2" />
                      Upload {novelPreview.length} Novels
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Episodes Tab */}
          <TabsContent value="episodes" className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <CardTitle>Episode Bulk Upload</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Upload Mode Selector */}
                <FormSection title="Upload Mode">
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="uploadMode"
                        value="byTitle"
                        checked={uploadMode === "byTitle"}
                        onChange={(e) => setUploadMode(e.target.value as "byTitle" | "manual")}
                        className="w-4 h-4"
                      />
                      <span className="text-sm">By Novel Title (Recommended)</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="uploadMode"
                        value="manual"
                        checked={uploadMode === "manual"}
                        onChange={(e) => setUploadMode(e.target.value as "byTitle" | "manual")}
                        className="w-4 h-4"
                      />
                      <span className="text-sm">Select Novel Manually</span>
                    </label>
                  </div>
                </FormSection>

                {uploadMode === "byTitle" ? (
                  <>
                    {/* Instructions */}
                    <FormSection title="Instructions">
                      <ul className="space-y-2 text-sm text-slate-700">
                        <li>• CSV must have headers: <code className="bg-slate-100 px-2 py-1 rounded">novelTitle,title,price,episodeNumber,fileUrl</code></li>
                        <li>• <strong>novelTitle</strong>: Name of the novel (must match exactly, case-insensitive)</li>
                        <li>• <strong>title</strong>: Episode title</li>
                        <li>• <strong>price</strong>: Use 0 for free episodes, or a number for paid episodes</li>
                        <li>• <strong>episodeNumber</strong>: Can be numeric (1, 2) or range format (1-10)</li>
                        <li>• <strong>fileUrl</strong>: Full URL to the episode file</li>
                        <li>• Free episodes (price=0) are immediately readable without purchase</li>
                      </ul>
                    </FormSection>

                    {/* Download Sample */}
                    <Button variant="outline" onClick={downloadEpisodeWithNovelTitleSample} className="w-full">
                      <Download className="w-4 h-4 mr-2" />
                      Download Sample CSV
                    </Button>

                    {/* CSV Input */}
                    <div>
                      <label className="text-sm font-semibold text-slate-700 block mb-2">Paste CSV Content</label>
                      <textarea
                        value={episodeCsvText}
                        onChange={(e) => setEpisodeCsvText(e.target.value)}
                        placeholder="novelTitle,title,price,episodeNumber,fileUrl&#10;My Novel,Episode 1,0,1,https://example.com/ep1.pdf"
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                        rows={8}
                      />
                    </div>

                    {/* Preview Button */}
                    <Button onClick={handleEpisodePreviewByTitle} variant="outline" className="w-full">
                      Preview CSV
                    </Button>

                    {/* Preview */}
                    {episodePreview && (
                      <div className="border border-slate-200 rounded-lg p-4 bg-slate-50">
                        <h3 className="font-semibold mb-3">Preview ({episodePreview.length} rows)</h3>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b">
                                <th className="text-left px-2 py-2">Novel Title</th>
                                <th className="text-left px-2 py-2">Episode Title</th>
                                <th className="text-left px-2 py-2">Episode #</th>
                                <th className="text-left px-2 py-2">Price</th>
                                <th className="text-left px-2 py-2">Type</th>
                              </tr>
                            </thead>
                            <tbody>
                              {episodePreview.map((row, idx) => {
                                const price = parseFloat(row.price);
                                const isFree = price === 0;
                                return (
                                  <tr key={idx} className="border-b hover:bg-slate-100">
                                    <td className="px-2 py-2">{row.novelTitle || <span className="text-red-500">Missing</span>}</td>
                                    <td className="px-2 py-2">{row.title || <span className="text-red-500">Missing</span>}</td>
                                    <td className="px-2 py-2">{row.episodeNumber || <span className="text-red-500">Missing</span>}</td>
                                    <td className="px-2 py-2">฿{row.price || <span className="text-red-500">Missing</span>}</td>
                                    <td className="px-2 py-2">
                                      {isFree ? (
                                        <Badge className="bg-green-100 text-green-800">Free</Badge>
                                      ) : (
                                        <Badge className="bg-blue-100 text-blue-800">Paid</Badge>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>

                        {/* Upload Button */}
                        <Button
                          onClick={() => bulkUploadEpisodesWithNovelTitleMutation.mutate({ rows: episodePreview })}
                          disabled={bulkUploadEpisodesWithNovelTitleMutation.isPending}
                          className="w-full mt-4"
                        >
                          <Upload className="w-4 h-4 mr-2" />
                          Upload {episodePreview.length} Episodes
                        </Button>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {/* Select Novel */}
                    <FormSection title="Select Novel">
                      <select
                        value={selectedNovelId || ""}
                        onChange={(e) => setSelectedNovelId(e.target.value ? parseInt(e.target.value) : null)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">-- Select a novel --</option>
                        {novels?.map((novel: any) => (
                          <option key={novel.id} value={novel.id}>
                            {novel.title}
                          </option>
                        ))}
                      </select>
                    </FormSection>

                    {/* Instructions */}
                    <FormSection title="Instructions">
                      <ul className="space-y-2 text-sm text-slate-700">
                        <li>• CSV must have headers: <code className="bg-slate-100 px-2 py-1 rounded">title,price,episodeNumber,fileUrl</code></li>
                        <li>• <strong>price</strong>: Use 0 for free episodes, or a number for paid episodes</li>
                        <li>• <strong>episodeNumber</strong>: Can be numeric (1, 2) or range format (1-10)</li>
                        <li>• <strong>fileUrl</strong>: Full URL to the episode file</li>
                        <li>• Free episodes (price=0) are immediately readable without purchase</li>
                      </ul>
                    </FormSection>

                    {/* Download Sample */}
                    <Button variant="outline" onClick={downloadEpisodeSample} className="w-full">
                      <Download className="w-4 h-4 mr-2" />
                      Download Sample CSV
                    </Button>

                    {/* CSV Input */}
                    <div>
                      <label className="text-sm font-semibold text-slate-700 block mb-2">Paste CSV Content</label>
                      <textarea
                        value={episodeCsvText}
                        onChange={(e) => setEpisodeCsvText(e.target.value)}
                        placeholder="title,price,episodeNumber,fileUrl&#10;Episode 1,0,1,https://example.com/ep1.pdf&#10;Episode 2,99,2,https://example.com/ep2.pdf"
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                        rows={8}
                      />
                    </div>

                    {/* Preview Button */}
                    <Button onClick={handleEpisodePreview} variant="outline" className="w-full" disabled={!selectedNovelId}>
                      Preview CSV
                    </Button>

                    {/* Preview */}
                    {episodePreview && (
                      <div className="border border-slate-200 rounded-lg p-4 bg-slate-50">
                        <h3 className="font-semibold mb-3">Preview ({episodePreview.length} rows)</h3>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b">
                                <th className="text-left px-2 py-2">Title</th>
                                <th className="text-left px-2 py-2">Episode #</th>
                                <th className="text-left px-2 py-2">Price</th>
                                <th className="text-left px-2 py-2">Type</th>
                              </tr>
                            </thead>
                            <tbody>
                              {episodePreview.map((row, idx) => {
                                const price = parseFloat(row.price);
                                const isFree = price === 0;
                                return (
                                  <tr key={idx} className="border-b hover:bg-slate-100">
                                    <td className="px-2 py-2">{row.title || <span className="text-red-500">Missing</span>}</td>
                                    <td className="px-2 py-2">{row.episodeNumber || <span className="text-red-500">Missing</span>}</td>
                                    <td className="px-2 py-2">฿{row.price || <span className="text-red-500">Missing</span>}</td>
                                    <td className="px-2 py-2">
                                      {isFree ? (
                                        <Badge className="bg-green-100 text-green-800">Free</Badge>
                                      ) : (
                                        <Badge className="bg-blue-100 text-blue-800">Paid</Badge>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>

                        {/* Upload Button */}
                        <Button
                          onClick={() =>
                            bulkUploadEpisodesMutation.mutate({
                              novelId: selectedNovelId!,
                              rows: episodePreview,
                            })
                          }
                          disabled={bulkUploadEpisodesMutation.isPending}
                          className="w-full mt-4"
                        >
                          <Upload className="w-4 h-4 mr-2" />
                          Upload {episodePreview.length} Episodes
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
}
