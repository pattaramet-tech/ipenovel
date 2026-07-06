// Preconfigured storage helpers for Manus WebDev templates
// Uses the Biz-provided storage proxy (Authorization: Bearer <token>)

import { ENV } from './_core/env';
import { StorageUploadError } from './helpers/storageErrorHandler';

type StorageConfig = { baseUrl: string; apiKey: string };

/**
 * Validate that a string is a valid absolute URL
 */
function validateAbsoluteUrl(value: string): string {
  const trimmed = String(value || "").trim();

  if (!trimmed) {
    throw new Error("URL is empty");
  }

  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Invalid protocol");
    }
    return trimmed.replace(/\/+$/, "");
  } catch (error: any) {
    // Don't expose the invalid URL in the error - just indicate it's invalid
    throw new Error("Invalid storage base URL format");
  }
}

function getStorageConfig(): StorageConfig {
  const baseUrl = ENV.forgeApiUrl;
  const apiKey = ENV.forgeApiKey;

  if (!baseUrl || !apiKey) {
    throw new StorageUploadError(
      null,
      null,
      "Missing BUILT_IN_FORGE_API_URL or BUILT_IN_FORGE_API_KEY",
      "",
      !!baseUrl,
      !!apiKey,
      "Storage credentials not configured"
    );
  }

  let validatedBaseUrl: string;
  try {
    validatedBaseUrl = validateAbsoluteUrl(baseUrl);
  } catch (error: any) {
    throw new StorageUploadError(
      null,
      null,
      `Invalid BUILT_IN_FORGE_API_URL: ${error.message}`,
      "",
      true,
      true,
      "Storage base URL configuration is invalid"
    );
  }

  return { baseUrl: validatedBaseUrl, apiKey };
}

function buildUploadUrl(baseUrl: string, relKey: string): URL {
  try {
    const url = new URL("v1/storage/upload", ensureTrailingSlash(baseUrl));
    url.searchParams.set("path", normalizeKey(relKey));
    return url;
  } catch (error: any) {
    throw new StorageUploadError(
      null,
      null,
      `Failed to build upload URL: ${error.message}`,
      relKey,
      true,
      true,
      "Failed to construct upload request"
    );
  }
}

async function buildDownloadUrl(
  baseUrl: string,
  relKey: string,
  apiKey: string
): Promise<string> {
  let downloadApiUrl: URL;
  try {
    downloadApiUrl = new URL(
      "v1/storage/downloadUrl",
      ensureTrailingSlash(baseUrl)
    );
    downloadApiUrl.searchParams.set("path", normalizeKey(relKey));
  } catch (error: any) {
    throw new StorageUploadError(
      null,
      null,
      `Failed to build download URL: ${error.message}`,
      relKey,
      true,
      true,
      "Failed to construct download request"
    );
  }

  let response: Response;
  try {
    response = await fetch(downloadApiUrl, {
      method: "GET",
      headers: buildAuthHeaders(apiKey),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error: any) {
    throw new StorageUploadError(
      null,
      null,
      error.message || "Network error",
      relKey,
      true,
      true,
      "Network error during download URL fetch"
    );
  }

  if (!response.ok) {
    const responseText = await response.text().catch(() => response.statusText);
    throw new StorageUploadError(
      response.status,
      response.statusText,
      responseText,
      relKey,
      true,
      true,
      `Storage download URL request failed (${response.status} ${response.statusText})`
    );
  }

  const responseContentType = response.headers.get("content-type") || "";
  const responseText = await response.text();

  let payload: any;
  try {
    payload = JSON.parse(responseText);
  } catch (error: any) {
    console.error("[Storage] Download URL request returned non-JSON response", {
      status: response.status,
      statusText: response.statusText,
      contentType: responseContentType,
      bodyPreview: responseText.slice(0, 200),
      key: relKey,
    });
    throw new StorageUploadError(
      response.status,
      response.statusText,
      "Non-JSON response",
      relKey,
      true,
      true,
      "Storage service returned invalid response"
    );
  }

  if (!payload?.url || typeof payload.url !== "string") {
    throw new StorageUploadError(
      response.status,
      response.statusText,
      "Missing or invalid url field",
      relKey,
      true,
      true,
      "Storage service returned invalid response"
    );
  }

  return payload.url;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

function toFormData(
  data: Buffer | Uint8Array | string,
  contentType: string,
  fileName: string
): FormData {
  const blob =
    typeof data === "string"
      ? new Blob([data], { type: contentType })
      : new Blob([data as any], { type: contentType });
  const form = new FormData();
  form.append("file", blob, fileName || "file");
  return form;
}

function buildAuthHeaders(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}` };
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  let baseUrl: string;
  let apiKey: string;
  let hasBaseUrl = false;
  let hasApiKey = false;

  try {
    const config = getStorageConfig();
    baseUrl = config.baseUrl;
    apiKey = config.apiKey;
    hasBaseUrl = true;
    hasApiKey = true;
  } catch (error: any) {
    throw new StorageUploadError(
      null,
      null,
      error.message || "Missing storage configuration",
      relKey,
      false,
      false,
      "Storage credentials not configured"
    );
  }

  const key = normalizeKey(relKey);
  const uploadUrl = buildUploadUrl(baseUrl, key);
  const formData = toFormData(data, contentType, key.split("/").pop() ?? key);

  let response: Response;
  try {
    response = await fetch(uploadUrl, {
      method: "POST",
      headers: buildAuthHeaders(apiKey),
      body: formData,
      signal: AbortSignal.timeout(30000),
    });
  } catch (error: any) {
    throw new StorageUploadError(
      null,
      null,
      error.message || "Network error",
      relKey,
      hasBaseUrl,
      hasApiKey,
      "Network error during upload"
    );
  }

  if (!response.ok) {
    const responseText = await response.text().catch(() => response.statusText);
    throw new StorageUploadError(
      response.status,
      response.statusText,
      responseText,
      relKey,
      hasBaseUrl,
      hasApiKey,
      `Storage upload failed (${response.status} ${response.statusText})`
    );
  }

  const responseContentType = response.headers.get("content-type") || "";
  const responseText = await response.text();

  let payload: any;
  try {
    payload = JSON.parse(responseText);
  } catch (error: any) {
    console.error("[Storage] Upload returned non-JSON response", {
      status: response.status,
      statusText: response.statusText,
      contentType: responseContentType,
      bodyPreview: responseText.slice(0, 200),
      key,
    });
    throw new StorageUploadError(
      response.status,
      response.statusText,
      "Non-JSON response",
      relKey,
      hasBaseUrl,
      hasApiKey,
      "Storage returned invalid response format"
    );
  }

  if (!payload?.url || typeof payload.url !== "string") {
    throw new StorageUploadError(
      response.status,
      response.statusText,
      "Missing or invalid url field",
      relKey,
      hasBaseUrl,
      hasApiKey,
      "Storage returned invalid response"
    );
  }

  return { key, url: payload.url };
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string; }> {
  let baseUrl: string;
  let apiKey: string;

  try {
    const config = getStorageConfig();
    baseUrl = config.baseUrl;
    apiKey = config.apiKey;
  } catch (error: any) {
    throw new StorageUploadError(
      null,
      null,
      error.message || "Missing storage configuration",
      relKey,
      false,
      false,
      "Storage credentials not configured"
    );
  }

  const key = normalizeKey(relKey);
  return {
    key,
    url: await buildDownloadUrl(baseUrl, key, apiKey),
  };
}

export function isStorageReady(): boolean {
  try {
    getStorageConfig();
    return true;
  } catch {
    return false;
  }
}
