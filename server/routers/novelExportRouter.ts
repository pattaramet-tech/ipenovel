/**
 * Novel Export Router (IPE-059-A) - admin-only TXT/ZIP export of canonical
 * published content. UI integration is IPE-059-B; this router is backend-only.
 *
 * Transport decision (documented per IPE-059-A §21): ZIP/TXT travel as
 * base64 inside tRPC, exactly like the existing `admin.importPackageZip`
 * flow. MAX_EXPORT_ZIP_BYTES (24MB) keeps base64 output (~32MB) under the
 * 50MB Express JSON body limit, and export sizes are fail-closed bounded.
 */

import { adminProcedure, router } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  MAX_EXPORT_PER_ITEM_BYTES,
  MAX_EXPORT_ITEMS,
  MAX_EXPORT_TOTAL_BYTES,
  NovelExportError,
  buildNovelExportPreview,
  buildNovelTxtExport,
  buildNovelZipExport,
} from "../services/novelExport.service";

function toTrpcError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;
  if (error instanceof NovelExportError) {
    if (error.code === "EXPORT_NOVEL_NOT_FOUND" || error.code === "EXPORT_UNKNOWN_EPISODE") {
      return new TRPCError({ code: "NOT_FOUND", message: error.message });
    }
    if (
      error.code === "EXPORT_LIMIT_ITEMS" ||
      error.code === "EXPORT_LIMIT_ENTRY_BYTES" ||
      error.code === "EXPORT_LIMIT_TOTAL_BYTES" ||
      error.code === "EXPORT_LIMIT_ZIP_BYTES"
    ) {
      return new TRPCError({ code: "BAD_REQUEST", message: error.message });
    }
    return new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  throw error;
}

const exportSelectionInput = z.object({
  novelId: z.number().int().positive(),
  episodeIds: z.array(z.number().int().positive()).optional(),
});

export const novelExportRouter = router({
  /**
   * Metadata/preview for an export selection - item count, skipped
   * episodes, estimated bytes and active limits. No content over the wire.
   */
  preview: adminProcedure.input(exportSelectionInput).query(async ({ input }) => {
    try {
      return await buildNovelExportPreview(input);
    } catch (error) {
      throw toTrpcError(error);
    }
  }),

  /** Single published episode as UTF-8 .txt (same serializer as ZIP entries). */
  downloadTxt: adminProcedure
    .input(z.object({ novelId: z.number().int().positive(), episodeId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      try {
        const result = await buildNovelTxtExport(input.novelId, input.episodeId);
        return {
          filename: result.filename,
          mimeType: "text/plain; charset=utf-8" as const,
          contentBase64: result.content.toString("base64"),
          byteCount: result.content.length,
        };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  /** Whole-novel or explicit-subset ZIP package (import-contract compatible). */
  downloadZip: adminProcedure.input(exportSelectionInput).mutation(async ({ input }) => {
    try {
      const result = await buildNovelZipExport(input);
      return {
        filename: result.filename,
        mimeType: "application/zip" as const,
        contentBase64: result.content.toString("base64"),
        byteCount: result.content.length,
        itemCount: result.itemCount,
        totalPlaintextBytes: result.totalPlaintextBytes,
        entryFilenames: result.entryFilenames,
        skippedItems: result.skippedItems,
      };
    } catch (error) {
      throw toTrpcError(error);
    }
  }),

  limits: adminProcedure.query(() => ({
    maxItems: MAX_EXPORT_ITEMS,
    maxPerItemBytes: MAX_EXPORT_PER_ITEM_BYTES,
    maxTotalBytes: MAX_EXPORT_TOTAL_BYTES,
  })),
});
