import AdminLayout from "@/components/AdminLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useState } from "react";
import { Upload, Loader2, AlertCircle, Download } from "lucide-react";
import * as XLSX from "xlsx";

interface ParsedEpisode {
  episodeNumber: string;
  episodeTitle: string;
  price?: string;
  isFree?: boolean;
  isPublished?: boolean;
  content?: string;
  contentFormat?: "plain_text" | "markdown" | "html";
  description?: string;
  fileUrl?: string;
  sortOrder?: number;
  // "chapter" = single episode, direct wallet purchase. "package" =
  // multi-chapter bundle, cart/checkout, web-read only (no download).
  saleMode: "chapter" | "package";
}

interface ValidationError {
  row: number;
  field: string;
  message: string;
}

// Header name aliases (English and Thai)
const HEADER_ALIASES: Record<string, string> = {
  // episodeNumber
  episodenumber: "episodeNumber",
  episode_number: "episodeNumber",
  episodeno: "episodeNumber",
  "ตอนที่": "episodeNumber",

  // episodeTitle
  episodetitle: "episodeTitle",
  title: "episodeTitle",
  episode_title: "episodeTitle",
  "ชื่อตอน": "episodeTitle",

  // price
  price: "price",
  "ราคา": "price",

  // isFree
  isfree: "isFree",
  "ฟรี": "isFree",

  // isPublished
  ispublished: "isPublished",
  "เผยแพร่": "isPublished",

  // content
  content: "content",
  "เนื้อหา": "content",

  // sortOrder
  sortorder: "sortOrder",
  "ลำดับ": "sortOrder",

  // contentFormat
  contentformat: "contentFormat",
  "รูปแบบเนื้อหา": "contentFormat",

  // description
  description: "description",
  "คำอธิบาย": "description",

  // fileUrl
  fileurl: "fileUrl",
  "ลิงก์ไฟล์": "fileUrl",

  // saleMode
  salemode: "saleMode",
  sale_mode: "saleMode",
  "ประเภทการขาย": "saleMode",
  "ประเภท": "saleMode",
};

// Range-style episodeNumber like "1 - 50" or "436 - 508" - matches the
// backend's legacy saleMode fallback (resolveSaleMode in readerService.ts)
// so imports without an explicit saleMode column classify consistently with
// how the reader/store already treat existing rows.
const RANGE_EPISODE_NUMBER_PATTERN = /^\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*$/;

const SALE_MODE_VALUE_ALIASES: Record<string, "chapter" | "package"> = {
  chapter: "chapter",
  "รายบท": "chapter",
  package: "package",
  "แพ็ก": "package",
  "แพ็กอ่านบนเว็บ": "package",
};

// Resolve a row's saleMode: explicit column value first (accepts English or
// Thai labels), otherwise fall back to legacy detection - a fileUrl or a
// range-style episodeNumber implies "package", everything else is "chapter".
// This mirrors resolveSaleMode() on the backend so imported data and
// backend-computed fallbacks never disagree.
const resolveImportSaleMode = (
  rawValue: string | undefined,
  episodeNumber: string,
  fileUrl: string
): "chapter" | "package" => {
  const normalized = (rawValue || "").toLowerCase().trim();
  const aliased = SALE_MODE_VALUE_ALIASES[normalized];
  if (aliased) return aliased;

  if (fileUrl && fileUrl.trim().length > 0) return "package";
  if (RANGE_EPISODE_NUMBER_PATTERN.test(episodeNumber)) return "package";
  return "chapter";
};

// Parse boolean values from various formats
const parseBoolean = (value: string | boolean | undefined, defaultValue: boolean): boolean => {
  if (typeof value === "boolean") return value;
  if (!value) return defaultValue;

  const str = String(value).toLowerCase().trim();
  return [
    "true",
    "yes",
    "y",
    "1",
    "ฟรี",
    "เผยแพร่",
    "published",
    "enable",
    "enabled",
  ].includes(str);
};

// Normalize header name to match our field names
const normalizeHeader = (header: string): string => {
  const cleaned = header.toLowerCase().trim();
  return HEADER_ALIASES[cleaned] || cleaned;
};

// Parse CSV with quoted field support
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
        i++;
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

// Parse CSV file
const parseCSVData = (csv: string): Array<Record<string, string>> => {
  const lines = csv.split("\n").filter((line) => line.trim());
  if (lines.length < 2) {
    toast.error("CSV must have header and at least one row");
    return [];
  }

  const headerLine = parseCSVLine(lines[0]);
  const normalizedHeaders = headerLine.map(normalizeHeader);

  const result: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};

    for (let j = 0; j < normalizedHeaders.length; j++) {
      if (normalizedHeaders[j] && cols[j]) {
        row[normalizedHeaders[j]] = cols[j];
      }
    }

    if (Object.keys(row).length > 0) {
      result.push(row);
    }
  }

  return result;
};

// Parse XLSX file
const parseXLSXData = (arrayBuffer: ArrayBuffer): Array<Record<string, string>> => {
  try {
    const workbook = XLSX.read(arrayBuffer, { type: "array" });
    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) {
      toast.error("XLSX file has no sheets");
      return [];
    }

    const worksheet = workbook.Sheets[firstSheet];
    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      blankrows: false,
    }) as (string | number | boolean)[][];

    if (jsonData.length < 2) {
      toast.error("XLSX must have header and at least one row");
      return [];
    }

    const headerRow = jsonData[0].map((h) =>
      normalizeHeader(String(h || ""))
    );

    const result: Array<Record<string, string>> = [];
    for (let i = 1; i < jsonData.length; i++) {
      const row: Record<string, string> = {};
      const rowData = jsonData[i];

      for (let j = 0; j < headerRow.length; j++) {
        if (headerRow[j] && rowData[j] != null && rowData[j] !== "") {
          row[headerRow[j]] = String(rowData[j]);
        }
      }

      if (Object.keys(row).length > 0) {
        result.push(row);
      }
    }

    return result;
  } catch (error) {
    console.error("XLSX parse error:", error);
    toast.error("Failed to parse XLSX file");
    return [];
  }
};

// Convert raw data to ParsedEpisode with validation
const convertToParsedEpisodes = (
  rawData: Array<Record<string, string>>
): { episodes: ParsedEpisode[]; errors: ValidationError[] } => {
  const episodes: ParsedEpisode[] = [];
  const errors: ValidationError[] = [];
  const seenNumbers = new Set<string>();

  for (let i = 0; i < rawData.length; i++) {
    const row = i + 2; // +1 for header, +1 for 1-based indexing
    const data = rawData[i];

    const episodeNumber = data.episodeNumber || "";
    const episodeTitle = data.episodeTitle || "";
    const priceStr = data.price || "0";
    const isFree = parseBoolean(data.isFree, false);
    const isPublished = parseBoolean(data.isPublished, true);
    const content = data.content || "";
    // Validate contentFormat is one of allowed values
    const validFormats = ["plain_text", "markdown", "html"];
    const contentFormat = (
      validFormats.includes((data.contentFormat || "").toLowerCase())
        ? data.contentFormat
        : "plain_text"
    ) as "plain_text" | "markdown" | "html";
    const description = data.description || "";
    const fileUrl = data.fileUrl || "";
    const sortOrderStr = data.sortOrder || "";
    const saleMode = resolveImportSaleMode(data.saleMode, episodeNumber, fileUrl);

    // Validate required fields
    if (!episodeNumber) {
      errors.push({
        row,
        field: "episodeNumber",
        message: "Episode number is required",
      });
      continue;
    }

    if (!episodeTitle) {
      errors.push({
        row,
        field: "episodeTitle",
        message: "Episode title is required",
      });
      continue;
    }

    // Validate price
    const price = isNaN(parseFloat(priceStr)) ? "0" : priceStr;
    if (!isFree && (!price || parseFloat(price) <= 0)) {
      errors.push({
        row,
        field: "price",
        message: "Paid episodes must have a price > 0",
      });
      continue;
    }

    // Check for duplicates in file
    if (seenNumbers.has(episodeNumber)) {
      errors.push({
        row,
        field: "episodeNumber",
        message: `Duplicate episode number "${episodeNumber}" in file`,
      });
      continue;
    }
    seenNumbers.add(episodeNumber);

    // Parse sortOrder
    let sortOrder: number | undefined;
    if (sortOrderStr) {
      const parsed = parseInt(sortOrderStr, 10);
      if (!isNaN(parsed)) {
        sortOrder = parsed;
      }
    } else {
      // Auto-fill sortOrder from episodeNumber if it's numeric
      const numericEp = parseInt(episodeNumber, 10);
      if (!isNaN(numericEp) && numericEp > 0) {
        sortOrder = numericEp;
      }
    }

    episodes.push({
      episodeNumber,
      episodeTitle,
      price,
      isFree,
      isPublished,
      content,
      contentFormat,
      description,
      fileUrl,
      sortOrder,
      saleMode,
    });
  }

  return { episodes, errors };
};

// Generate XLSX template
const generateXLSXTemplate = () => {
  const templateData = [
    {
      episodeNumber: "001",
      episodeTitle: "ตอนที่ 1 เริ่มต้น",
      saleMode: "chapter",
      price: "0",
      isFree: "true",
      isPublished: "true",
      content: "เนื้อหาตอนที่ 1...",
      contentFormat: "plain_text",
      description: "ตอนเปิดฟรี",
      fileUrl: "",
    },
    {
      episodeNumber: "002",
      episodeTitle: "ตอนที่ 2 เงื่อนไข",
      saleMode: "chapter",
      price: "5",
      isFree: "false",
      isPublished: "true",
      content: "เนื้อหาตอนที่ 2...",
      contentFormat: "plain_text",
      description: "ตอนขาย",
      fileUrl: "",
    },
    {
      episodeNumber: "1 - 50",
      episodeTitle: "แพ็กบทที่ 1 - 50",
      saleMode: "package",
      price: "99",
      isFree: "false",
      isPublished: "true",
      content: "เนื้อหารวมบทที่ 1 ถึง 50...",
      contentFormat: "plain_text",
      description: "แพ็กอ่านบนเว็บ",
      fileUrl: "",
    },
  ];

  const worksheet = XLSX.utils.json_to_sheet(templateData);
  worksheet["!cols"] = [
    { wch: 12 },
    { wch: 25 },
    { wch: 12 },
    { wch: 10 },
    { wch: 10 },
    { wch: 12 },
    { wch: 30 },
    { wch: 15 },
    { wch: 20 },
    { wch: 25 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Episodes");
  XLSX.writeFile(workbook, "episode_template.xlsx");
  toast.success("Template downloaded!");
};

// Read a File as a base64 data URL string (browser-side), for sending
// binary uploads (zip) through a tRPC mutation as a plain string - mirrors
// the fileBase64 pattern already used elsewhere in this project (e.g.
// payment slip uploads).
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Import a large "package" (multi-chapter, web-read-only) episode set from a
// ZIP: manifest.xlsx/manifest.csv for metadata + separate .txt files for
// content, so a 50-100 chapter package never has to fit in a single xlsx
// cell. Validates via a dryRun call first (Step 2 preview) before the admin
// confirms the real import (Step 3).
function PackageZipImportSection({ novelId }: { novelId: number | undefined }) {
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"create_only" | "upsert">("upsert");
  const [preview, setPreview] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const importMutation = trpc.admin.episodes.importPackageZip.useMutation();

  const handleZipUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      toast.error("กรุณาอัปโหลดไฟล์ .zip เท่านั้น");
      return;
    }
    setZipFile(file);
    setPreview(null);
    setResult(null);
  };

  const handleValidate = async () => {
    if (!novelId) {
      toast.error("กรุณาเลือกนิยายก่อน");
      return;
    }
    if (!zipFile) {
      toast.error("กรุณาอัปโหลดไฟล์ zip ก่อน");
      return;
    }

    setIsValidating(true);
    setResult(null);
    try {
      const zipBase64 = await readFileAsBase64(zipFile);
      const response = await importMutation.mutateAsync({ novelId, zipBase64, mode, dryRun: true });
      setPreview(response);
      if (response.errorCount > 0) {
        toast.error(`พบ ${response.errorCount} แถวที่มีปัญหา`);
      } else {
        toast.success(`ตรวจสอบผ่าน ${response.validRows} แพ็ก พร้อม import`);
      }
    } catch (error: any) {
      toast.error(error?.message || "ตรวจสอบไฟล์ล้มเหลว");
    } finally {
      setIsValidating(false);
    }
  };

  const handleConfirmImport = async () => {
    if (!novelId || !zipFile) return;

    setIsImporting(true);
    try {
      const zipBase64 = await readFileAsBase64(zipFile);
      const response = await importMutation.mutateAsync({ novelId, zipBase64, mode, dryRun: false });
      setResult(response);
      setPreview(null);
      toast.success(`Import complete: ${response.successCount} สำเร็จ, ${response.errorCount} error`);
    } catch (error: any) {
      toast.error(error?.message || "Import ล้มเหลว");
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <>
      <Card className="p-6">
        <h3 className="font-semibold mb-2">Step 1: Upload Package ZIP</h3>
        <p className="text-sm text-slate-600 mb-4">
          อัปโหลด zip ที่มี manifest.xlsx/manifest.csv และไฟล์ .txt แยกตามแพ็ก สำหรับนำเข้าแพ็กอ่านบนเว็บ
        </p>

        <div className="border-2 border-dashed rounded-lg p-6 text-center">
          <input
            type="file"
            accept=".zip"
            onChange={handleZipUpload}
            className="hidden"
            id="zip-upload"
          />
          <label htmlFor="zip-upload" className="cursor-pointer">
            <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
            <p className="text-sm text-slate-600">
              {zipFile ? zipFile.name : "คลิกเพื่ออัปโหลดไฟล์ .zip"}
            </p>
          </label>
        </div>

        <div className="mt-4 text-xs text-slate-500 space-y-2">
          <p className="font-semibold">โครงสร้าง zip ที่รองรับ:</p>
          <pre className="bg-slate-50 p-2 rounded border overflow-x-auto whitespace-pre">{`import_package.zip
├── manifest.xlsx (หรือ manifest.csv)
└── contents/
    ├── 001-050.txt
    └── 051-100.txt`}</pre>
          <p className="font-semibold">Manifest columns:</p>
          <p>
            episodeNumber, episodeTitle, price, isFree, isPublished, saleMode,
            contentFile, contentFormat, sortOrder, description
          </p>
          <p>saleMode ควรเป็น package เสมอ - import นี้รองรับเฉพาะแพ็กอ่านบนเว็บ ไม่รองรับรายบท</p>
        </div>

        <div className="mt-4">
          <Label className="mb-2 block">Import Mode</Label>
          <div className="space-y-2">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={mode === "upsert"}
                onChange={() => setMode("upsert")}
              />
              <span className="text-sm">
                แนะนำ: Sync/Upsert - ถ้าแพ็กเลขเดิมมีอยู่แล้ว ระบบจะเติมเนื้อหาเข้าแพ็กเดิม
                เพื่อรักษาสิทธิ์ลูกค้าที่ซื้อไว้ (คงไฟล์เดิมและ episodeId เดิม)
              </span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={mode === "create_only"}
                onChange={() => setMode("create_only")}
              />
              <span className="text-sm">Create only - ใช้เมื่อมั่นใจว่าไม่มีแพ็กเลขนี้อยู่แล้ว (ถ้าซ้ำ จะขึ้น error)</span>
            </label>
          </div>
        </div>

        <Button
          onClick={handleValidate}
          disabled={!novelId || !zipFile || isValidating}
          className="w-full mt-6"
        >
          {isValidating ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              กำลังตรวจสอบ...
            </>
          ) : (
            "ตรวจสอบไฟล์ (Preview)"
          )}
        </Button>
      </Card>

      {preview && (
        <Card className="p-4">
          <h3 className="font-semibold mb-4">Step 2: Preview</h3>
          <div className="grid grid-cols-3 gap-4 mb-4 text-center">
            <div>
              <p className="text-2xl font-bold">{preview.totalRows}</p>
              <p className="text-xs text-muted-foreground">ทั้งหมด</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-green-600">{preview.validRows}</p>
              <p className="text-xs text-muted-foreground">พร้อม import</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-red-600">{preview.errorCount}</p>
              <p className="text-xs text-muted-foreground">Error</p>
            </div>
          </div>

          {preview.errors.length > 0 && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded max-h-40 overflow-y-auto">
              {preview.errors.map((err: any, idx: number) => (
                <p key={idx} className="text-sm text-red-800">
                  Row {err.row}: {err.field} - {err.message}
                </p>
              ))}
            </div>
          )}

          {preview.rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-slate-50">
                    <th className="text-left py-2 px-2">#</th>
                    <th className="text-left py-2 px-2">Episode #</th>
                    <th className="text-left py-2 px-2">Title</th>
                    <th className="text-left py-2 px-2">Content File</th>
                    <th className="text-left py-2 px-2">Content Length</th>
                    <th className="text-left py-2 px-2">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 15).map((row: any, idx: number) => (
                    <tr key={idx} className="border-b hover:bg-slate-50">
                      <td className="py-2 px-2 text-muted-foreground">{idx + 1}</td>
                      <td className="py-2 px-2 font-medium">{row.episodeNumber}</td>
                      <td className="py-2 px-2">{row.episodeTitle}</td>
                      <td className="py-2 px-2 text-muted-foreground">{row.contentFile}</td>
                      <td className="py-2 px-2">{row.contentLength.toLocaleString()} chars</td>
                      <td className="py-2 px-2">฿{row.price}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.rows.length > 15 && (
                <p className="text-xs text-muted-foreground mt-2">
                  ... และอีก {preview.rows.length - 15} แพ็ก
                </p>
              )}
            </div>
          )}

          <Button
            onClick={handleConfirmImport}
            disabled={preview.validRows === 0 || isImporting}
            className="w-full mt-6"
          >
            {isImporting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                กำลัง Import...
              </>
            ) : (
              `Import ${preview.validRows} แพ็ก`
            )}
          </Button>
        </Card>
      )}

      {result && (
        <Card className="p-4 bg-green-50 border-green-200">
          <h3 className="font-semibold mb-2">Import เสร็จสิ้น</h3>
          <p className="text-sm">
            ทั้งหมด {result.totalRows} แถว · สำเร็จ {result.successCount} · error {result.errorCount}
          </p>
          <p className="text-sm mt-1">
            สร้างใหม่ {result.createdCount ?? 0} · อัปเดตแพ็กเดิม {result.updatedCount ?? 0} ·
            คงไฟล์เดิมไว้ {result.preservedFileUrlCount ?? 0}
          </p>
          {result.results?.length > 0 && (
            <div className="mt-3 p-3 bg-white border rounded max-h-48 overflow-y-auto">
              {result.results.map((r: any, idx: number) => (
                <p key={idx} className="text-sm text-slate-700">
                  {r.message}
                </p>
              ))}
            </div>
          )}
          {result.errors.length > 0 && (
            <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded max-h-40 overflow-y-auto">
              {result.errors.map((err: any, idx: number) => (
                <p key={idx} className="text-sm text-red-800">
                  Row {err.row}: {err.field} - {err.message}
                </p>
              ))}
            </div>
          )}
        </Card>
      )}
    </>
  );
}

export default function AdminEpisodeImportPage() {
  const [importSource, setImportSource] = useState<"spreadsheet" | "zip">("spreadsheet");
  const [novelId, setNovelId] = useState<number | undefined>();
  const [fileText, setFileText] = useState("");
  const [parsedEpisodes, setParsedEpisodes] = useState<ParsedEpisode[]>([]);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>(
    []
  );
  const [importMode, setImportMode] = useState<
    "create_only" | "update_existing" | "skip_duplicates"
  >("skip_duplicates");
  const [allowBlankOverwrite, setAllowBlankOverwrite] = useState(false);
  const [importing, setImporting] = useState(false);
  const [fileType, setFileType] = useState<"csv" | "xlsx">("csv");

  const { data: novels } = trpc.novels.list.useQuery();
  const { data: episodes } = trpc.admin.getAllEpisodes.useQuery();

  const createMutation = trpc.admin.episodes.create.useMutation();
  const updateMutation = trpc.admin.episodes.update.useMutation();

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const isCsv = file.name.endsWith(".csv");
    const isXlsx =
      file.name.endsWith(".xlsx") ||
      file.name.endsWith(".xls") ||
      file.type.includes("spreadsheet");

    if (isCsv) {
      setFileType("csv");
      const reader = new FileReader();
      reader.onload = (event) => {
        const csv = event.target?.result as string;
        setFileText(csv);
        parseFile(csv, "csv");
      };
      reader.readAsText(file);
    } else if (isXlsx) {
      setFileType("xlsx");
      const reader = new FileReader();
      reader.onload = (event) => {
        const buffer = event.target?.result as ArrayBuffer;
        parseFile(buffer, "xlsx");
      };
      reader.readAsArrayBuffer(file);
    } else {
      toast.error("Please upload a CSV or XLSX file");
    }
  };

  const parseFile = (data: string | ArrayBuffer, type: "csv" | "xlsx") => {
    let rawData: Array<Record<string, string>> = [];

    if (type === "csv") {
      rawData = parseCSVData(data as string);
    } else if (type === "xlsx") {
      rawData = parseXLSXData(data as ArrayBuffer);
    }

    if (rawData.length === 0) {
      setValidationErrors([]);
      setParsedEpisodes([]);
      return;
    }

    const { episodes: parsed, errors } = convertToParsedEpisodes(rawData);

    // Validate against existing episodes in selected novel
    if (novelId) {
      const existingEpisodes = (episodes || []).filter(
        (e: any) => e.novelId === novelId
      );
      for (const ep of parsed) {
        const existing = existingEpisodes.find(
          (e: any) => e.episodeNumber === ep.episodeNumber
        );
        if (existing && importMode === "skip_duplicates") {
          // Mark as informational, not error
        }
      }
    }

    setParsedEpisodes(parsed);
    setValidationErrors(errors);

    if (errors.length > 0) {
      toast.error(`Found ${errors.length} validation error(s)`);
    } else if (parsed.length > 0) {
      toast.success(`Parsed ${parsed.length} episodes`);
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

    const existingEpisodes = (episodes || []).filter((e: any) =>
      e.novelId === novelId
    );

    for (const ep of parsedEpisodes) {
      try {
        const existing = existingEpisodes.find(
          (e: any) => e.episodeNumber === ep.episodeNumber
        );

        if (existing) {
          if (
            importMode === "skip_duplicates" ||
            importMode === "create_only"
          ) {
            skippedCount++;
            continue;
          } else if (importMode === "update_existing") {
            // Build update data, respecting allowBlankOverwrite
            const updateData: any = {
              episodeId: existing.id,
              title: ep.episodeTitle,
              price: ep.price,
              isFree: ep.isFree,
              isPublished: ep.isPublished,
              sortOrder: ep.sortOrder,
              saleMode: ep.saleMode,
            };

            // Only update content if provided or allowBlankOverwrite is true
            if (ep.content || allowBlankOverwrite) {
              updateData.content = ep.content;
              updateData.contentFormat = ep.contentFormat;
            }

            // Only update description/fileUrl if provided or allowBlankOverwrite is true
            if (ep.description || allowBlankOverwrite) {
              updateData.description = ep.description;
            }
            if (ep.fileUrl || allowBlankOverwrite) {
              updateData.fileUrl = ep.fileUrl;
            }

            await updateMutation.mutateAsync(updateData);
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
          contentFormat: ep.contentFormat,
          description: ep.description,
          fileUrl: ep.fileUrl,
          isPublished: ep.isPublished,
          sortOrder: ep.sortOrder,
          saleMode: ep.saleMode,
        });
        successCount++;
      } catch (error) {
        console.error("Import error:", error);
        errorCount++;
      }
    }

    setImporting(false);
    toast.success(
      `Import complete: ${successCount} created/updated, ${skippedCount} skipped, ${errorCount} errors`
    );

    setParsedEpisodes([]);
    setValidationErrors([]);
  };

  return (
    <AdminLayout>
      <div className="space-y-4 md:space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-0">
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900">Import Episodes</h1>
            <p className="text-sm sm:text-base text-slate-600 mt-1 sm:mt-2">
              Upload CSV / XLSX episodes into a selected novel
            </p>
          </div>
          <Button
            onClick={generateXLSXTemplate}
            variant="outline"
            size="sm"
            className="gap-2 shrink-0"
          >
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">Download XLSX Template</span>
            <span className="sm:hidden">Template</span>
          </Button>
        </div>

        {/* Novel Selection */}
        <Card className="p-4">
          <Label>Select Novel</Label>
          <select
            value={novelId || ""}
            onChange={(e) =>
              setNovelId(e.target.value ? parseInt(e.target.value) : undefined)
            }
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

        {/* Import Source Tabs */}
        <div className="flex gap-2 border-b">
          <button
            onClick={() => setImportSource("spreadsheet")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              importSource === "spreadsheet"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            XLSX / CSV Import
          </button>
          <button
            onClick={() => setImportSource("zip")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              importSource === "zip"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Import Package ZIP
          </button>
        </div>
        <p className="text-xs text-slate-500 -mt-4">
          {importSource === "spreadsheet"
            ? "เหมาะสำหรับรายบท หรือแพ็กที่เนื้อหาสั้น"
            : "เหมาะสำหรับแพ็กอ่านบนเว็บขนาดใหญ่ (หลายสิบ-ร้อยบท) ที่ยัดเนื้อหาลงช่อง xlsx ไม่ไหว"}
        </p>

        {importSource === "zip" ? (
          <PackageZipImportSection novelId={novelId} />
        ) : (
          <>
        {/* File Upload & Template */}
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">Step 1: Upload File</h3>
            <Button
              onClick={generateXLSXTemplate}
              variant="outline"
              size="sm"
              className="gap-2"
            >
              <Download className="w-4 h-4" />
              Download XLSX Template
            </Button>
          </div>

          <div className="border-2 border-dashed rounded-lg p-6 text-center">
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={handleFileUpload}
              className="hidden"
              id="file-upload"
            />
            <label htmlFor="file-upload" className="cursor-pointer">
              <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm text-slate-600">
                Click to upload CSV or XLSX file
              </p>
            </label>
          </div>

          <div className="mt-4 text-xs text-slate-500">
            <p className="font-semibold mb-2">Supported formats:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>CSV (.csv) - standard comma-separated values</li>
              <li>XLSX (.xlsx) - Excel spreadsheet</li>
            </ul>
            <p className="font-semibold mt-3 mb-2">Required columns:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>episodeNumber / episode_number / ตอนที่</li>
              <li>episodeTitle / title / ชื่อตอน</li>
            </ul>
            <p className="font-semibold mt-3 mb-2">Optional: saleMode / sale_mode / ประเภทการขาย</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Accepts: chapter, package, รายบท, แพ็ก, แพ็กอ่านบนเว็บ</li>
              <li>
                If omitted: a fileUrl or a range episode number (e.g. "1 - 50")
                is imported as package, otherwise chapter.
              </li>
            </ul>
          </div>
        </Card>

        {/* Validation Errors */}
        {validationErrors.length > 0 && (
          <Card className="p-4 bg-red-50 border-red-200">
            <div className="flex gap-3">
              <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="font-semibold text-red-900 mb-2">
                  Validation Errors
                </h4>
                <div className="space-y-1 text-sm text-red-800 max-h-40 overflow-y-auto">
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
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-slate-50">
                    <th className="text-left py-2 px-2">#</th>
                    <th className="text-left py-2 px-2">Episode #</th>
                    <th className="text-left py-2 px-2">Title</th>
                    <th className="text-left py-2 px-2">Sale Mode</th>
                    <th className="text-left py-2 px-2">Price</th>
                    <th className="text-left py-2 px-2">Free</th>
                    <th className="text-left py-2 px-2">Published</th>
                    <th className="text-left py-2 px-2">Content</th>
                    <th className="text-left py-2 px-2">Sort</th>
                  </tr>
                </thead>
                <tbody>
                  {parsedEpisodes.slice(0, 15).map((ep, idx) => (
                    <tr key={idx} className="border-b hover:bg-slate-50">
                      <td className="py-2 px-2 text-muted-foreground">{idx + 1}</td>
                      <td className="py-2 px-2 font-medium">{ep.episodeNumber}</td>
                      <td className="py-2 px-2">{ep.episodeTitle}</td>
                      <td className="py-2 px-2">
                        <Badge variant={ep.saleMode === "package" ? "outline" : "secondary"} className="text-xs">
                          {ep.saleMode === "package" ? "แพ็ก" : "รายบท"}
                        </Badge>
                      </td>
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
                        {ep.isPublished ? (
                          <Badge variant="outline" className="text-xs">
                            Yes
                          </Badge>
                        ) : (
                          <Badge variant="destructive" className="text-xs">
                            Draft
                          </Badge>
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
                      <td className="py-2 px-2 text-muted-foreground">
                        {ep.sortOrder || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsedEpisodes.length > 15 && (
                <p className="text-xs text-muted-foreground mt-2">
                  ... and {parsedEpisodes.length - 15} more episodes
                </p>
              )}
            </div>

            {/* Import Options */}
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

              {importMode === "update_existing" && (
                <div className="p-3 bg-blue-50 rounded border border-blue-200">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={allowBlankOverwrite}
                      onChange={(e) =>
                        setAllowBlankOverwrite(e.target.checked)
                      }
                    />
                    <span className="text-sm">
                      Allow blank values to overwrite existing content
                    </span>
                  </label>
                  <p className="text-xs text-slate-600 mt-1">
                    If unchecked, blank cells will not update existing data
                  </p>
                </div>
              )}
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
          </>
        )}
      </div>
    </AdminLayout>
  );
}
