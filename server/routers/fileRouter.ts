/**
 * File Router - tRPC routes for episode file management
 */

import { protectedProcedure, adminProcedure, authorContentProcedure, router } from "../_core/trpc";
import { CatalogAccessError, rethrowCatalogAccess, withCatalogEpisodeWrite } from "../authz/catalogAccess";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as fileService from "../services/fileService";
import * as leaseService from "../services/readingLease";
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
        // R2 C4: entitlement (free ∨ purchase) is enforced inside
        // getEpisodeDownloadUrl; a PAID download additionally requires this
        // session to hold the reading lease (no auto-acquire).
        const episode = await db.getEpisodeById(input.episodeId);
        if (episode) {
          const leaseGate = await leaseService.evaluatePaidRead({
            user: ctx.user,
            authSession: ctx.authSession,
            isFree: episode.isFree === true,
            autoAcquire: false,
          });
          if (!leaseGate.allowed) {
            throw new Error("Reading session required for this download.");
          }
        }
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
  uploadEpisodeFile: authorContentProcedure
    .input(
      z.object({
        episodeId: z.number(),
        fileName: z.string(),
        fileBase64: z.string(),
        mimeType: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const fileBuffer = Buffer.from(input.fileBase64, "base64");
        const validation = fileService.validateEpisodeFile(input.fileName, input.mimeType, fileBuffer.length);
        if (!validation.valid) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: validation.error,
          });
        }

        const { url, key } = await withCatalogEpisodeWrite(ctx.user.id, input.episodeId, async (tx) => {
          const uploaded = await fileService.uploadEpisodeFile(input.episodeId, input.fileName, fileBuffer, input.mimeType);
          await db.updateEpisode(input.episodeId, {
            fileUrl: uploaded.url,
            fileMimeType: input.mimeType,
            fileSize: fileBuffer.length,
          }, tx);
          return uploaded;
        });

        return {
          success: true,
          fileUrl: url,
          fileKey: key,
        };
      } catch (error: any) {
        if (error instanceof CatalogAccessError && error.code === "NOT_FOUND") {
          throw new TRPCError({ code: "NOT_FOUND", message: "Episode not found" });
        }
        if (error instanceof CatalogAccessError) {
          rethrowCatalogAccess(error);
        }
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
