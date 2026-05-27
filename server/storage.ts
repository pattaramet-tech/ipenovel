// Preconfigured storage helpers for Manus WebDev templates
// Uses the Biz-provided storage proxy (Authorization: Bearer <token>)

import { ENV } from './_core/env';
import { StorageUploadError } from './helpers/storageErrorHandler';

type StorageConfig = { baseUrl: string; apiKey: string };

function getStorageConfig(): StorageConfig {
  const baseUrl = ENV.forgeApiUrl;
  const apiKey = ENV.forgeApiKey;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "Storage proxy credentials missing: set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY"
    );
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

function buildUploadUrl(baseUrl: string, relKey: string): URL {
  const url = new URL("v1/storage/upload", ensureTrailingSlash(baseUrl));
  url.searchParams.set("path", normalizeKey(relKey));
  return url;
}

async function buildDownloadUrl(
  baseUrl: string,
  relKey: string,
  apiKey: string
): Promise<string> {
  const downloadApiUrl = new URL(
    "v1/storage/downloadUrl",
    ensureTrailingSlash(baseUrl)
  );
  downloadApiUrl.searchParams.set("path", normalizeKey(relKey));
  const response = await fetch(downloadApiUrl, {
    method: "GET",
    headers: buildAuthHeaders(apiKey),
  });
  return (await response.json()).url;
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

  const url = (await response.json()).url;
  return { key, url };
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
