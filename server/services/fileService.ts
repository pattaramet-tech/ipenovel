/**
 * File Service - Handle episode file uploads and downloads with S3
 * Ensures access control through entitlements
 */

import { storagePut } from "../storage";
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

  // Upload to S3
  const result = await storagePut(fileKey, fileBuffer, mimeType);

  return {
    url: result.url,
    key: fileKey,
  };
}

/**
 * Get download URL for episode file
 * Verifies user has access before generating URL
 */
export async function getEpisodeDownloadUrl(userId: number, episodeId: number, expiresIn: number = 3600): Promise<string> {
  // Verify user has access to this episode
  const episode = await db.getEpisodeById(episodeId);
  if (!episode) {
    throw new Error("Episode not found");
  }

  // Check if free episode
  if (episode.isFree) {
    // Free episodes can be downloaded by anyone
    return episode.fileUrl || "";
  }

  // Check if user has purchased
  const purchase = await db.getPurchaseByUserAndEpisode(userId, episodeId);
  if (!purchase) {
    throw new Error("Access denied: Episode not purchased");
  }

  // Return the file URL (in production, this could be a pre-signed URL)
  return episode.fileUrl || "";
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
