/**
 * File Service - Handle episode file uploads and downloads with S3
 * Ensures access control through entitlements
 */

import { putPrivateObject, resolveStoredFileValue, R2PrivateStorageError } from "./r2PrivateStorage";
import { toPrivateObjectRef } from "@shared/privateFileRef";
import * as db from "../db";

const ALLOWED_MIME_TYPES = ["application/pdf", "application/epub+zip", "text/plain", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];

/**
 * Upload episode file to S3
 * Returns the S3 URL for storage in database
 */
export async function uploadEpisodeFile(
  episodeId: number,
  fileName: string,
  fileBuffer: Buffer,
  mimeType: string
): Promise<{ url: string; key: string }> {
  // Validate file type
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    throw new Error(`File type not allowed. Allowed types: ${ALLOWED_MIME_TYPES.join(", ")}`);
  }

  // Validate file size (max 100MB)
  const maxSize = 100 * 1024 * 1024;
  if (fileBuffer.length > maxSize) {
    throw new Error("File size exceeds 100MB limit");
  }

  // Generate unique key with random suffix to prevent enumeration
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  const fileKey = `episodes/${episodeId}/${timestamp}-${randomSuffix}-${sanitizedFileName}`;

  // Upload to the PRIVATE R2 bucket. The returned "url" is a private object
  // reference ("r2p:episodes/..."), never a permanent public URL - it's
  // stored in episodes.fileUrl as-is and only resolved to a working,
  // short-lived link by getEpisodeDownloadUrl() below (or any other
  // entitlement-gated read site), never eagerly.
  const result = await putPrivateObject("episodeFile", fileKey, fileBuffer, mimeType);

  return {
    url: toPrivateObjectRef(result.key),
    key: fileKey,
  };
}

/**
 * Get download URL for episode file
 * Verifies user has access before generating URL. Signed-URL expiry is not
 * a parameter here - it's controlled entirely by R2_PRIVATE_SIGNED_URL_EXPIRES_SECONDS
 * (see resolveStoredFileValue -> getPrivateObjectSignedUrl's default), so
 * there is exactly one source of truth for how long a link stays valid.
 */
export async function getEpisodeDownloadUrl(userId: number, episodeId: number): Promise<string> {
  // Verify user has access to this episode
  const episode = await db.getEpisodeById(episodeId);
  if (!episode) {
    throw new Error("Episode not found");
  }

  // Free episodes are downloadable by anyone; paid episodes require a
  // purchase record. Either way, the file itself may live in the private R2
  // bucket - the entitlement check above must run BEFORE resolving the
  // stored reference, so a private object reference is only ever turned
  // into a working (signed, short-lived) URL after access is confirmed,
  // never handed to the client raw.
  if (!episode.isFree) {
    const purchase = await db.getPurchaseByUserAndEpisode(userId, episodeId);
    if (!purchase) {
      throw new Error("Access denied: Episode not purchased");
    }
  }

  if (!episode.fileUrl) return "";

  try {
    return (await resolveStoredFileValue(episode.fileUrl, "episodeFile")) || "";
  } catch (error) {
    console.error(
      "[FileService] Failed to resolve episode file reference",
      error instanceof R2PrivateStorageError ? error.getSafeDetails() : { episodeId }
    );
    // Never leak bucket/key/endpoint/secret details - the generic message
    // below is what fileRouter.ts's getDownloadUrl surfaces to the client.
    throw new Error("ไม่สามารถเปิดไฟล์ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง");
  }
}

/**
 * Delete episode file from S3
 */
export async function deleteEpisodeFile(fileKey: string): Promise<void> {
  // TODO: Implement S3 delete operation
  // This would require adding a delete method to the storage service
  console.log(`[FileService] Marking file for deletion: ${fileKey}`);
}

/**
 * Validate episode file before upload
 */
export function validateEpisodeFile(fileName: string, mimeType: string, fileSize: number): { valid: boolean; error?: string } {
  // Check file extension
  const validExtensions = [".pdf", ".epub", ".txt", ".docx"];
  const hasValidExtension = validExtensions.some((ext) => fileName.toLowerCase().endsWith(ext));

  if (!hasValidExtension) {
    return {
      valid: false,
      error: `Invalid file extension. Allowed: ${validExtensions.join(", ")}`,
    };
  }

  // Check MIME type
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    return {
      valid: false,
      error: `Invalid MIME type: ${mimeType}`,
    };
  }

  // Check file size
  const maxSize = 100 * 1024 * 1024;
  if (fileSize > maxSize) {
    return {
      valid: false,
      error: `File size exceeds 100MB limit (${(fileSize / 1024 / 1024).toFixed(2)}MB)`,
    };
  }

  return { valid: true };
}
