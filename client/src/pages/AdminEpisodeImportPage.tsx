import AdminLayout from "@/components/AdminLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useState } from "react";
import { Upload, Loader2, AlertCircle } from "lucide-react";

interface ParsedEpisode {
  episodeNumber: string;
  episodeTitle: string;
  price?: string;
  isFree?: boolean;
  isPublished?: boolean;
  content?: string;
  sortOrder?: number;
}

interface ValidationError {
  row: number;
  field: string;
  message: string;
}

export default function AdminEpisodeImportPage() {
  const [novelId, setNovelId] = useState<number | undefined>();
  const [csvText, setCsvText] = useState("");
  const [parsedEpisodes, setParsedEpisodes] = useState<ParsedEpisode[]>([]);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [importMode, setImportMode] = useState<"create_only" | "update_existing" | "skip_duplicates">("skip_duplicates");
  const [importing, setImporting] = useState(false);

  const { data: novels } = trpc.novels.list.useQuery();
  const { data: episodes } = trpc.admin.getAllEpisodes.useQuery();

  const createMutation = trpc.admin.episodes.create.useMutation();
  const updateMutation = trpc.admin.episodes.update.useMutation();

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const csv = event.target?.result as string;
      setCsvText(csv);
      parseCSV(csv);
    };
    reader.readAsText(file);
  };

  // Simple but robust CSV parser that handles quoted fields
  const parseCSVLine = (line: string): string[] => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          current += '"';
          i++; // Skip next quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }

    result.push(current.trim());
    return result;
  };

  const parseCSV = (csv: string) => {
    const lines = csv.split("\n").filter((line) => line.trim());
    if (lines.length < 2) {
      toast.error("CSV must have header and at least one row");
      return;
    }

    const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase());
    const episodes: ParsedEpisode[] = [];
    const errors: ValidationError[] = [];

    // Expected columns
    const episodeNumberIdx = headers.indexOf("episodenumber");
    const titleIdx = headers.indexOf("episodetitle") !== -1 ? headers.indexOf("episodetitle") : headers.indexOf("title");
    const priceIdx = headers.indexOf("price");
    const isFreeIdx = headers.indexOf("isfree");
    const isPublishedIdx = headers.indexOf("ispublished");
    const contentIdx = headers.indexOf("content");
    const sortOrderIdx = headers.indexOf("sortorder");

    for (let i = 1; i < lines.length; i++) {
      const row = i + 1;
      const cols = parseCSVLine(lines[i]);

      const episodeNumber = episodeNumberIdx >= 0 && cols[episodeNumberIdx] ? cols[episodeNumberIdx] : "";
      const title = titleIdx >= 0 && cols[titleIdx] ? cols[titleIdx] : "";
      const priceStr = priceIdx >= 0 && cols[priceIdx] ? cols[priceIdx] : "0";
      const price = isNaN(parseFloat(priceStr)) ? "0" : priceStr;
      const isFree = isFreeIdx >= 0 && cols[isFreeIdx] ? cols[isFreeIdx].toLowerCase() === "true" : false;
      const isPublished = isPublishedIdx >= 0 && cols[isPublishedIdx] ? cols[isPublishedIdx].toLowerCase() !== "false" : true;
      const content = contentIdx >= 0 && cols[contentIdx] ? cols[contentIdx] : "";
      const sortOrderIdx_ = sortOrderIdx >= 0 && cols[sortOrderIdx] ? parseInt(cols[sortOrderIdx], 10) : undefined;
      const sortOrder = !isNaN(sortOrderIdx_ || NaN) ? sortOrderIdx_ : undefined;

      // Validation
      if (!episodeNumber) {
        errors.push({
          row,
          field: "episodeNumber",
          message: "Episode number is required",
        });
        continue;
      }

      if (!title) {
        errors.push({
          row,
          field: "title",
          message: "Episode title is required",
        });
        continue;
      }

      if (!isFree && (!price || parseFloat(price) <= 0)) {
        errors.push({
          row,
          field: "price",
          message: "Paid episodes must have a price > 0",
        });
        continue;
      }

      episodes.push({
        episodeNumber,
        episodeTitle: title,
        price,
        isFree,
        isPublished,
        content,
        sortOrder,
      });
    }

    setParsedEpisodes(episodes);
    setValidationErrors(errors);

    if (errors.length > 0) {
      toast.error(`Found ${errors.length} validation error(s)`);
    } else if (episodes.length > 0) {
      toast.success(`Parsed ${episodes.length} episodes`);
    }
  };

  const handleImport = async () => {
    if (!novelId) {
      toast.error("Please select a novel");
      return;
    }

    if (parsedEpisodes.length === 0) {
      toast.error("No episodes to import");
      return;
    }

    setImporting(true);
    let successCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    const existingEpisodes = (episodes || []).filter((e: any) => e.novelId === novelId);

    for (const ep of parsedEpisodes) {
      try {
        const existing = existingEpisodes.find(
          (e: any) => e.episodeNumber === ep.episodeNumber
        );

        // Skip logic based on import mode
        if (existing) {
          if (importMode === "skip_duplicates") {
            skippedCount++;
            continue;
          } else if (importMode === "create_only") {
            skippedCount++;
            continue;
          } else if (importMode === "update_existing") {
            // Update existing
            await updateMutation.mutateAsync({
              episodeId: existing.id,
              title: ep.episodeTitle,
              price: ep.price,
              isFree: ep.isFree,
              isPublished: ep.isPublished,
              content: ep.content,
              sortOrder: ep.sortOrder,
            });
            successCount++;
            continue;
          }
        }

        // Create new
        await createMutation.mutateAsync({
          novelId,
          episodeNumber: ep.episodeNumber,
          title: ep.episodeTitle,
          price: ep.price || "0",
          isFree: ep.isFree,
          content: ep.content,
          isPublished: ep.isPublished,
          sortOrder: ep.sortOrder,
        });
        successCount++;
      } catch (error) {
        console.error("Import error:", error);
        errorCount++;
      }
    }

    setImporting(false);
    toast.success(
      `Import complete: ${successCount} created, ${skippedCount} skipped, ${errorCount} errors`
    );

    // Reset form
    setCsvText("");
    setParsedEpisodes([]);
    setValidationErrors([]);
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Import Episodes</h1>
          <p className="text-slate-600 mt-2">Bulk import episodes from CSV file</p>
        </div>

        {/* Novel Selection */}
        <Card className="p-4">
          <Label>Select Novel</Label>
          <select
            value={novelId || ""}
            onChange={(e) => setNovelId(e.target.value ? parseInt(e.target.value) : undefined)}
            className="w-full px-3 py-2 border rounded-md mt-2"
          >
            <option value="">-- Select a novel --</option>
            {novels?.map((novel: any) => (
              <option key={novel.id} value={novel.id}>
                {novel.title}
              </option>
            ))}
          </select>
        </Card>

        {/* CSV Upload */}
        <Card className="p-6">
          <h3 className="font-semibold mb-4">Step 1: Upload CSV File</h3>
          <div className="border-2 border-dashed rounded-lg p-6 text-center">
            <input
              type="file"
              accept=".csv"
              onChange={handleFileUpload}
              className="hidden"
              id="csv-upload"
            />
            <label htmlFor="csv-upload" className="cursor-pointer">
              <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm text-slate-600">
                Click to upload or drag & drop CSV file
              </p>
            </label>
          </div>

          <div className="mt-4 text-xs text-slate-500">
            <p className="font-semibold mb-2">Required columns:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>episodeNumber (e.g., "001", "1 - 5")</li>
              <li>episodeTitle (e.g., "The Beginning")</li>
            </ul>
            <p className="font-semibold mt-3 mb-2">Optional columns:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>price (decimal, default: 0)</li>
              <li>isFree (true/false, default: false)</li>
              <li>isPublished (true/false, default: true)</li>
              <li>content (episode text)</li>
              <li>sortOrder (number)</li>
            </ul>
          </div>
        </Card>

        {/* Validation Errors */}
        {validationErrors.length > 0 && (
          <Card className="p-4 bg-red-50 border-red-200">
            <div className="flex gap-3">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="font-semibold text-red-900 mb-2">Validation Errors</h4>
                <div className="space-y-1 text-sm text-red-800">
                  {validationErrors.map((err, idx) => (
                    <p key={idx}>
                      Row {err.row}: {err.field} - {err.message}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          </Card>
        )}

        {/* Preview */}
        {parsedEpisodes.length > 0 && (
          <Card className="p-4">
            <h3 className="font-semibold mb-4">Step 2: Preview Episodes</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 px-2">Episode #</th>
                    <th className="text-left py-2 px-2">Title</th>
                    <th className="text-left py-2 px-2">Price</th>
                    <th className="text-left py-2 px-2">Free</th>
                    <th className="text-left py-2 px-2">Content</th>
                  </tr>
                </thead>
                <tbody>
                  {parsedEpisodes.slice(0, 10).map((ep, idx) => (
                    <tr key={idx} className="border-b hover:bg-slate-50">
                      <td className="py-2 px-2">{ep.episodeNumber}</td>
                      <td className="py-2 px-2">{ep.episodeTitle}</td>
                      <td className="py-2 px-2">฿{ep.price || "0"}</td>
                      <td className="py-2 px-2">
                        {ep.isFree ? (
                          <Badge variant="secondary" className="text-xs">
                            Free
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2 px-2">
                        {ep.content ? (
                          <Badge variant="outline" className="text-xs">
                            ✓ {ep.content.length} chars
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsedEpisodes.length > 10 && (
                <p className="text-xs text-muted-foreground mt-2">
                  ... and {parsedEpisodes.length - 10} more episodes
                </p>
              )}
            </div>

            {/* Import Mode Selection */}
            <div className="mt-6 pt-6 border-t space-y-3">
              <h4 className="font-semibold text-sm">Step 3: Import Options</h4>
              <div className="space-y-2">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    value="skip_duplicates"
                    checked={importMode === "skip_duplicates"}
                    onChange={(e) => setImportMode(e.target.value as any)}
                  />
                  <span className="text-sm">Skip duplicate episodes (recommended)</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    value="create_only"
                    checked={importMode === "create_only"}
                    onChange={(e) => setImportMode(e.target.value as any)}
                  />
                  <span className="text-sm">Create only new episodes</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    value="update_existing"
                    checked={importMode === "update_existing"}
                    onChange={(e) => setImportMode(e.target.value as any)}
                  />
                  <span className="text-sm">Update existing episodes</span>
                </label>
              </div>
            </div>

            {/* Import Button */}
            <Button
              onClick={handleImport}
              disabled={importing || !novelId || parsedEpisodes.length === 0}
              className="w-full mt-6"
            >
              {importing ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Importing...
                </>
              ) : (
                `Import ${parsedEpisodes.length} Episodes`
              )}
            </Button>
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
