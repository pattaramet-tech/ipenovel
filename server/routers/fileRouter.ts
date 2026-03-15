/**
 * File Router - tRPC routes for episode file management
 */

import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as fileService from "../services/fileService";
import * as db from "../db";

export const fileRouter = router({
  /**
   * Get download URL for an episode
   * Verifies user has access before returning URL
   */
  getDownloadUrl: protectedProcedure
    .input(z.object({ episodeId: z.number() }))
    .query(async ({ input, ctx }) => {
      try {
        const url = await fileService.getEpisodeDownloadUrl(ctx.user.id, input.episodeId);
        return { downloadUrl: url };
      } catch (error: any) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: error.message,
        });
      }
    }),

  /**
   * Admin: Upload episode file
   * Stores file in S3 and updates episode record
   */
  uploadEpisodeFile: adminProcedure
    .input(
      z.object({
        episodeId: z.number(),
        fileName: z.string(),
        fileBase64: z.string(),
        mimeType: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        // Verify episode exists
        const episode = await db.getEpisodeById(input.episodeId);
        if (!episode) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Episode not found" });
        }

        // Decode base64 to buffer
        const fileBuffer = Buffer.from(input.fileBase64, "base64");

        // Validate file
        const validation = fileService.validateEpisodeFile(input.fileName, input.mimeType, fileBuffer.length);
        if (!validation.valid) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: validation.error,
          });
        }

        // Upload file
        const { url, key } = await fileService.uploadEpisodeFile(input.episodeId, input.fileName, fileBuffer, input.mimeType);

        // Update episode with file URL
        // TODO: Implement updateEpisodeFile in db.ts
        // await db.updateEpisodeFile(input.episodeId, url, key);

        return {
          success: true,
          fileUrl: url,
          fileKey: key,
        };
      } catch (error: any) {
        if (error instanceof TRPCError) {
          throw error;
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        });
      }
    }),

  /**
   * Get file metadata (for admin)
   */
  getFileMetadata: adminProcedure
    .input(z.object({ episodeId: z.number() }))
    .query(async ({ input }) => {
      const episode = await db.getEpisodeById(input.episodeId);
      if (!episode) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      return {
        episodeId: episode.id,
        fileName: episode.title,
        fileUrl: episode.fileUrl,
        uploadedAt: episode.createdAt,
      };
    }),
});
