import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, authenticatedProcedure, router } from "./_core/trpc";
import { evaluateGoogleConnectionCutoff } from "./_core/env";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as db from "./db";
import * as orderService from "./services/orderService";
import * as walletService from "./services/walletService";
import { ApprovalService } from "./services/approvalService";
import { submitPaymentSlip } from "./services/slipSubmissionService";
import { uploadPaymentSlipFile } from "./services/slipFileUploadService";
import { recheckOrderPaymentOcr } from "./services/ocrRecheckService";
import { resolveLegacyCaseAmbiguity } from "./services/legacyCaseResolutionService";
import { getOcrAttemptHistory } from "./services/ocrAttemptService";
import { evaluateSlipConflict } from "./services/slipConflictEvaluator";
import { resolveMatchedSourceNavigation } from "./services/matchedSourceNavigationService";
import { describeFileIdentifierStatus } from "./services/slipFileHashService";
import {
  deriveStrongIdentifiersFromExtractedData,
  getRawReferenceForLegacyLookup,
  hasStrongIdentifier,
} from "./services/slipIdentifierService";
import { getEffectiveOCRConfig } from "./_core/ocr-effective-config";
import {
  assertCheckoutAvailable,
  assertSlipCheckoutAvailable,
  getCheckoutMaintenanceStatus,
  saveCheckoutMaintenanceStatus,
  checkoutMaintenanceAdminInputSchema,
} from "./services/checkoutMaintenanceService";
import { safeErrorSummary } from "../scripts/lib/safeErrorSummary.mjs";
import { isDuplicateKeyError } from "./helpers/databaseErrorClassifier";
import { fileRouter } from "./routers/fileRouter";
import { ocrMetricsRouter } from "./routers/ocrMetricsRouter";
import { r2Put, R2StorageError } from "./services/r2Storage";
import { optimizeImageToWebp, ImageOptimizeError, SPORTS_MATCH_IMAGE_PRESET } from "./services/imageOptimizer";
import { parseSlipImage, verifyRecipient } from "./ocr-slip-verification-v2";
import { processSlipVerificationStaging } from "./ocr-slip-integration-staging";
import { getOCRConfig } from "./_core/ocr-config";
import {
  generateApprovalNote,
  generateManualReviewNote,
  generateShadowModeNote,
} from "./_core/ocr-order-notes";
import * as readerService from "./services/readerService";
import * as packageZipImportService from "./services/packageZipImportService";
import {
  runMediaMigrationBatch,
  MediaMigrationConfigError,
  MediaMigrationLockError,
} from "./services/mediaMigrationService";
import {
  putPrivateObject,
  resolveStoredFileValue,
  R2PrivateStorageError,
} from "./services/r2PrivateStorage";
import { isValidStoredFileRef } from "@shared/privateFileRef";
import * as accountRecoveryService from "./services/accountRecoveryService";
import { AccountRecoveryError } from "./services/accountRecoveryService";
import { buildAccountMergePreview } from "./services/accountMergePreviewService";
import { updateAdminUserProfile, AdminUserManagementError } from "./services/adminUserManagementService";

// ============ HELPER PROCEDURES ============

// Built on authenticatedProcedure (auth only), deliberately NOT
// protectedProcedure - an admin action must never be blocked by the
// mandatory Google-migration gate (see server/_core/trpc.ts's docstrings
// on both procedure types). This is what makes "AdminProcedure must never
// go through the mandatory user gate" true by construction rather than by
// convention.
const adminProcedure = authenticatedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return next({ ctx });
});

// ============ ACCOUNT RECOVERY HELPERS ============

/** Maps an AccountRecoveryError's semantic code to a real TRPCError code -
 *  never lets an unexpected/unmapped error leak its raw message to the
 *  client (falls back to a generic, sanitized INTERNAL_SERVER_ERROR). */
function mapAccountRecoveryError(error: unknown): TRPCError {
  if (error instanceof AccountRecoveryError) {
    const codeMap: Record<AccountRecoveryError["code"], "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND"> = {
      NOT_GOOGLE_LINKED: "BAD_REQUEST",
      ALREADY_PENDING: "CONFLICT",
      NOT_FOUND: "NOT_FOUND",
      ALREADY_PROCESSED: "CONFLICT",
      UNSAFE: "BAD_REQUEST",
      CONFLICT: "CONFLICT",
      FORBIDDEN: "BAD_REQUEST",
    };
    return new TRPCError({ code: codeMap[error.code] ?? "BAD_REQUEST", message: error.message });
  }
  console.error("[AccountRecovery] Unexpected error", safeErrorSummary(error));
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "ไม่สามารถดำเนินการได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง",
  });
}

// ============ ADMIN USERS MANAGEMENT HELPERS ============

/** AdminUserManagementError's own codes are already valid TRPCError codes
 *  (NOT_FOUND/FORBIDDEN/BAD_REQUEST/CONFLICT), so this is a direct pass-
 *  through rather than a translation table - unlike mapAccountRecoveryError
 *  above. Any OTHER error (a raw database exception, etc.) never leaks its
 *  message to the client. */
function mapAdminUserManagementError(error: unknown): TRPCError {
  if (error instanceof AdminUserManagementError) {
    return new TRPCError({ code: error.code, message: error.message });
  }
  console.error("[AdminUserManagement] Unexpected error", safeErrorSummary(error));
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "ไม่สามารถดำเนินการได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง",
  });
}

/** "jo***@example.com" - never the full address. Used only in admin-facing
 *  responses (search results, request detail) - the requester's OWN status
 *  view never needs this, it already knows its own claims verbatim. */
function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) return "***";
  const localPart = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  const visible = localPart.slice(0, Math.min(2, localPart.length));
  return `${visible}${"*".repeat(Math.max(localPart.length - visible.length, 1))}@${domain}`;
}

/** "abc123...ef" - openId can be a stable external identifier; masked the
 *  same "show a little, hide the rest" way as maskEmail rather than shown
 *  in full to an admin who is only trying to CONFIRM a match, not read it
 *  back verbatim. */
function maskOpenId(openId: string | null | undefined): string | null {
  if (!openId) return null;
  if (openId.length <= 8) return "***";
  return `${openId.slice(0, 6)}...${openId.slice(-2)}`;
}

function maskUserForAdmin(user: {
  id: number;
  email: string | null;
  name: string | null;
  role: string;
  loginMethod: string | null;
  openId: string;
  createdAt: Date;
}) {
  return {
    id: user.id,
    maskedEmail: maskEmail(user.email),
    name: user.name,
    role: user.role,
    loginMethod: user.loginMethod,
    maskedOpenId: maskOpenId(user.openId),
    createdAt: user.createdAt,
  };
}

// A slipImageUrl/fileUrl input must be either a legacy absolute http(s) URL
// or a private object reference (r2p:...) - never anything else (e.g.
// javascript:, file://, or an arbitrary internal address), since these
// values are later handed to an outbound OCR fetch or turned into a
// redirect/download link. See shared/privateFileRef.ts.
const STORED_FILE_REF_MESSAGE = "ต้องเป็น URL http(s) หรือ private object reference (r2p:...) เท่านั้น";
const optionalStoredFileRefSchema = z.string().refine(isValidStoredFileRef, { message: STORED_FILE_REF_MESSAGE }).optional();
function requiredStoredFileRefSchema(requiredMessage: string) {
  return z.string().min(1, requiredMessage).refine(isValidStoredFileRef, { message: STORED_FILE_REF_MESSAGE });
}

/**
 * Resolve a stored slipImageUrl/fileUrl value to something actually
 * fetchable right now, mapping any private-R2 failure to a safe, generic
 * TRPCError that never echoes bucket/key/endpoint/secret details. Callers
 * must have already completed any entitlement/ownership/admin check.
 */
async function resolveStoredFileValueOrThrow(
  value: string | null | undefined,
  context: "paymentSlip" | "episodeFile",
  logLabel: string
): Promise<string | null> {
  try {
    return await resolveStoredFileValue(value, context);
  } catch (error) {
    console.error(
      `[${logLabel}] Failed to resolve stored file reference`,
      error instanceof R2PrivateStorageError ? error.getSafeDetails() : { context }
    );
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: "ไม่สามารถเปิดไฟล์ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง",
    });
  }
}

/**
 * Same resolution as above, but for list/detail views where the file link
 * is one field among many (an order, a payment, a wallet top-up, an
 * episode row) - a single broken/misconfigured reference must not fail the
 * whole response. Logs safely server-side and degrades to null.
 */
async function resolveStoredFileValueSafe(
  value: string | null | undefined,
  context: "paymentSlip" | "episodeFile",
  logLabel: string
): Promise<string | null> {
  try {
    return await resolveStoredFileValue(value, context);
  } catch (error) {
    console.error(
      `[${logLabel}] Failed to resolve stored file reference`,
      error instanceof R2PrivateStorageError ? error.getSafeDetails() : { context }
    );
    return null;
  }
}

/** Returns a copy of a payment/walletTopup row with slipImageUrl resolved
 * to something actually viewable (see resolveStoredFileValueSafe). Passes
 * through null/undefined payment rows unchanged. */
async function withResolvedSlipUrl<T extends { slipImageUrl?: string | null } | null | undefined>(
  payment: T,
  logLabel: string
): Promise<T> {
  if (!payment) return payment;
  return { ...payment, slipImageUrl: await resolveStoredFileValueSafe(payment.slipImageUrl, "paymentSlip", logLabel) };
}

const BANNER_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const MAX_BANNER_IMAGE_SIZE = 5 * 1024 * 1024;

// Portrait book-cover footprint - downscale only, never upscale.
const NOVEL_COVER_MAX_DIMENSIONS = { maxWidth: 1000, maxHeight: 1500 };
// Landscape hero-banner footprint.
const BANNER_IMAGE_MAX_DIMENSIONS = { maxWidth: 1920, maxHeight: 800 };

/** Random key suffix so two uploads in the same millisecond never collide. */
function randomKeySuffix(): string {
  return Math.random().toString(36).substring(2, 8);
}

/**
 * Optimize an uploaded image buffer to WebP and upload it to R2, mapping any
 * failure (missing R2 config, a corrupt/unsupported image, or an R2 API
 * error) to a clear tRPC error - never a raw stack trace, never a crash that
 * could take down anything outside this one upload.
 */
export async function optimizeAndUploadToR2(
  fileBuffer: Buffer,
  keyPrefix: string,
  dimensions: { maxWidth: number; maxHeight: number }
): Promise<{ url: string; key: string }> {
  let optimized;
  try {
    optimized = await optimizeImageToWebp(fileBuffer, dimensions);
  } catch (error) {
    if (error instanceof ImageOptimizeError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
    }
    throw error;
  }

  const fileKey = `${keyPrefix}/${Date.now()}-${randomKeySuffix()}.webp`;

  try {
    return await r2Put(fileKey, optimized.buffer, optimized.contentType);
  } catch (error) {
    if (error instanceof R2StorageError) {
      console.error("[R2 Upload] Failed", error.getSafeDetails());
      throw new TRPCError({
        code: error.reason === "not_configured" ? "SERVICE_UNAVAILABLE" : "INTERNAL_SERVER_ERROR",
        message:
          error.reason === "not_configured"
            ? "ระบบอัปโหลดรูปภาพยังไม่พร้อมใช้งาน กรุณาติดต่อแอดมิน"
            : "อัปโหลดรูปภาพไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
      });
    }
    throw error;
  }
}

  // ============ MAIN ROUTER ============

const dashboardRouter = router({
  summary: adminProcedure.query(async () => {
    return db.getDashboardSummary();
  }),
  topUsers: adminProcedure
    .input(
      z.object({
        period: z.enum(["all", "today", "7d", "30d", "month"]).default("all"),
      })
    )
    .query(async ({ input }) => {
      return db.getTopUsersBySpending(input.period, 10);
    }),
});

export const appRouter = router({
  system: systemRouter,

  // ============ HOME PAGE ============
  home: router({
    getSections: publicProcedure.query(async () => {
      // Dev-only timing (no existing request-timing middleware is actually
      // wired into the tRPC pipeline in this repo - server/_core/
      // productionMonitoring.ts/requestLogging.ts exist but neither is
      // called anywhere, so wiring into either would mean touching shared
      // middleware for every procedure just for this one query. A local,
      // gated console.log is simpler and strictly scoped to this endpoint.
      // Never logs in production; never logs user data or SQL parameters.
      const isDev = process.env.NODE_ENV !== "production";
      const startedAt = isDev ? Date.now() : 0;

      const [popularNovels, newNovels, freeNovels, latestEpisodes, finishedNovels, banners] = await Promise.all([
        db.getPopularNovels(4),
        db.getNewNovels(4),
        db.getFreeNovels(4),
        db.getLatestEpisodes(4),
        db.getFinishedNovels(4),
        db.getAllBanners(),
      ]);

      if (isDev) {
        console.log(`[home.getSections] resolved in ${Date.now() - startedAt}ms`);
      }

      return {
        popularNovels,
        newNovels,
        freeNovels,
        latestEpisodes,
        finishedNovels,
        banners,
      };
    }),
  }),

  // ============ AUTH ============
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
    // Backs ProfilePage's "Connected Accounts" section AND the mandatory
    // migration gate (both client- and server-side) - AUTH_PROVIDER
    // google/transition only, see client-side shouldShowGoogleConnectSection.
    // authenticatedProcedure (not publicProcedure like me/logout above, and
    // deliberately NOT protectedProcedure) - requires a real,
    // already-verified session (an anonymous caller gets UNAUTHORIZED
    // rather than a false "not connected" answer), but must never itself be
    // blocked by the mandatory Google-migration gate: that gate's whole
    // purpose is to force a user toward connecting Google, and this is the
    // exact query the gate (both server/_core/googleMigrationGate.ts and
    // the client route gate) reads to decide whether they already have -
    // gating this query would be a deadlock. Returns only a boolean - never
    // providerSubject/sub, never emailAtLink, never any other authIdentities
    // column the UI has no need for.
    googleConnected: authenticatedProcedure.query(async ({ ctx }) => {
      const identity = await db.getAuthIdentityByUserAndProvider(ctx.user.id, "google");
      return { googleConnected: Boolean(identity) };
    }),
    // The single server-authoritative status client/src/components/
    // MigrationGate.tsx and its pre-cutoff banner poll to decide whether to
    // redirect/show a warning - never derives anything from the client's
    // own clock (see server/_core/env.ts's evaluateGoogleConnectionCutoff,
    // the one function this procedure is a thin wrapper around).
    // authenticatedProcedure (not protectedProcedure) for the same
    // deadlock-avoidance reason as googleConnected above - a user who
    // needsConnection must still be able to ask this question.
    googleConnectionCutoffStatus: authenticatedProcedure.query(async ({ ctx }) => {
      const cutoff = evaluateGoogleConnectionCutoff();
      const exempt = ctx.user.role === "admin";
      const identity = await db.getAuthIdentityByUserAndProvider(ctx.user.id, "google");
      const googleConnected = Boolean(identity);
      return {
        ...cutoff,
        googleConnected,
        exempt,
        // Only true once the gate is genuinely active, this specific user
        // isn't exempt, and they haven't already connected - the ONE field
        // every caller (client redirect decision, banner visibility) should
        // actually branch on instead of re-deriving the same combination
        // from the other fields themselves.
        needsConnection: cutoff.activeNow && !exempt && !googleConnected,
      };
    }),
  }),

  // ============ NOVELS & EPISODES ============
  novels: router({
    list: publicProcedure.query(async () => {
      return db.getAllNovels();
    }),

    catalog: publicProcedure
      .input(
        z.object({
          sort: z.enum(["new", "popular"]).optional(),
          filter: z.enum(["all", "free"]).optional(),
          search: z.string().optional(),
          limit: z.number().optional(),
          offset: z.number().optional(),
        })
      )
      .query(async ({ input }) => {
        return db.getCatalogNovels({
          sort: input.sort || "new",
          filter: input.filter || "all",
          search: input.search,
          limit: input.limit || 50,
          offset: input.offset || 0,
        });
      }),

    browse: publicProcedure
      .input(
        z.object({
          sort: z.enum(["new", "popular"]).optional(),
          filter: z.enum(["all", "free"]).optional(),
          storyStatus: z.enum(["ongoing", "finished"]).optional(),
          search: z.string().max(100).optional(),
          page: z.number().int().positive().optional(),
          pageSize: z.number().int().min(1).max(100).optional(),
        })
      )
      .query(async ({ input }) => {
        const pageSize = input.pageSize || 20;
        const page = input.page || 1;
        const offset = (page - 1) * pageSize;

        return db.getBrowseCatalog({
          sort: input.sort || "new",
          filter: input.filter || "all",
          storyStatus: input.storyStatus,
          search: input.search,
          limit: pageSize,
          offset,
        });
      }),

    detail: publicProcedure.input(z.object({ novelId: z.number() })).query(async ({ input, ctx }) => {
      // Admins can view all novels (including archived), public users can only view published
      const isAdmin = ctx.user?.role === "admin";
      const novel = await db.getNovelById(input.novelId, !isAdmin); // publicOnly=true for non-admins
      if (!novel) throw new TRPCError({ code: "NOT_FOUND" });

      // Episode list intentionally NOT fetched here (used to call
      // getEpisodesByNovelId, a full `SELECT *` including every episode's
      // mediumtext `content`) - the frontend (NovelDetailPage.tsx) exclusively
      // uses the separate novels.episodes query for actual episode data
      // (which also needs per-episode purchase/entitlement enrichment this
      // procedure doesn't do), so that field was fetched and shipped over
      // the wire on every single novel-detail page view without ever being
      // read. See docs/PERFORMANCE_SEO_AUDIT.md.
      const categories = await db.getCategoriesByNovelId(input.novelId);

      return {
        novel,
        categories: categories.map((c: any) => c.category),
      };
    }),

    episodes: protectedProcedure.input(z.object({ novelId: z.number() })).query(async ({ input, ctx }) => {
      const episodes = await db.getEpisodesByNovelId(input.novelId);
      const isAdmin = ctx.user.role === "admin";
      // One batch query for all episodes' reading progress, instead of one
      // query per episode inside the loop below.
      const progressMap = await db.getReadingProgressBatch(ctx.user.id, episodes.map((ep: any) => ep.id));

      // Enrich episodes with purchase status. IMPORTANT: isPurchased/hasPurchased
      // must be computed from actual purchase records only (episodePurchases +
      // legacy purchases) - never from admin role or canReadEpisode(), otherwise
      // admin logins make every episode/file appear "purchased" in the UI.
      const enriched = await Promise.all(
        episodes.map(async (ep: any) => {
          const isFree = ep.isFree === true;
          const hasPurchased = await readerService.hasPurchasedEpisode(ctx.user.id, ep.id);
          const canRead = isFree || hasPurchased || isAdmin;
          const progress = progressMap.get(ep.id);

          // Never leak full episode content in the list endpoint - that's what
          // reader.getEpisode is for. Only expose fileUrl when the requester
          // actually has access - unpurchased paid legacy files must not leak
          // their real download URL. Since content/fileUrl are stripped
          // regardless of purchase status, the frontend can no longer use
          // their presence to classify sale type - it must use the explicit
          // saleMode/saleType metadata below instead.
          const { content, fileUrl, ...safeEpisode } = ep;

          const { hasContent, hasLegacyFile } = readerService.computeContentFlags(ep);
          // saleMode is the source of truth (with legacy fallback for rows
          // missing it); saleType mirrors it 1:1 and is kept as a separate
          // field name for the frontend's sale-type tab classification.
          const saleMode = readerService.resolveSaleMode(ep);
          const saleType = saleMode;

          return {
            ...safeEpisode,
            isFree,
            hasPurchased,
            isPurchased: hasPurchased,
            canRead,
            hasContent,
            hasLegacyFile,
            saleMode,
            saleType,
            fileUrl: canRead
              ? await resolveStoredFileValueSafe(fileUrl, "episodeFile", "novels.episodes")
              : null,
            adminCanPreview: isAdmin && !isFree && !hasPurchased,
            progressPercent: progress?.progressPercent ?? null,
            currentChapterNumber: progress?.currentChapterNumber ?? null,
            currentChapterTitle: progress?.currentChapterTitle ?? null,
          };
        })
      );

      return enriched;
    }),
  }),

  categories: router({
    list: publicProcedure.query(async () => {
      return db.getAllCategories();
    }),
  }),

  // ============ CART ============
  cart: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      const cart = await db.getOrCreateCart(ctx.user.id);
      if (!cart) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const items = await db.getCartItems(cart.id);

      // Enrich items with episode details
      const enriched = await Promise.all(
        items.map(async (item: any) => {
          const episode = await db.getEpisodeById(item.episodeId);
          const novel = await db.getNovelById(item.novelId);
          return {
            ...item,
            episode,
            novel,
          };
        })
      );

      return { cart, items: enriched };
    }),

    add: protectedProcedure
      .input(z.object({ episodeId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const episode = await db.getEpisodeById(input.episodeId);
        if (!episode) throw new TRPCError({ code: "NOT_FOUND" });

        // Free episodes cannot be added to cart
        if (episode.isFree) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Free episodes cannot be added to cart" });
        }

        // Cart/checkout is for package sales only. Single chapters must be
        // bought via the direct wallet-purchase flow (reader.purchaseEpisode),
        // never added to cart.
        const saleMode = readerService.resolveSaleMode(episode);
        if (saleMode === "chapter") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "รายบทต้องซื้อผ่านปุ่มซื้อทันที" });
        }

        // Check if already purchased (both wallet direct purchase and legacy
        // order-based purchase). Deliberately does NOT use canReadEpisode()/admin
        // role here - an admin browsing the store must still be able to add an
        // unpurchased paid episode to the cart for testing/verification.
        const hasPurchased = await readerService.hasPurchasedEpisode(ctx.user.id, input.episodeId);
        if (hasPurchased) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This episode has already been purchased" });
        }

        const cart = await db.getOrCreateCart(ctx.user.id);
        if (!cart) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        // Check if already in cart
        const items = await db.getCartItems(cart.id);
        const alreadyInCart = items.some((i: any) => i.episodeId === input.episodeId);
        if (alreadyInCart) {
          throw new TRPCError({ code: "CONFLICT", message: "This episode is already in your cart" });
        }

        await db.addToCart(cart.id, input.episodeId, episode.novelId, episode.price.toString());

        return { success: true };
      }),

    remove: protectedProcedure
      .input(z.object({ cartItemId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const item = await db.getCartItemById(input.cartItemId);
        if (!item) throw new TRPCError({ code: "NOT_FOUND" });
        const cart = await db.getCartById(item.cartId);
        if (!cart || cart.userId !== ctx.user.id) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Your cart is empty" });
        }
        await db.removeFromCart(input.cartItemId);
        return { success: true };
      }),

    clear: protectedProcedure.mutation(async ({ ctx }) => {
      const cart = await db.getOrCreateCart(ctx.user.id);
      if (cart) {
        await db.clearCart(cart.id);
      }
      return { success: true };
    }),
  }),

  // ============ CHECKOUT & ORDERS ============
  checkout: router({
    maintenanceStatus: publicProcedure.query(async () => {
      return getCheckoutMaintenanceStatus();
    }),
    activeCoupons: protectedProcedure
      .input(z.object({ subtotal: z.string() }).optional())
      .query(async ({ input, ctx }) => {
        return db.getActiveCouponsForCart(input?.subtotal, ctx.user.id);
      }),

    validateCoupon: protectedProcedure
      .input(z.object({ couponCode: z.string(), subtotal: z.string() }))
      .query(async ({ input, ctx }) => {
        try {
          const { discountAmount, coupon, normalizedCode } = await orderService.validateAndApplyCoupon(input.couponCode, input.subtotal, undefined, ctx.user.id);
          return {
            discountAmount,
            valid: true,
            coupon: {
              id: coupon.id,
              code: normalizedCode || coupon.code,
              discountType: coupon.discountType,
              discountValue: coupon.discountValue ? String(coupon.discountValue).trim() : "0.00",
              minPurchaseAmount: coupon.minPurchaseAmount ? String(coupon.minPurchaseAmount).trim() : "0.00",
              expiresAt: coupon.expiresAt,
            },
          };
        } catch (error: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: orderService.toSafeCouponClientMessage(error) });
        }
      }),

    create: protectedProcedure
      .input(
        z.object({
          couponCode: z.string().optional(),
          pointsToRedeem: z.string().optional(),
          slipImageUrl: optionalStoredFileRefSchema,
        })
      )
      .mutation(async ({ input, ctx }) => {
        await assertCheckoutAvailable("checkout.create");
        if (input.slipImageUrl) await assertSlipCheckoutAvailable("checkout.create.slip");
        const dbConnection = await db.getDb();
        if (!dbConnection) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        // Phase 1 - one short atomic transaction. Locks the cart row first
        // (SELECT ... FOR UPDATE), so a concurrent checkout.create for the
        // same cart either waits behind this transaction or - after this one
        // commits and clears the cart - correctly sees an empty cart instead
        // of creating a second Order. Order/OrderItems/Payment/cart-clear all
        // commit or roll back together: a failure anywhere in this phase
        // leaves no partial rows and the cart uncleared, safe to retry.
        // Never holds this transaction open across OCR/Storage/Discord/any
        // external network call - that all happens afterward, in Phase 2.
        let order: any;
        try {
          order = await dbConnection.transaction(async (tx: any) => {
            const cartId = await db.lockCartForCheckout(ctx.user.id, tx);
            if (cartId === null) {
              throw new TRPCError({ code: "BAD_REQUEST", message: "Your cart is empty. Please add items before checkout." });
            }

            // Re-read cart items only after the lock is held - never reuse
            // any cart/cartItems read before acquiring it, which could
            // already be stale (e.g. consumed by another request that
            // committed while this one was waiting for the lock). This must
            // itself be a locking read (FOR UPDATE), not a plain SELECT: the
            // cart-row lock above does not make a later plain read of the
            // separate cartItems table current on every backend - see
            // getCartItemsForUpdate's own comment in server/db.ts.
            const cartItems = await db.getCartItemsForUpdate(cartId, tx);
            if (cartItems.length === 0) {
              throw new TRPCError({ code: "BAD_REQUEST", message: "Your cart is empty. Please add items before checkout." });
            }

            const newOrder = await orderService.createOrderFromCart(
              String(ctx.user.id),
              cartItems,
              input.couponCode,
              input.pointsToRedeem,
              input.slipImageUrl,
              tx
            );

            if (input.slipImageUrl) {
              await db.updateOrder(newOrder.id, { paymentStatus: "submitted" }, tx);
            }

            await db.clearCart(cartId, tx);

            // Re-fetch within the same transaction so the returned order
            // reflects the paymentStatus update above, not the pre-update
            // snapshot createOrderFromCart returned.
            return (await db.getOrderById(newOrder.id, tx)) || newOrder;
          });
        } catch (error: any) {
          if (error instanceof TRPCError) throw error;
          const message = error?.message ? orderService.toSafeCouponClientMessage(error) : "Failed to create order";
          throw new TRPCError({ code: "BAD_REQUEST", message });
        }

        // Phase 2 - post-commit slip processing. The Order/OrderItems/Payment
        // are already durably committed and the cart already cleared - OCR,
        // Storage, and Discord calls all happen with no transaction held
        // open. A failure here must never be reported as a checkout failure
        // (the Order genuinely exists) and must never encourage the customer
        // to submit the same cart again - the Payment already has its slip
        // URL and submission timestamp, and the Order stays pending/submitted
        // for manual review or a later retry of slip processing alone.
        let slipResult: any = undefined;
        if (input.slipImageUrl) {
          try {
            slipResult = await submitPaymentSlip({
              orderId: order.id,
              slipImageUrl: input.slipImageUrl,
              userId: ctx.user.id,
            });
          } catch (error: any) {
            console.error(
              `[checkout.create] Post-commit slip processing failed for order ${order.id}: ${safeErrorSummary(error)}`
            );
            const payment = await db.getPaymentByOrderId(order.id);
            slipResult = {
              success: true,
              orderId: order.id,
              paymentId: payment?.id,
              status: "pending_review",
              slipImageUrl: input.slipImageUrl,
              isAutoApproved: false,
              isShadowMode: false,
              reviewReason: "OCR_PROCESSING_ERROR",
              processingDeferred: true,
            };
          }
        }

        return { ...order, slipResult };
      }),

    walletCheckout: protectedProcedure
      .input(z.object({ couponCode: z.string().optional(), pointsToRedeem: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        await assertCheckoutAvailable("checkout.walletCheckout");
        const cart = await db.getOrCreateCart(ctx.user.id);
        if (!cart) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        const cartItems = await db.getCartItems(cart.id);
        if (cartItems.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Cart is empty" });
        }

        try {
          // STEP 1: Calculate total amount BEFORE creating order
          // This requires simulating the order calculation without persisting
          let subtotal = 0;
          for (const item of cartItems) {
            const price = parseFloat(item.price?.toString() || "0");
            subtotal += price;
          }

          // Apply coupon if provided
          let discountAmount = 0;
          if (input.couponCode) {
            const { discountAmount: discount } = await orderService.validateAndApplyCoupon(input.couponCode, subtotal.toString(), undefined, ctx.user.id);
            discountAmount = parseFloat(discount);
          }

          // Apply points redemption if provided
          let pointsDiscountAmount = 0;
          if (input.pointsToRedeem && parseFloat(input.pointsToRedeem) > 0) {
            const requestedPoints = parseFloat(input.pointsToRedeem);
            const balanceStr = await db.getUserPointsBalance(ctx.user.id);
            const balance = parseFloat(balanceStr);
            if (requestedPoints > balance) {
              throw new Error(`Insufficient points balance. You have ${balance.toFixed(2)} points.`);
            }
            pointsDiscountAmount = Math.min(requestedPoints, subtotal - discountAmount);
          }

          // Calculate final total
          const totalAmount = Math.max(0, subtotal - discountAmount - pointsDiscountAmount).toFixed(2);

          // STEP 2: Check wallet balance BEFORE creating order
          const walletBalance = await db.getWalletBalance(ctx.user.id);
          if (parseFloat(walletBalance) < parseFloat(totalAmount)) {
            throw new Error("Insufficient wallet balance");
          }

          // STEP 3-8: ATOMIC TRANSACTION - All operations succeed or all rollback
          // This prevents orphan orders if debit/finalization fails after order creation
          const dbConnection = await db.getDb();
          if (!dbConnection) throw new Error("Database connection failed");
          
          const order = await dbConnection.transaction(async (tx) => {
            // STEP 3: Create order (within transaction)
            // Pass tx so all writes use the same transaction
            const newOrder = await orderService.createOrderFromCart(String(ctx.user.id), cartItems, input.couponCode, input.pointsToRedeem, undefined, tx);

            // STEP 4: Debit wallet (within transaction)
            // Pass tx so wallet debit uses the same transaction
            await db.debitWalletBalance(ctx.user.id, totalAmount, "order", newOrder.id, tx);
            
            // STEP 5: Update order status (within transaction)
            // Pass tx so order update uses the same transaction
            await db.updateOrder(newOrder.id, { status: "approved", paymentStatus: "approved" }, tx);
            
            // STEP 6: Update the payment record with wallet approval metadata (within transaction)
            // Pass tx so payment queries/updates use the same transaction
            const payment = await db.getPaymentByOrderId(newOrder.id, tx);
            if (payment) {
              // Use ApprovalService for wallet approval with metadata
              // CRITICAL: Pass tx to ensure approval metadata is written within the same transaction
              await ApprovalService.approvePaymentWithSource(payment.id, "wallet", {}, tx);
            }
            
            // STEP 7: Finalize order completion (points, purchases, coupon usage)
            // Pass tx so all finalization writes use the same transaction
            await orderService.finalizeOrderCompletion(newOrder.id, ctx.user.id, tx);
            
            // STEP 8: Clear cart (within transaction)
            // Pass tx so cart clear uses the same transaction
            await db.clearCart(cart.id, tx);
            
            return newOrder;
          });

          return { order, success: true };
        } catch (error: any) {
          const message = error?.message ? orderService.toSafeCouponClientMessage(error) : "Wallet checkout failed";
          throw new TRPCError({ code: "BAD_REQUEST", message });
        }
      }),
  }),

  orders: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const orders = await db.getOrdersByUserId(ctx.user.id);

      // Enrich with items
      const enriched = await Promise.all(
        orders.map(async (order: any) => {
          const items = await db.getOrderItems(order.id);
          const payment = await withResolvedSlipUrl(await db.getPaymentByOrderId(order.id), "orders.list");
          return { ...order, items, payment };
        })
      );

      return enriched;
    }),

    detail: protectedProcedure
      .input(z.object({ orderId: z.number() }))
      .query(async ({ input, ctx }) => {
        const order = await db.getOrderById(input.orderId);
        if (!order) throw new TRPCError({ code: "NOT_FOUND" });

        // Authorization check
        if (order.userId !== ctx.user.id && ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        const items = await db.getOrderItems(order.id);
        const payment = await withResolvedSlipUrl(await db.getPaymentByOrderId(order.id), "orders.detail");
        const history = await db.getOrderHistory(order.id);

        // Enrich items with purchase status
        const enrichedItems = await Promise.all(
          items.map(async (item: any) => {
            const purchase = order.userId ? await db.getPurchaseByUserAndEpisode(order.userId, item.episodeId) : undefined;
            return {
              ...item,
              purchase,
            };
          })
        );

        return { order, items: enrichedItems, payment, history };
      }),

    uploadPaymentSlip: protectedProcedure
      .input(z.object({ orderId: z.number(), slipImageUrl: requiredStoredFileRefSchema("Payment slip is required") }))
      .mutation(async ({ input, ctx }) => {
        await assertSlipCheckoutAvailable("orders.uploadPaymentSlip");
        // Use shared slip submission service
        const result = await submitPaymentSlip({
          orderId: input.orderId,
          slipImageUrl: input.slipImageUrl,
          userId: ctx.user.id,
        });

        return result;
      }),
  }),

  // ============ PAYMENT SLIP FILE UPLOAD (REAL S3 UPLOAD) ============
  payment: router({
    uploadSlipFile: protectedProcedure
      .input(
        z.object({
          fileName: z.string().min(1, "File name required"),
          mimeType: z.enum(["image/jpeg", "image/png", "application/pdf"]),
          fileBase64: z.string().min(1, "File data required"),
          context: z.enum(["checkout", "payment_page", "wallet"]).default("checkout"),
          orderTotal: z.number().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await assertSlipCheckoutAvailable(`payment.uploadSlipFile.${input.context}`);
        // Upload file to S3 using shared service
        const result = await uploadPaymentSlipFile({
          userId: ctx.user.id,
          fileName: input.fileName,
          mimeType: input.mimeType,
          fileBase64: input.fileBase64,
          context: input.context,
          orderTotal: input.orderTotal,
        });

        return result;
      }),
  }),

  // ============ MY NOVELS (PURCHASED CONTENT) ============
  myNovels: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const purchases = await db.getPurchasesByUserId(ctx.user.id);
      const progressMap = await db.getReadingProgressBatch(ctx.user.id, purchases.map((p) => p.episodeId));

      // Batch-fetch every referenced novel/episode in 2 queries total,
      // instead of the previous 1 getNovelById() + 1 getEpisodeById() call
      // PER purchase (a classic N+1: a user with 50 purchased episodes did
      // 100 sequential, awaited-in-a-loop DB round trips), and with lean
      // columns instead of getEpisodeById's `SELECT *` (which included every
      // purchased episode's full mediumtext `content`, never used here -
      // this page only ever displays id/episodeNumber/title). See
      // docs/PERFORMANCE_SEO_AUDIT.md.
      const novelIds = Array.from(new Set(purchases.map((p) => p.novelId)));
      const episodeIds = Array.from(new Set(purchases.map((p) => p.episodeId)));
      const [novelsLite, episodesLite] = await Promise.all([
        db.getNovelsByIdsLite(novelIds),
        db.getEpisodesByIdsLite(episodeIds),
      ]);
      const novelById = new Map(novelsLite.map((n: any) => [n.id, n]));
      const episodeById = new Map(episodesLite.map((e: any) => [e.id, e]));

      // Group by novel
      const novelMap = new Map();

      for (const purchase of purchases) {
        const novel = novelById.get(purchase.novelId);
        const episode = episodeById.get(purchase.episodeId);
        const progress = progressMap.get(purchase.episodeId);

        if (!novelMap.has(purchase.novelId)) {
          novelMap.set(purchase.novelId, {
            novel,
            episodes: [],
          });
        }

        novelMap.get(purchase.novelId).episodes.push({
          ...episode,
          purchasedAt: purchase.grantedAt,
          progressPercent: progress?.progressPercent ?? null,
          currentChapterNumber: progress?.currentChapterNumber ?? null,
          currentChapterTitle: progress?.currentChapterTitle ?? null,
        });
      }

      return Array.from(novelMap.values());
    }),

    episode: protectedProcedure
      .input(z.object({ episodeId: z.number() }))
      .query(async ({ input, ctx }) => {
        // Check access (both wallet direct purchase and order-based purchase)
        const canRead = await readerService.canReadEpisode(ctx.user.id, input.episodeId, ctx.user.role === "admin");
        if (!canRead) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        const episode = await db.getEpisodeById(input.episodeId);
        if (!episode) throw new TRPCError({ code: "NOT_FOUND" });

        return {
          ...episode,
          fileUrl: await resolveStoredFileValueSafe(episode.fileUrl, "episodeFile", "myNovels.episode"),
        };
      }),

    downloadUrl: protectedProcedure
      .input(z.object({ episodeId: z.number() }))
      .query(async ({ input, ctx }) => {
        // Check access (both wallet direct purchase and order-based purchase)
        const canRead = await readerService.canReadEpisode(ctx.user.id, input.episodeId, ctx.user.role === "admin");
        if (!canRead) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        const episode = await db.getEpisodeById(input.episodeId);
        if (!episode || !episode.fileUrl) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }

        // Access already confirmed above - now (and only now) turn the
        // stored reference into an actual working link. A legacy absolute
        // URL passes through unchanged; a private object reference becomes
        // a fresh, short-lived presigned URL.
        const downloadUrl = await resolveStoredFileValueOrThrow(episode.fileUrl, "episodeFile", "myNovels.downloadUrl");
        return { downloadUrl };
      }),
  }),

  // ============ POINTS ============
  points: router({
    balance: protectedProcedure.query(async ({ ctx }) => {
      const balance = await db.getUserPointsBalance(ctx.user.id);
      return { balance };
    }),

    history: protectedProcedure.query(async ({ ctx }) => {
      const history = await db.getPointsHistory(ctx.user.id, 50);
      return history;
    }),

    admin: router({
      adjustBalance: adminProcedure
        .input(z.object({ userId: z.number(), amount: z.string(), reason: z.string() }))
        .mutation(async ({ ctx, input }) => {
          const amountNum = parseFloat(input.amount);
          if (isNaN(amountNum)) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid amount" });
          }
          if (amountNum === 0) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Amount must be non-zero" });
          }
          // Bidirectional points adjustment: positive = add, negative = subtract
          const absAmount = Math.abs(amountNum);
          const operation = amountNum > 0 ? "add" : "subtract";

          // Locked read-modify-write: this used to read the balance and
          // insert the adjustment as two separate, unwrapped statements -
          // no transaction, no lock - so a concurrent adjustment (or any
          // other points writer for the same user) could race it and lose
          // an update. withUserPointsLock opens its own transaction here
          // since none was open before.
          const newBalance = await db.withUserPointsLock(input.userId, undefined, async (lockedTx) => {
            const currentBalance = parseFloat(await db.getUserPointsBalance(input.userId, lockedTx));
            const updatedBalance =
              operation === "add" ? currentBalance + absAmount : currentBalance - absAmount;
            const balanceAfter = updatedBalance.toString();
            await db.recordPointsTransaction(
              {
                userId: input.userId,
                amount: (operation === "add" ? absAmount : -absAmount).toString(),
                type: "adjust",
                balanceAfter,
                note: `Admin ${operation}: ${input.reason}`,
              },
              lockedTx
            );
            return balanceAfter;
          });

          return { success: true, newBalance, operation };
        }),
    }),
  }),

  // ============ WISHLISTS ============
  wishlists: router({
    // Single joined query (see db.getWishlistNovelsByUserId) - no per-row
    // getNovelById() N+1. Archived novels are excluded by the query itself,
    // never surfaced to /profile even if they were wishlisted before being
    // archived. A database outage is caught here and turned into a generic
    // SERVICE_UNAVAILABLE - getWishlistNovelsByUserId deliberately THROWS
    // (never returns []) when it can't reach the database, since [] is a
    // real, meaningful "no wishlist items" result that a DB outage must
    // never be confused with (the UI would otherwise show an Empty state
    // instead of an Error state for what is actually an outage).
    list: protectedProcedure.query(async ({ ctx }) => {
      try {
        return await db.getWishlistNovelsByUserId(ctx.user.id);
      } catch (error) {
        console.error("[wishlists.list] Unexpected error", safeErrorSummary(error));
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "ไม่สามารถโหลดรายการอยากอ่านได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง",
        });
      }
    }),

    // Lightweight companion to `list` - just the id/novelId pairs needed to
    // drive a wishlist heart icon (e.g. on the /novels browse grid), without
    // `list`'s N+1 getNovelById() enrichment per row.
    ids: protectedProcedure.query(async ({ ctx }) => {
      const wishlists = await db.getWishlistsByUserId(ctx.user.id);
      return wishlists.map((w: any) => ({ id: w.id, novelId: w.novelId }));
    }),

    add: protectedProcedure
      .input(z.object({ novelId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        // Confirmed available BEFORE the novel-exists check - a database
        // outage must never be reported as "novel not found" (getNovelById
        // returns undefined either way, indistinguishable from "no such
        // novel" on its own).
        try {
          await db.assertDatabaseAvailable();
        } catch (error) {
          console.error("[wishlists.add] Database unavailable", safeErrorSummary(error));
          throw new TRPCError({
            code: "SERVICE_UNAVAILABLE",
            message: "ไม่สามารถบันทึกรายการอยากอ่านได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง",
          });
        }

        // getNovelById defaults to publicOnly=true, so this also rejects an
        // archived novel's id the same way as one that never existed - a
        // wishlist row must never be created pointing at either.
        const novel = await db.getNovelById(input.novelId);
        if (!novel) {
          throw new TRPCError({ code: "NOT_FOUND", message: "ไม่พบนิยายที่ต้องการบันทึก" });
        }

        const existing = await db.getWishlistByUserAndNovel(ctx.user.id, input.novelId);
        if (existing) {
          throw new TRPCError({ code: "CONFLICT", message: "เรื่องนี้อยู่ในรายการอยากอ่านแล้ว" });
        }

        // The check above is best-effort (TOCTOU) - the DB's own
        // unique_user_novel constraint on (userId, novelId) is the real
        // guard against a race between two concurrent adds, mapped back to
        // the same CONFLICT a sequential duplicate gets. Any other insert
        // failure is logged safely and reported as a generic outage, never
        // the raw driver error.
        try {
          await db.addToWishlist(ctx.user.id, input.novelId);
        } catch (error) {
          if (isDuplicateKeyError(error)) {
            throw new TRPCError({ code: "CONFLICT", message: "เรื่องนี้อยู่ในรายการอยากอ่านแล้ว" });
          }
          console.error("[wishlists.add] Unexpected error while inserting", safeErrorSummary(error));
          throw new TRPCError({
            code: "SERVICE_UNAVAILABLE",
            message: "ไม่สามารถบันทึกรายการอยากอ่านได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง",
          });
        }
        return { success: true };
      }),

    remove: protectedProcedure
      .input(z.object({ wishlistId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const wishlist = await db.getWishlistById(input.wishlistId);
        if (!wishlist) throw new TRPCError({ code: "NOT_FOUND" });
        if (wishlist.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        await db.removeFromWishlist(input.wishlistId);
        return { success: true };
      }),
  }),

  // ============ DAILY CHECK-IN ============
  // getStatus is intentionally public (not protectedProcedure) - it must
  // return a clean { authenticated: false } for anonymous visitors so the
  // UI can render a login CTA, instead of the generic UNAUTHORIZED error a
  // protectedProcedure would throw. claim is the actual write path and
  // stays protected: an anonymous claim attempt must be rejected outright.
  dailyCheckin: router({
    getStatus: publicProcedure.query(async ({ ctx }) => {
      if (!ctx.user) {
        // Anonymous stays deliberately minimal - no dates, no balances, no
        // campaign internals leak to a visitor who cannot claim anything.
        return { authenticated: false as const };
      }
      try {
        const status = await db.getDailyCheckinStatus(ctx.user.id);
        return { authenticated: true as const, ...status };
      } catch (error: any) {
        // Never let a raw DB/SQL error (table name, column name, query
        // shape) reach the client - log full detail server-side only. See
        // docs/DAILY_CHECKIN_DEPLOYMENT_FIX.md PART B.
        console.error("[dailyCheckin.getStatus] failed", { userId: ctx.user.id, message: error?.message });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Unable to load check-in information. Please try again.",
        });
      }
    }),

    claim: protectedProcedure.mutation(async ({ ctx }) => {
      try {
        return await db.claimDailyCheckin(ctx.user.id);
      } catch (error: any) {
        console.error("[dailyCheckin.claim] failed", { userId: ctx.user.id, message: error?.message });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Unable to process check-in right now. Please try again.",
        });
      }
    }),
  }),

  // ============ FILE MANAGEMENT ============
  files: fileRouter,

  // ============ ADMIN ROUTES ============
  // No more local email/password admin login here (see
  // security/remove-local-admin-password-login) - an admin signs in
  // through the exact same Manus/Google/transition flow as every other
  // user (see server/routers.ts's auth router / server/_core/googleOAuth.ts
  // / server/_core/oauth.ts), and every procedure below is still gated by
  // adminProcedure, which checks the normal session's ctx.user.role ===
  // "admin" exactly as before - nothing about admin AUTHORIZATION changed,
  // only the removed local-password AUTHENTICATION path.
  admin: router({
    ocr: ocrMetricsRouter,

    payments: router({
      pending: adminProcedure.query(async () => {
        const payments = await db.getPendingPayments(50);

        const enriched = await Promise.all(
          payments.map(async (p: any) => {
            const order = await db.getOrderById(p.orderId);
            const items = order ? await db.getOrderItems(order.id) : [];
            const user = order?.userId ? await db.getUserById(order.userId) : null;
            
            // Include approval metadata with display formatting
            const approvalMetadata = ApprovalService.getDisplayMetadata(p);
            const formattedApprovalSource = ApprovalService.formatApprovalSource(p.approvalSource);

            return {
              ...p,
              slipImageUrl: await resolveStoredFileValueSafe(p.slipImageUrl, "paymentSlip", "admin.payments.pending"),
              order,
              items,
              user,
              approvalMetadata,
              formattedApprovalSource,
            };
          })
        );

        return enriched;
      }),

      approve: adminProcedure
        .input(z.object({ paymentId: z.number() }))
        .mutation(async ({ input, ctx }) => {
          try {
            await orderService.approvePayment(input.paymentId, String(ctx.user.id));
            return { success: true };
          } catch (error: any) {
            // Anti-replay refusal: the slip was claimed by another
            // submission, possibly after this admin loaded the page. CONFLICT
            // (not BAD_REQUEST) so the UI can tell "stale page, refresh and
            // recheck" apart from "this request was malformed".
            if (typeof error?.message === "string" && error.message.startsWith("SLIP_ALREADY_CLAIMED")) {
              throw new TRPCError({ code: "CONFLICT", message: error.message });
            }
            // No strong identifier: normal Approve must not silently bypass
            // anti-replay. PRECONDITION_FAILED so the UI can distinguish
            // "someone else owns this slip" from "this slip cannot be
            // protected at all and needs the legacy override".
            if (typeof error?.message === "string" && error.message.startsWith("NO_STRONG_IDENTIFIER")) {
              throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
            }
            // An unresolved legacy case ambiguity. Distinct from a duplicate:
            // the admin must choose reject-as-duplicate or approve-as-distinct
            // via resolveLegacyCaseAmbiguity. Normal Approve must neither
            // bypass it nor fail forever.
            if (
              typeof error?.message === "string" &&
              error.message.startsWith("LEGACY_CASE_AMBIGUITY_REQUIRES_RESOLUTION")
            ) {
              throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
            }
            throw new TRPCError({ code: "BAD_REQUEST", message: error?.message || "Failed to approve payment. Please try again." });
          }
        }),

      reject: adminProcedure
        .input(z.object({ paymentId: z.number(), rejectionReason: z.string() }))
        .mutation(async ({ input, ctx }) => {
          try {
            await orderService.rejectPayment(input.paymentId, String(ctx.user.id), input.rejectionReason);
            return { success: true };
          } catch (error: any) {
            throw new TRPCError({ code: "BAD_REQUEST", message: error?.message || "Failed to reject payment. Please try again." });
          }
        }),

      approved: adminProcedure.query(async () => {
        const payments = await db.getRecentlyApprovedPayments(50);

        const enriched = await Promise.all(
          payments.map(async (p: any) => {
            const order = await db.getOrderById(p.orderId);
            const items = order ? await db.getOrderItems(order.id) : [];
            const user = order?.userId ? await db.getUserById(order.userId) : null;
            
            const approvalMetadata = ApprovalService.getDisplayMetadata(p);
            const formattedApprovalSource = ApprovalService.formatApprovalSource(p.approvalSource);

            return {
              ...p,
              slipImageUrl: await resolveStoredFileValueSafe(p.slipImageUrl, "paymentSlip", "admin.payments.approved"),
              order,
              items,
              user,
              approvalMetadata,
              formattedApprovalSource,
            };
          })
        );

        return enriched;
      }),
    }),

    orders: router({
      list: adminProcedure
        .input(
          z.object({
            page: z.number().int().positive().default(1),
            userId: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)]).transform(val => typeof val === 'string' ? parseInt(val, 10) : val).optional(),
            pageSize: z.number().int().positive().default(20),
            search: z.string().optional(),
            sortBy: z.enum(['createdAt', 'updatedAt', 'amount', 'discount']).default('createdAt'),
            sortOrder: z.enum(['asc', 'desc']).default('desc'),
            status: z.string().optional(),
            paymentStatus: z.string().optional(),
            startDate: z.date().optional(),
            endDate: z.date().optional(),
            hasDiscount: z.boolean().optional(),
            minAmount: z.number().optional(),
            maxAmount: z.number().optional(),
          })
        )
        .query(async ({ input }) => {
          const result = await db.getAdminOrdersWithUsers({
            page: input.page,
            pageSize: input.pageSize,
            userId: input.userId,
            search: input.search,
            sortBy: input.sortBy,
            sortOrder: input.sortOrder,
            status: input.status,
            paymentStatus: input.paymentStatus,
            startDate: input.startDate,
            endDate: input.endDate,
            hasDiscount: input.hasDiscount,
            minAmount: input.minAmount,
            maxAmount: input.maxAmount,
          });

          // Enrich orders with approval metadata from payments
          if (result.orders && Array.isArray(result.orders)) {
            result.orders = await Promise.all(
              result.orders.map(async (order: any) => {
                const payment = await db.getPaymentByOrderId(order.id);
                if (payment) {
                  const approvalMetadata = ApprovalService.getDisplayMetadata(payment);
                  let approvedByName = approvalMetadata.approvedByLabel;
                  
                  // If manual approval, fetch admin user name
                  if (payment.approvalSource === 'manual' && payment.approvedByAdminId) {
                    const adminUser = await db.getUserById(payment.approvedByAdminId);
                    if (adminUser) {
                      approvedByName = `Approved By Admin, ${adminUser.name}`;
                    }
                  }
                  
                  return {
                    ...order,
                    approvalMetadata,
                    formattedApprovalSource: ApprovalService.formatApprovalSource(payment.approvalSource),
                    approvedByName,
                  };
                }
                return order;
              })
            );
          }

          return result;
        }),

      detail: adminProcedure
        .input(z.object({ orderId: z.number() }))
        .query(async ({ input }) => {
          const order = await db.getOrderById(input.orderId);
          if (!order) throw new TRPCError({ code: "NOT_FOUND" });

          const items = await db.getOrderItems(order.id);
          const rawPayment = await db.getPaymentByOrderId(order.id);
          const history = await db.getOrderHistory(order.id);

          // Include approval metadata if payment exists
          let approvalMetadata = null;
          let formattedApprovalSource = null;
          if (rawPayment) {
            approvalMetadata = ApprovalService.getDisplayMetadata(rawPayment);
            formattedApprovalSource = ApprovalService.formatApprovalSource(rawPayment.approvalSource);
          }

          const payment = await withResolvedSlipUrl(rawPayment, "admin.orders.detail");

          // ── ONE SOURCE OF TRUTH FOR THE FRESHNESS WINDOW ────────────────
          // The admin panel previously recomputed freshness against a
          // hard-coded 120 minutes while the server verified against the
          // EFFECTIVE config, so any deployment with a different window saw a
          // checklist that disagreed with the actual decision. The effective
          // value is now returned and the panel renders THIS number.
          const ocrConfig = await getEffectiveOCRConfig();

          // ── DUPLICATE STATE (read-only, admin-only) ─────────────────────
          // Derived server-side so the panel never has to infer duplicate
          // strength from a legacy fingerprint.
          let duplicate:
            | {
                strength: "strong" | "legacy_case_ambiguity" | "unresolved" | "legacy_case_ambiguity_group" | "known_collision";
                kind?: string;
                matchedSourceType: "order_payment" | "wallet_topup";
                matchedSourceId: number;
                /** Resolved server-side; the client never derives a URL. */
                matchedOrderId?: number;
                viaLegacyCompatibility?: boolean;
                advisory?: true;
                requiresAdminResolution?: true;
              }
            | undefined;
          let reviewReasonOverride: string | undefined;
          let fileIdentifierStatus: "AVAILABLE" | "MATCH" | "UNAVAILABLE" = "UNAVAILABLE";
          let recipient: ReturnType<typeof verifyRecipient> | undefined;

          if (rawPayment?.extractedData) {
            const { identifiers } = deriveStrongIdentifiersFromExtractedData(
              rawPayment.extractedData as string
            );
            const database = await db.getDb();
            if (database && hasStrongIdentifier(identifiers)) {
              // ── THE SAME CLASSIFIER THE CLAIM PATH USES ─────────────────
              // This query previously ran its own exact-only lookup: no raw
              // reference, so no uppercase candidate, and no consultation of
              // the indexed alias. For a mixed-case reference submitted while
              // auto-approval is disabled or shadowed, NOTHING ever records
              // the ambiguity - so the panel showed no conflict, hid the
              // resolution controls, and normal Approve then refused the
              // payment with no way for the admin to act on it.
              //
              // Detail discovery must not be a second implementation of a
              // financial decision: alias lookup, the historical scan and
              // exact-over-lossy priority all stay inside the shared
              // evaluator.
              const conflict = await evaluateSlipConflict(
                {
                  identifiers,
                  rawReference: getRawReferenceForLegacyLookup(
                    rawPayment.extractedData as string
                  ),
                  sourceType: "order_payment",
                  sourceId: rawPayment.id,
                },
                database
              );

              if (conflict.kind === "strong_duplicate") {
                duplicate = {
                  strength: "strong",
                  kind: conflict.matchedKind,
                  matchedSourceType: conflict.matchedSourceType,
                  matchedSourceId: conflict.matchedSourceId,
                  viaLegacyCompatibility: conflict.viaLegacyCompatibility,
                };
              } else if (conflict.kind === "legacy_case_ambiguity") {
                // ADVISORY. Never described as a confirmed duplicate: the
                // fold is lossy, and normal Approve stays blocked until an
                // admin resolves it explicitly.
                duplicate = {
                  strength: "legacy_case_ambiguity",
                  matchedSourceType: conflict.matchedSourceType,
                  matchedSourceId: conflict.matchedSourceId,
                  advisory: true,
                  requiresAdminResolution: true,
                };
                reviewReasonOverride = "LEGACY_REFERENCE_CASE_AMBIGUITY";
              } else if (conflict.kind === "unresolved") {
                // An approved historical row exists that could not be
                // verified at all - not a proven duplicate, not provably
                // clean. Reflects the SAME state normal Approve and Recheck
                // see: Approve refuses with LEGACY_APPROVED_SLIP_UNRESOLVED
                // (server/services/slipClaimService.ts), so the panel must
                // never show this as READY or as a confirmed duplicate.
                //
                // Deliberately NOT `requiresAdminResolution: true` - that
                // flag drives the audited "confirm distinct" resolution flow
                // built specifically for the lossy legacy-case fold, which
                // this state is not. An unresolved row needs manual
                // investigation (e.g. recovering the historical slip image),
                // not a casing-fold adjudication.
                duplicate = {
                  strength: "unresolved",
                  matchedSourceType: conflict.matchedSourceType,
                  matchedSourceId: conflict.matchedSourceId,
                  advisory: true,
                };
                reviewReasonOverride = "LEGACY_APPROVED_SLIP_UNRESOLVED";
              } else if (conflict.kind === "legacy_case_ambiguity_group") {
                // MORE THAN ONE historical source shares this alias. Reflects
                // the SAME state normal Approve and Recheck see: Approve
                // refuses with LEGACY_ALIAS_GROUP_AMBIGUITY
                // (server/services/slipClaimService.ts) and never consults a
                // resolution, since any such resolution could only ever have
                // adjudicated one arbitrary member of the group.
                //
                // Deliberately NOT `requiresAdminResolution: true` - the
                // single-member "confirm distinct" flow does not apply here;
                // the group needs manual investigation as a whole.
                duplicate = {
                  strength: "legacy_case_ambiguity_group",
                  matchedSourceType: conflict.matchedSourceType,
                  matchedSourceId: conflict.matchedSourceId,
                  advisory: true,
                };
                reviewReasonOverride = "LEGACY_ALIAS_GROUP_AMBIGUITY";
              } else if (conflict.kind === "known_collision") {
                // This submission's own strong identifier durably matches a
                // KNOWN historical collision (paymentSlipLegacyCollisions).
                // Reflects the SAME state normal Approve sees: it refuses
                // with LEGACY_KNOWN_COLLISION and never consults a waiver.
                duplicate = {
                  strength: "known_collision",
                  kind: conflict.matchedKind,
                  matchedSourceType: conflict.matchedSourceType,
                  matchedSourceId: conflict.matchedSourceId,
                  advisory: true,
                };
                reviewReasonOverride = "LEGACY_KNOWN_COLLISION";
              }

              if (duplicate) {
                // Navigation is resolved HERE - an order payment id is not an
                // order id, and the client must never guess one.
                const nav = await resolveMatchedSourceNavigation(
                  duplicate.matchedSourceType,
                  duplicate.matchedSourceId,
                  database
                );
                duplicate.matchedOrderId = nav.orderId;
              }
            }
            fileIdentifierStatus = describeFileIdentifierStatus({
              fileHash: identifiers.fileHash,
              duplicateFileMatch: duplicate?.kind === "file",
            });

            // Recipient verdict recomputed SERVER-SIDE from the stored
            // extraction, using the same function verifySlipData gates on.
            // Recomputing (rather than reading a persisted flag) means legacy
            // rows written before the gate existed are graded correctly too,
            // and the panel never re-decides this in client constants.
            try {
              const parsedExtracted = JSON.parse(rawPayment.extractedData as string);
              recipient = verifyRecipient(parsedExtracted);
            } catch {
              recipient = undefined;
            }
          }

          return {
            order,
            items,
            payment,
            history,
            approvalMetadata,
            formattedApprovalSource,
            ocrMeta: {
              effectiveWindowMinutes: ocrConfig.maxTimeWindowMinutes,
              minConfidence: ocrConfig.minConfidence,
              duplicate,
              fileIdentifierStatus,
              recipient,
              // Set when the detail query itself discovered an unresolved
              // legacy case ambiguity, so the panel can render the resolution
              // controls without an admin having to run Recheck first.
              reviewReason: reviewReasonOverride ?? (rawPayment?.reviewReason as string | undefined),
            },
          };
        }),

         approve: adminProcedure
        .input(z.object({ orderId: z.number(), reason: z.string().optional() }))
        .mutation(async ({ input, ctx }) => {
          const order = await db.getOrderById(input.orderId);
          if (!order) throw new TRPCError({ code: "NOT_FOUND" });
          if (order.status !== "pending") {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Order is not pending" });
          }
          // Use centralized service: sets approvalSource=manual, approvedByAdminId,
          // approvedByLabel, approvedAt, reviewedAt, reviewedByUserId, finalizes order
          const payment = await db.getPaymentByOrderId(input.orderId);
          if (!payment) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "No payment record found for this order" });
          }
          try {
            await orderService.approvePayment(
              payment.id,
              String(ctx.user.id),
              ctx.user.name || "Admin"
            );
          } catch (error: any) {
            // See admin.payments.approve above - a claimed slip is a
            // CONFLICT the admin can act on, not a malformed request.
            if (typeof error?.message === "string" && error.message.startsWith("SLIP_ALREADY_CLAIMED")) {
              throw new TRPCError({ code: "CONFLICT", message: error.message });
            }
            // No strong identifier: normal Approve must not silently bypass
            // anti-replay. PRECONDITION_FAILED so the UI can distinguish
            // "someone else owns this slip" from "this slip cannot be
            // protected at all and needs the legacy override".
            if (typeof error?.message === "string" && error.message.startsWith("NO_STRONG_IDENTIFIER")) {
              throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
            }
            // An unresolved legacy case ambiguity. Distinct from a duplicate:
            // the admin must choose reject-as-duplicate or approve-as-distinct
            // via resolveLegacyCaseAmbiguity. Normal Approve must neither
            // bypass it nor fail forever.
            if (
              typeof error?.message === "string" &&
              error.message.startsWith("LEGACY_CASE_AMBIGUITY_REQUIRES_RESOLUTION")
            ) {
              throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
            }
            throw new TRPCError({ code: "BAD_REQUEST", message: error?.message || "Failed to approve payment. Please try again." });
          }
          return { success: true };
        }),
      /**
       * Re-runs OCR + verification against the slip already on file.
       *
       * Diagnostic ONLY. It cannot approve, cannot reject, and cannot change
       * payment or order status - see ocrRecheckService for the guarantees
       * and the tests that enforce them. When verification passes it reports
       * readyForAdminApproval so an admin can then press Approve, which runs
       * its own independent anti-replay claim.
       */
      recheckOcr: adminProcedure
        .input(z.object({ paymentId: z.number().int().positive() }))
        .mutation(async ({ input, ctx }) => {
          return recheckOrderPaymentOcr({
            paymentId: input.paymentId,
            adminUserId: ctx.user.id,
          });
        }),

      /**
       * Resolves a LEGACY REFERENCE CASE AMBIGUITY - admin only.
       *
       * The alias that triggers this is lossy, so no automated path can
       * decide it. This is the escape route that stops such a payment being
       * permanently unapprovable. It is NOT a generic override: the ambiguity
       * is revalidated server-side, a real strong identifier is still
       * required, the normal atomic claim still runs, and the decision is
       * permanently audited with a mandatory reason.
       */
      resolveLegacyCaseAmbiguity: adminProcedure
        .input(
          z.object({
            paymentId: z.number().int().positive(),
            decision: z.enum(["confirmed_distinct", "confirmed_duplicate"]),
            reason: z.string().trim().min(10).max(1000),
          })
        )
        .mutation(async ({ input, ctx }) => {
          return resolveLegacyCaseAmbiguity({
            subjectType: "order_payment",
            subjectId: input.paymentId,
            adminUserId: ctx.user.id,
            adminLabel: ctx.user.name || "Admin",
            decision: input.decision,
            reason: input.reason,
          });
        }),

      /** Sanitized OCR attempt history for the admin detail panel. */
      ocrAttempts: adminProcedure
        .input(z.object({ paymentId: z.number().int().positive() }))
        .query(async ({ input }) => {
          return getOcrAttemptHistory("order_payment", input.paymentId);
        }),

      reject: adminProcedure
        .input(z.object({ orderId: z.number(), rejectionReason: z.string() }))
        .mutation(async ({ input, ctx }) => {
          const order = await db.getOrderById(input.orderId);
          if (!order) throw new TRPCError({ code: "NOT_FOUND" });
          if (order.status !== "pending") {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Order is not pending" });
          }
          // Use centralized service: sets reviewedAt, reviewedByUserId, rejectionReason
          const payment = await db.getPaymentByOrderId(input.orderId);
          if (!payment) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "No payment record found for this order" });
          }
          try {
            await orderService.rejectPayment(
              payment.id,
              String(ctx.user.id),
              input.rejectionReason
            );
          } catch (error: any) {
            throw new TRPCError({ code: "BAD_REQUEST", message: error?.message || "Failed to reject payment. Please try again." });
          }
          return { success: true };
        }),
    }),
    dashboard: dashboardRouter,

    users: router({
      // Server-side paginated/searched/filtered/sorted user list - see
      // db.getAdminUsersList for the explicit safe-column allowlist
      // (never openId/passwordHash) and the EXISTS-based googleConnection
      // filter (never a LEFT JOIN, so a user is never duplicated).
      list: adminProcedure
        .input(
          z.object({
            page: z.number().int().positive().default(1),
            pageSize: z.union([z.literal(20), z.literal(50), z.literal(100)]).default(20),
            search: z.string().trim().max(200).optional(),
            role: z.enum(["user", "admin"]).optional(),
            googleConnection: z.enum(["connected", "not_connected"]).optional(),
            sortBy: z.enum(["id", "name", "email", "createdAt", "lastSignedIn"]).optional(),
            sortOrder: z.enum(["asc", "desc"]).optional(),
          })
        )
        .query(async ({ input }) => {
          return db.getAdminUsersList(input);
        }),

      // name/role only - email/openId/loginMethod/passwordHash/Google
      // identity/createdAt/lastSignedIn are all read-only from this page by
      // design (no input field exists for any of them at all). Every role-
      // safety rule (self-demotion, last-admin, Google-identity-required-
      // to-promote) is re-verified server-side inside
      // updateAdminUserProfile's own locked transaction - never trusted
      // from the client beyond the confirmation text match.
      update: adminProcedure
        .input(
          z.object({
            userId: z.number().int().positive(),
            name: z.union([z.string().max(255), z.null()]).optional(),
            role: z.enum(["user", "admin"]).optional(),
            reason: z.string().trim().min(5, "A reason is required").max(500),
            confirmText: z.string().optional(),
          })
        )
        .mutation(async ({ input, ctx }) => {
          // Empty/whitespace-only name normalizes to null - "Empty name ให้
          // Normalize เป็น null" - but `undefined` (field not supplied at
          // all) is preserved as "don't touch this field", never coerced
          // to null.
          const normalizedName =
            input.name === undefined
              ? undefined
              : input.name === null || input.name.trim() === ""
                ? null
                : input.name.trim();

          try {
            return await updateAdminUserProfile({
              actorAdminId: ctx.user.id,
              userId: input.userId,
              name: normalizedName,
              role: input.role,
              reason: input.reason,
              confirmText: input.confirmText,
            });
          } catch (error) {
            throw mapAdminUserManagementError(error);
          }
        }),

      // Hard-delete (`deleteAssessment` + `delete`) is DELIBERATELY NOT
      // exposed here - PR #45 security review finding: the transaction only
      // locks the target `users` row (SELECT ... FOR UPDATE); every business
      // table it checks (orders, carts, wallet, points, ...) uses a plain,
      // unenforced `userId` int with no foreign key back to `users.id` (see
      // drizzle/schema.ts), so locking `users` alone cannot stop a
      // concurrent INSERT into any of those tables from racing past the
      // assessment read and landing AFTER the delete commits - the delete
      // transaction can observe zero blockers, and a concurrent write can
      // still leave an orphaned business row behind. Fixing this for real
      // requires either DB-enforced constraints across every referencing
      // table (verified with a real MariaDB integration test using at least
      // two concurrent connections) or an equivalent application-level
      // guarantee - neither exists yet. The underlying implementation
      // (server/services/adminUserManagementService.ts's
      // deleteAdminUserSafely, server/db.ts's getAdminUserDeleteAssessment)
      // is kept, tested, and correct AS FAR AS IT GOES, specifically so this
      // gap can be closed and the endpoint re-added as follow-up work once
      // the concurrency fix is designed and proven - it is just never wired
      // to a reachable procedure in this PR.
    }),

    // Deprecated: fetches every episode row (all novels) including the full
    // mediumtext `content` column - heavy, unpaginated. Kept only for
    // AdminEpisodeImportPage.tsx and AdminNovelManagePage.tsx, which already
    // scope it to one novelId client-side. New code should use the paginated
    // admin.episodes.list (list view) / admin.episodes.detail (single row).
    getAllEpisodes: adminProcedure.query(async () => {
      return db.getAllEpisodes();
    }),

    novels: router({
      uploadCover: adminProcedure
        .input(
          z.object({
            fileName: z.string().min(1),
            mimeType: z.enum(BANNER_IMAGE_MIME_TYPES),
            fileBase64: z.string().min(1),
          })
        )
        .mutation(async ({ input, ctx }) => {
          const base64Data = input.fileBase64.split(",")[1] || input.fileBase64;
          const fileBuffer = Buffer.from(base64Data, "base64");

          if (fileBuffer.length > MAX_BANNER_IMAGE_SIZE) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Cover image must be 5MB or smaller",
            });
          }

          // Optimized to WebP and uploaded to Cloudflare R2 (not the Manus
          // storage proxy) - cuts bandwidth on the highest-traffic image type
          // in the app. Existing coverImageUrl values already in the DB keep
          // pointing at the old storage and still render unchanged.
          const { url, key } = await optimizeAndUploadToR2(
            fileBuffer,
            `novel-covers/${ctx.user.id}`,
            NOVEL_COVER_MAX_DIMENSIONS
          );

          return { url, key };
        }),

      // Lightweight novel detail for the admin manage page - deliberately
      // never fetches episodes (unlike the public novels.detail, which
      // pulls every episode column including mediumtext content via
      // getEpisodesByNovelId). Episode counts come from a single grouped
      // aggregate query; the actual episode list is a separate paginated
      // admin.episodes.list({ novelId }) call from the client.
      detail: adminProcedure
        .input(z.object({ novelId: z.number() }))
        .query(async ({ input }) => {
          // publicOnly=false - admins can view archived novels too.
          const novel = await db.getNovelById(input.novelId, false);
          if (!novel) throw new TRPCError({ code: "NOT_FOUND" });

          const [categoriesRaw, stats] = await Promise.all([
            db.getCategoriesByNovelId(input.novelId),
            db.getNovelEpisodeStats(input.novelId),
          ]);

          return {
            novel,
            categories: categoriesRaw.map((c: any) => c.category),
            stats,
          };
        }),

      list: adminProcedure
        .input(
          z.object({
            q: z.string().trim().max(200).optional(),
            limit: z.number().int().positive().max(50).optional(),
          }).optional()
        )
        .query(async ({ input }) => {
          // No input at all - preserve the original unlimited full-list
          // behavior for existing callers (e.g. AdminNovelsPage).
          if (!input?.q && !input?.limit) {
            return db.getAllNovelsForAdmin();
          }
          return db.searchNovelsForAdmin(input.q, input.limit ?? 30);
        }),

      create: adminProcedure
        .input(
          z.object({
            title: z.string(),
            author: z.string().optional(),
            description: z.string().optional(),
            coverImageUrl: z.string().optional(),
            publicationStatus: z.enum(["published", "archived"]).default("published"),
            storyStatus: z.enum(["ongoing", "finished"]).default("ongoing"),
          })
        )
        .mutation(async ({ input }) => {
          const result = await db.createNovel(input);
          return result;
        }),

      update: adminProcedure
        .input(
          z.object({
            novelId: z.number(),
            title: z.string().optional(),
            author: z.string().optional(),
            description: z.string().optional(),
            coverImageUrl: z.string().optional(),
            publicationStatus: z.enum(["published", "archived"]).optional(),
            storyStatus: z.enum(["ongoing", "finished"]).optional(),
          })
        )
        .mutation(async ({ input }) => {
          const { novelId, ...data } = input;
          // Regenerate slug when title changes to keep slug in sync
          if (data.title) {
            const newSlug = await db.generateUniqueSlug(data.title, novelId);
            await db.updateNovel(novelId, { ...data, slug: newSlug });
          } else {
            await db.updateNovel(novelId, data);
          }
          return { success: true };
        }),

      delete: adminProcedure
        .input(z.object({ novelId: z.number() }))
        .mutation(async ({ input }) => {
          await db.deleteNovel(input.novelId);
          return { success: true };
        }),

      publish: adminProcedure
        .input(z.object({ novelId: z.number() }))
        .mutation(async ({ input }) => {
          await db.updateNovel(input.novelId, { publicationStatus: "published" });
          return { success: true };
        }),

      unpublish: adminProcedure
        .input(z.object({ novelId: z.number() }))
        .mutation(async ({ input }) => {
          await db.updateNovel(input.novelId, { publicationStatus: "archived" });
          return { success: true };
        }),
    }),

    episodes: router({
      // Paginated, lightweight list for the admin episodes page - never
      // returns `content` (see db.getAdminEpisodesList for why). Search/
      // filter/sort all happen in the DB query, not client-side.
      list: adminProcedure
        .input(
          z.object({
            page: z.number().int().positive().optional(),
            pageSize: z.number().int().positive().max(100).optional(),
            novelId: z.number().optional(),
            search: z.string().trim().max(200).optional(),
            sortBy: z.enum(["createdAt", "updatedAt", "episodeNumber", "title", "sortOrder"]).optional(),
            sortOrder: z.enum(["asc", "desc"]).optional(),
            saleMode: z.enum(["chapter", "package"]).optional(),
            isPublished: z.boolean().optional(),
          }).optional()
        )
        .query(async ({ input }) => {
          return db.getAdminEpisodesList(input ?? {});
        }),

      // Full episode row (content/fileUrl included) - only fetched when an
      // admin actually opens one episode to edit, not for the list view.
      detail: adminProcedure
        .input(z.object({ episodeId: z.number() }))
        .query(async ({ input }) => {
          const episode = await db.getEpisodeById(input.episodeId);
          if (!episode) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Episode not found" });
          }
          return episode;
        }),

      create: adminProcedure
        .input(
          z.object({
            novelId: z.number(),
            episodeNumber: z.string().min(1, "Episode number is required"),
            title: z.string(),
            price: z.string(),
            isFree: z.boolean().optional(),
            fileUrl: optionalStoredFileRefSchema,
            content: z.string().optional(),
            contentFormat: z.enum(["plain_text", "markdown", "html"]).default("plain_text").optional(),
            // "chapter" = single episode, direct wallet purchase. "package" =
            // multi-chapter bundle, cart/checkout, web-read only (no download).
            saleMode: z.enum(["chapter", "package"]).default("chapter").optional(),
            description: z.string().optional(),
            isPublished: z.boolean().default(true).optional(),
            publishedAt: z.date().optional(),
            sortOrder: z.number().optional(),
          })
        )
        .mutation(async ({ input }) => {
          const result = await db.createEpisode(input);
          return result;
        }),

      update: adminProcedure
        .input(
          z.object({
            episodeId: z.number(),
            episodeNumber: z.string().optional(),
            title: z.string().optional(),
            price: z.string().optional(),
            isFree: z.boolean().optional(),
            fileUrl: optionalStoredFileRefSchema,
            content: z.string().optional(),
            contentFormat: z.enum(["plain_text", "markdown", "html"]).optional(),
            saleMode: z.enum(["chapter", "package"]).optional(),
            description: z.string().optional(),
            isPublished: z.boolean().optional(),
            publishedAt: z.date().optional(),
            sortOrder: z.number().optional(),
          })
        )
        .mutation(async ({ input }) => {
          const { episodeId, ...data } = input;
          await db.updateEpisode(episodeId, data);
          return { success: true };
        }),

      delete: adminProcedure
        .input(z.object({ episodeId: z.number() }))
        .mutation(async ({ input }) => {
          await db.deleteEpisode(input.episodeId);
          return { success: true };
        }),

      // Import a package (multi-chapter, web-read-only) episode set from a
      // ZIP containing manifest.xlsx/manifest.csv + .txt content files. This
      // is the large-content counterpart to the xlsx importer above - the
      // xlsx importer's `content` cell is impractical for a 50-100 chapter
      // package, so content is read from separate .txt files instead.
      //
      // dryRun: true parses + validates the zip (including reading every
      // referenced .txt file) without writing to the database, so the admin
      // UI can show a preview/error list before committing.
      importPackageZip: adminProcedure
        .input(
          z.object({
            novelId: z.number(),
            zipBase64: z.string(),
            // Upsert is the recommended default: it syncs plaintext content
            // into an existing package (matched via normalized episodeNumber)
            // without touching its episodeId or legacy fileUrl, preserving
            // past purchases. create_only remains available for admins who
            // are certain no matching package exists yet.
            mode: z.enum(["create_only", "upsert"]).default("upsert"),
            dryRun: z.boolean().default(true),
          })
        )
        .mutation(async ({ input }) => {
          const base64Data = input.zipBase64.includes(",") ? input.zipBase64.split(",")[1] : input.zipBase64;
          const zipBuffer = Buffer.from(base64Data, "base64");

          let parsed;
          try {
            parsed = packageZipImportService.parsePackageZip(zipBuffer);
          } catch (error) {
            throw new TRPCError({ code: "BAD_REQUEST", message: (error as Error).message });
          }

          if (input.dryRun) {
            // Full diff preview: shows exactly what the real import would do
            // (update_existing / create_new / blocked with a reason) for
            // every row, built from the same classification logic the real
            // write path uses - so this can never show something different
            // from what actually happens. Read-only: never writes to the DB.
            const preview = await packageZipImportService.buildImportPreview(input.novelId, parsed, input.mode);

            return {
              manifestFileName: preview.manifestFileName,
              mode: preview.mode,
              totalRows: preview.summary.totalRows,
              validRows: preview.summary.createCount + preview.summary.updateCount,
              errorCount: preview.summary.errorCount,
              createCount: preview.summary.createCount,
              updateCount: preview.summary.updateCount,
              preservedFileUrlCount: preview.summary.preservedFileUrlCount,
              duplicateRangeCount: preview.summary.duplicateRangeCount,
              ambiguousMatchCount: preview.summary.ambiguousMatchCount,
              missingContentFileCount: preview.summary.missingContentFileCount,
              // Unified diff table - each row carries its own action/message,
              // never full `content` over the wire.
              rows: preview.rows,
              imported: false,
            };
          }

          const summary = await packageZipImportService.importPackageRows(input.novelId, parsed.rows, input.mode);

          return {
            manifestFileName: parsed.manifestFileName,
            totalRows: parsed.rows.length + parsed.errors.length,
            validRows: parsed.rows.length,
            successCount: summary.successCount,
            errorCount: parsed.errors.length + summary.errors.length,
            createdCount: summary.createdCount,
            updatedCount: summary.updatedCount,
            preservedFileUrlCount: summary.preservedFileUrlCount,
            results: summary.results,
            errors: [...parsed.errors, ...summary.errors],
            imported: true,
          };
        }),

      // Multi-novel counterpart to importPackageZip above: one ZIP can
      // contain packages for many novels at once, matched per-row via
      // novelId or novel title (see packageZipImportService's "MULTI-NOVEL
      // PACKAGE ZIP IMPORT" section) instead of one novelId supplied for the
      // whole ZIP. importPackageZip/parsePackageZip/importPackageRows above
      // are untouched - this is a fully separate code path.
      importMultiNovelPackageZip: adminProcedure
        .input(
          z.object({
            zipBase64: z.string(),
            mode: z.enum(["create_only", "upsert"]).default("upsert"),
            dryRun: z.boolean().default(true),
            // Manual novel-match override for not_found/ambiguous title
            // groups in the preview UI, keyed by the exact raw title text
            // the row used for matching (novelMatchTitle || novelTitle).
            novelIdOverrideMap: z.record(z.string(), z.number()).optional(),
          })
        )
        .mutation(async ({ input }) => {
          const base64Data = input.zipBase64.includes(",") ? input.zipBase64.split(",")[1] : input.zipBase64;
          const zipBuffer = Buffer.from(base64Data, "base64");

          let parsed;
          try {
            parsed = packageZipImportService.parseMultiNovelPackageZip(zipBuffer);
          } catch (error) {
            throw new TRPCError({ code: "BAD_REQUEST", message: (error as Error).message });
          }

          if (input.dryRun) {
            const preview = await packageZipImportService.buildMultiNovelImportPreview(
              parsed,
              input.mode,
              input.novelIdOverrideMap
            );

            return {
              manifestFileName: preview.manifestFileName,
              mode: preview.mode,
              totalRows: preview.summary.totalRows,
              novelCount: preview.summary.novelCount,
              validRows: preview.summary.createCount + preview.summary.updateCount,
              errorCount: preview.summary.errorCount,
              createCount: preview.summary.createCount,
              updateCount: preview.summary.updateCount,
              preservedFileUrlCount: preview.summary.preservedFileUrlCount,
              duplicateRangeCount: preview.summary.duplicateRangeCount,
              ambiguousMatchCount: preview.summary.ambiguousMatchCount,
              novelAmbiguousCount: preview.summary.novelAmbiguousCount,
              novelNotFoundCount: preview.summary.novelNotFoundCount,
              missingContentFileCount: preview.summary.missingContentFileCount,
              rows: preview.rows,
              imported: false,
            };
          }

          const summary = await packageZipImportService.importMultiNovelPackageRows(
            parsed.rows,
            input.mode,
            input.novelIdOverrideMap
          );

          return {
            manifestFileName: parsed.manifestFileName,
            totalRows: parsed.rows.length + parsed.errors.length,
            validRows: parsed.rows.length,
            novelCount: summary.novelCount,
            successCount: summary.successCount,
            errorCount: parsed.errors.length + summary.errorCount,
            createdCount: summary.createdCount,
            updatedCount: summary.updatedCount,
            preservedFileUrlCount: summary.preservedFileUrlCount,
            results: summary.results,
            errors: [...parsed.errors, ...summary.errors],
            imported: true,
          };
        }),
    }),

    // ============ ADMIN MEDIA MIGRATION RUNNER ============
    // Lets an admin move existing novels.coverImageUrl/banners.imageUrl
    // files onto Cloudflare R2 straight from the admin UI - Manus production
    // has no terminal, so scripts/migrate-media-to-r2.ts (which the CLI
    // Application Secrets can't reach interactively) can't be run there
    // directly. Both this router and the CLI script call the exact same
    // server/services/mediaMigrationService.ts, so behavior can never drift
    // between the two.
    mediaMigration: router({
      // Always dryRun=true - never uploads, never writes to the DB. Used by
      // the admin UI's "Dry Run" button, and safe to call with type="all".
      preview: adminProcedure
        .input(
          z.object({
            type: z.enum(["novels", "banners", "all"]),
            limit: z.number().int().positive().max(20),
            startId: z.number().int().min(0).optional(),
          })
        )
        .mutation(async ({ input }) => {
          try {
            return await runMediaMigrationBatch({ ...input, dryRun: true });
          } catch (error) {
            if (error instanceof MediaMigrationLockError) {
              throw new TRPCError({ code: "CONFLICT", message: error.message });
            }
            throw error;
          }
        }),

      // Live run - actually downloads, optimizes, uploads to R2, and
      // updates the DB row on success. Deliberately more restrictive than
      // preview: type is novels|banners only (no "all", to keep one HTTP
      // request bounded), limit caps at 10, and a typed confirmText guards
      // against an accidental click - this is the only mutating procedure in
      // this router.
      run: adminProcedure
        .input(
          z.object({
            type: z.enum(["novels", "banners"]),
            limit: z.number().int().positive().max(10),
            startId: z.number().int().min(0).optional(),
            confirmText: z.string(),
          })
        )
        .mutation(async ({ input }) => {
          if (input.confirmText !== "MIGRATE_TO_R2") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: 'confirmText ต้องพิมพ์ "MIGRATE_TO_R2" ให้ตรงทุกตัวอักษรเพื่อยืนยันการรัน migration จริง',
            });
          }

          const { confirmText, ...batchOptions } = input;
          try {
            return await runMediaMigrationBatch({ ...batchOptions, dryRun: false, force: false });
          } catch (error) {
            if (error instanceof MediaMigrationConfigError) {
              throw new TRPCError({
                code: "SERVICE_UNAVAILABLE",
                message: "R2 is not configured. Check Manus Application Secrets.",
              });
            }
            if (error instanceof MediaMigrationLockError) {
              throw new TRPCError({ code: "CONFLICT", message: error.message });
            }
            throw error;
          }
        }),
    }),

    categories: router({
      list: adminProcedure.query(async () => {
        return db.getAllCategories();
      }),

      create: adminProcedure
        .input(
          z.object({
            name: z.string(),
            description: z.string().optional(),
          })
        )
        .mutation(async ({ input }) => {
          const result = await db.createCategory(input);
          return result;
        }),

      update: adminProcedure
        .input(
          z.object({
            categoryId: z.number(),
            name: z.string().optional(),
            description: z.string().optional(),
          })
        )
        .mutation(async ({ input }) => {
          const { categoryId, ...data } = input;
          await db.updateCategory(categoryId, data);
          return { success: true };
        }),

      delete: adminProcedure
        .input(z.object({ categoryId: z.number() }))
        .mutation(async ({ input }) => {
          await db.deleteCategory(input.categoryId);
          return { success: true };
        }),
    }),

    entitlements: router({
      repair: adminProcedure
        .input(z.object({ orderId: z.number() }))
        .mutation(async ({ input }) => {
          const order = await db.getOrderById(input.orderId);
          if (!order) throw new TRPCError({ code: "NOT_FOUND" });
          if (!order.userId) throw new TRPCError({ code: "BAD_REQUEST", message: "Order has no user" });

          const items = await db.getOrderItems(order.id);
          const payment = await db.getPaymentByOrderId(order.id);

          if (!payment || payment.status !== "approved") {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Payment not approved" });
          }

          // Grant entitlements for each item
          let grantedCount = 0;
          for (const item of items) {
            const existing = await db.getPurchaseByUserAndEpisode(order.userId, item.episodeId);
            if (!existing) {
              await db.createPurchase(order.userId, item.novelId, item.episodeId, order.id);
              grantedCount++;
            }
          }

          return { success: true, grantedCount };
        }),

      search: adminProcedure
        .input(z.object({ orderId: z.number() }))
        .query(async ({ input }) => {
          const order = await db.getOrderById(input.orderId);
          if (!order) throw new TRPCError({ code: "NOT_FOUND" });
          if (!order.userId) throw new TRPCError({ code: "BAD_REQUEST", message: "Order has no user" });

          const items = await db.getOrderItems(order.id);
          const purchases = await db.getPurchasesByUserId(order.userId);

          const missing = items.filter(
            (item: any) => !purchases.some((p: any) => p.episodeId === item.episodeId)
          );

          return {
            orderId: order.id,
            orderNumber: order.orderNumber,
            userId: order.userId,
            totalItems: items.length,
            grantedCount: items.length - missing.length,
            missingCount: missing.length,
            missingItems: missing,
          };
        }),
    }),

    // ============ HYBRID CONTENT HEALTH DASHBOARD (Phase 2, read-only) ============
    // Surfaces exactly which novels/episodes are missing plaintext web-reader
    // content vs. only having a legacy file. Every query is DB-aggregated
    // and lightweight - never loads episodes.content/fileUrl as a raw value.
    // No mutations anywhere - purely diagnostic.
    // Hotfix (TiDB errno=8176, "query cancelled because the TiDB server
    // memory limit was exceeded"): overview and summary are now separate
    // procedures with independent failure boundaries - overview never waits
    // on or fails because of summary. Sort-by-aggregate-count is temporarily
    // suspended (see hybridHealthQueries.ts's OverviewSortBy docstring) -
    // only "title"/"novelId" remain, since those don't require computing
    // every novel's counts before picking a page.
    hybridHealth: router({
      overview: adminProcedure
        .input(
          z
            .object({
              page: z.number().int().min(1).optional(),
              pageSize: z.number().int().min(1).max(100).optional(),
              search: z.string().optional(),
              status: z.enum(["all", "missing_plaintext", "legacy_only", "missing_both", "has_plaintext"]).optional(),
              publicationStatus: z.enum(["all", "published", "archived"]).optional(),
              saleMode: z.enum(["all", "chapter", "package"]).optional(),
              purchasedOnly: z.boolean().optional(),
              sortBy: z.enum(["title", "novelId"]).optional(),
              sortOrder: z.enum(["asc", "desc"]).optional(),
            })
            .optional()
        )
        .query(async ({ input }) => {
          const { getHybridHealthOverview } = await import("./services/hybridHealthService");
          return getHybridHealthOverview(input ?? {});
        }),

      // Global KPI totals for the summary cards - its own request, loaded
      // independently of (and never blocking) the novel table above. Bounded
      // sequential batch scan, cached 5 minutes, single-flight - see
      // hybridHealthService.ts's getHybridHealthSummary().
      summary: adminProcedure.query(async () => {
        const { getHybridHealthSummary } = await import("./services/hybridHealthService");
        return getHybridHealthSummary();
      }),

      detail: adminProcedure
        .input(
          z.object({
            novelId: z.number(),
            page: z.number().int().min(1).optional(),
            pageSize: z.number().int().min(1).max(50).optional(),
            search: z.string().optional(),
            status: z.enum(["all", "missing_plaintext", "legacy_only", "missing_both", "has_plaintext"]).optional(),
            isPublished: z.boolean().optional(),
            saleMode: z.enum(["chapter", "package"]).optional(),
            purchasedOnly: z.boolean().optional(),
          })
        )
        .query(async ({ input }) => {
          const { getHybridHealthDetail, NovelNotFoundError } = await import("./services/hybridHealthService");
          try {
            return await getHybridHealthDetail(input);
          } catch (error) {
            if (error instanceof NovelNotFoundError) {
              throw new TRPCError({ code: "NOT_FOUND", message: error.message });
            }
            throw error;
          }
        }),
    }),

    // ============ ADMIN USER ENTITLEMENT LOOKUP (Phase 1, read-only) ============
    // Search a customer's purchases/entitlements for support/debugging. Never
    // mutates anything - use admin.entitlements.repair above for actually
    // granting a missing entitlement.
    entitlementLookup: router({
      search: adminProcedure
        .input(
          z.object({
            email: z.string().optional(),
            userId: z.number().optional(),
            orderId: z.number().optional(),
          })
        )
        .query(async ({ input }) => {
          const { lookupUserEntitlements } = await import("./services/entitlementLookupService");
          return lookupUserEntitlements(input);
        }),
    }),

    banners: router({
      list: adminProcedure.query(async () => {
        // Admin needs all banners (including inactive)
        return db.getAllBannersAdmin();
      }),

      uploadImage: adminProcedure
        .input(
          z.object({
            fileName: z.string().min(1),
            mimeType: z.enum(BANNER_IMAGE_MIME_TYPES),
            fileBase64: z.string().min(1),
          })
        )
        .mutation(async ({ input }) => {
          const base64Data = input.fileBase64.split(",")[1] || input.fileBase64;
          const fileBuffer = Buffer.from(base64Data, "base64");

          if (fileBuffer.length > MAX_BANNER_IMAGE_SIZE) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Banner image must be 5MB or smaller",
            });
          }

          // Optimized to WebP and uploaded to Cloudflare R2 - see the
          // matching comment on admin.novels.uploadCover above.
          const { url, key } = await optimizeAndUploadToR2(fileBuffer, "banners", BANNER_IMAGE_MAX_DIMENSIONS);

          return { url, key };
        }),

      create: adminProcedure
        .input(
          z.object({
            title: z.string(),
            description: z.string().optional(),
            imageUrl: z.string(),
            linkUrl: z.string().optional(),
            displayOrder: z.number().optional(),
          })
        )
        .mutation(async ({ input }) => {
          await db.createBanner(input);
          return { success: true };
        }),

      update: adminProcedure
        .input(
          z.object({
            bannerId: z.number(),
            title: z.string().optional(),
            description: z.string().optional(),
            imageUrl: z.string().optional(),
            linkUrl: z.string().optional(),
            displayOrder: z.number().optional(),
            isActive: z.boolean().optional(),
          })
        )
        .mutation(async ({ input }) => {
          const { bannerId, ...data } = input;
          await db.updateBanner(bannerId, data);
          return { success: true };
        }),

      delete: adminProcedure
        .input(z.object({ bannerId: z.number() }))
        .mutation(async ({ input }) => {
          await db.deleteBanner(input.bannerId);
          return { success: true };
        }),
    }),

    coupons: router({
      list: adminProcedure.query(async () => {
        const allCoupons = await db.getAllCoupons();
        return Promise.all(
          allCoupons.map(async (coupon: any) => {
            // resolveCouponOwnership also surfaces legacy reward coupons
            // whose `scope` column is still "global" (never backfilled) -
            // the admin list must show these as owned too, not just
            // coupons created through the new scope="user" flow.
            const ownership = await db.resolveCouponOwnership(coupon);
            let owner: { id: number; name: string | null; email: string | null } | null = null;
            if (ownership.ownerUserId) {
              const ownerUser = await db.getUserById(ownership.ownerUserId);
              if (ownerUser) {
                owner = { id: ownerUser.id, name: ownerUser.name as string | null, email: ownerUser.email as string | null };
              }
            }
            return {
              ...coupon,
              discountValue: coupon.discountValue ? String(coupon.discountValue).trim() : "0.00",
              minPurchaseAmount: coupon.minPurchaseAmount ? String(coupon.minPurchaseAmount).trim() : null,
              isOwnershipRestricted: ownership.isOwnershipRestricted,
              owner,
            };
          })
        );
      }),

      // Minimal user lookup for the admin coupon-owner picker - an admin
      // searches by the email they already know, never by guessing a raw
      // numeric ID. This does NOT make ownerUserId trusted client input:
      // create/update still independently re-verify the chosen ID against
      // a real user row server-side (db.createCoupon/updateCoupon via
      // resolveCouponScopeAndOwner) before ever writing it.
      findUserByEmail: adminProcedure
        .input(z.object({ email: z.string().min(1) }))
        .query(async ({ input }) => {
          const user = await db.getUserByEmail(input.email.trim());
          if (!user) return null;
          return { id: user.id, name: user.name, email: user.email };
        }),

      create: adminProcedure
        .input(
          z.object({
            code: z.string(),
            discountType: z.enum(["flat", "percentage"]),
            discountValue: z.string(),
            minPurchaseAmount: z.string().optional(),
            maxUsageCount: z.number().optional(),
            expiresAt: z.date().optional(),
            // "user" requires ownerUserId - defaults to "global" when
            // omitted, preserving every existing caller's behavior.
            // Enforced/re-verified server-side in db.createCoupon; never
            // trusted here just because the client sent it.
            scope: z.enum(["global", "user"]).optional(),
            ownerUserId: z.number().int().positive().optional(),
          })
        )
        .mutation(async ({ input }) => {
          const normalizedInput = {
            ...input,
            discountValue: String(input.discountValue).trim(),
            minPurchaseAmount: input.minPurchaseAmount ? String(input.minPurchaseAmount).trim() : undefined,
          };
          try {
            await db.createCoupon(normalizedInput);
          } catch (error: any) {
            throw new TRPCError({ code: "BAD_REQUEST", message: error?.message || "Failed to create coupon" });
          }
          return { success: true };
        }),

      update: adminProcedure
        .input(
          z.object({
            couponId: z.number(),
            code: z.string().optional(),
            discountType: z.enum(["flat", "percentage"]).optional(),
            discountValue: z.string().optional(),
            minPurchaseAmount: z.string().optional(),
            maxUsageCount: z.number().optional(),
            expiresAt: z.date().optional(),
            isActive: z.boolean().optional(),
            scope: z.enum(["global", "user"]).optional(),
            ownerUserId: z.number().int().positive().nullable().optional(),
          })
        )
        .mutation(async ({ input }) => {
          const { couponId, ...data } = input;
          const normalizedData: any = { ...data };
          if (data.discountValue !== undefined) {
            normalizedData.discountValue = String(data.discountValue).trim();
          }
          if (data.minPurchaseAmount !== undefined) {
            normalizedData.minPurchaseAmount = data.minPurchaseAmount ? String(data.minPurchaseAmount).trim() : null;
          }
          try {
            await db.updateCoupon(couponId, normalizedData);
          } catch (error: any) {
            throw new TRPCError({ code: "BAD_REQUEST", message: error?.message || "Failed to update coupon" });
          }
          return { success: true };
        }),

      delete: adminProcedure
        .input(z.object({ couponId: z.number() }))
        .mutation(async ({ input }) => {
          try {
            await db.deleteCoupon(input.couponId);
          } catch (error: any) {
            throw new TRPCError({ code: "BAD_REQUEST", message: error?.message || "Failed to delete coupon" });
          }
          return { success: true };
        }),
    }),

    // Minimal Daily Check-in 1-point rollout controls. Deliberately NOT a
    // campaign-management system: the point amount, campaignKey, dedupeKey,
    // ruleType and rewardKind are all server-fixed constants that no caller
    // can influence. The only input is the Bangkok start date.
    dailyCheckinRollout: router({
      status: adminProcedure.query(async () => {
        const { getDailyCheckinRolloutStatus } = await import("./services/dailyCheckinRewardModeService");
        return getDailyCheckinRolloutStatus();
      }),

      schedule: adminProcedure
        .input(z.object({ startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD") }))
        .mutation(async ({ input, ctx }) => {
          const { scheduleDailyCheckinPointRollout, DailyCheckinRolloutError } = await import(
            "./services/dailyCheckinRewardModeService"
          );
          try {
            return await scheduleDailyCheckinPointRollout(input.startDate, ctx.user.id);
          } catch (error: any) {
            // Allowlist, not blocklist: only an error the service itself
            // deliberately raised as a DailyCheckinRolloutError is safe to
            // forward verbatim. Anything else - a raw driver exception, a
            // programming error - is logged sanitized and answered with the
            // fixed generic message, never error.message directly.
            if (error instanceof DailyCheckinRolloutError) {
              throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
            }
            console.error(`[admin.dailyCheckinRollout.schedule] ${safeErrorSummary(error)}`);
            throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
          }
        }),

      cancel: adminProcedure.mutation(async () => {
        const { cancelDailyCheckinPointRollout, DailyCheckinRolloutError } = await import(
          "./services/dailyCheckinRewardModeService"
        );
        try {
          return await cancelDailyCheckinPointRollout();
        } catch (error: any) {
          if (error instanceof DailyCheckinRolloutError) {
            throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
          }
          console.error(`[admin.dailyCheckinRollout.cancel] ${safeErrorSummary(error)}`);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        }
      }),
    }),

    settings: router({
      getCheckoutMaintenance: adminProcedure.query(async () => {
        return getCheckoutMaintenanceStatus();
      }),

      updateCheckoutMaintenance: adminProcedure
        .input(checkoutMaintenanceAdminInputSchema)
        .mutation(async ({ input }) => {
          return saveCheckoutMaintenanceStatus(input);
        }),
      get: adminProcedure
        .input(z.object({ key: z.string() }))
        .query(async ({ input }) => {
          return db.getSetting(input.key);
        }),

      set: adminProcedure
        .input(z.object({ key: z.string(), value: z.string(), description: z.string().optional() }))
        .mutation(async ({ input }) => {
          await db.setSetting(input.key, input.value, input.description);
          return { success: true };
        }),
      // OCR Settings (Phase 4 - Single Source of Truth)
      getOCRSettings: adminProcedure.query(async () => {
        const { getOCRSettingsForAdmin } = await import("./_core/ocr-effective-config");
        return getOCRSettingsForAdmin();
      }),

      updateOCRSettings: adminProcedure
        .input(
          z.object({
            enabled: z.boolean().optional(),
            autoApproveEnabled: z.boolean().optional(),
            shadowModeEnabled: z.boolean().optional(),
            minConfidence: z.number().int().min(0).max(100).optional(),
            maxTimeWindowMinutes: z.number().int().min(1).max(1440).optional(),
          })
        )
        .mutation(async ({ input }) => {
          const { saveOCRSettingsToDatabase, validateAdminOCRSettings } = await import(
            "./_core/ocr-effective-config"
          );

          // Validate input
          const validation = validateAdminOCRSettings(input);
          if (!validation.valid) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: validation.errors.join(", "),
            });
          }

          // Save to database
          const success = await saveOCRSettingsToDatabase(input);
          if (!success) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to save OCR settings",
            });
          }

          console.log(`[Admin] OCR settings updated:`, input);
          return { success: true };
        }),
    }),

    // Daily check-in campaign config (Phase 5) - reuses the same
    // settings-table-backed pattern as OCR settings above, not a new large
    // admin page. See docs/DAILY_CHECKIN_COUPON.md PART H.
    dailyCheckin: router({
      getConfig: adminProcedure.query(async () => {
        const { getEffectiveDailyCheckinConfig } = await import("./_core/dailyCheckinConfig");
        return getEffectiveDailyCheckinConfig();
      }),

      updateConfig: adminProcedure
        .input(
          z.object({
            isActive: z.boolean().optional(),
            rewardPercent: z.number().positive().max(100).optional(),
            maxDiscountAmount: z.number().positive().optional(),
            minPurchaseAmount: z.number().min(0).optional(),
            validityDays: z.number().int().positive().max(365).optional(),
          })
        )
        .mutation(async ({ input }) => {
          const { saveDailyCheckinCampaignConfig } = await import("./_core/dailyCheckinConfig");
          const result = await saveDailyCheckinCampaignConfig(input);
          if (!result.success) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: result.errors?.join(", ") || "Failed to save daily check-in config",
            });
          }
          console.log(`[Admin] Daily check-in config updated:`, input);
          return { success: true };
        }),
    }),

    bulkUpload: router({
      novels: adminProcedure
        .input(z.object({ rows: z.array(z.object({ title: z.string() })) }))
        .mutation(async ({ input }) => {
          return db.bulkCreateNovels(input.rows);
        }),

      episodes: adminProcedure
        .input(z.object({
          novelId: z.number(),
          rows: z.array(z.object({
            title: z.string(),
            episodeNumber: z.string(),
            price: z.string(),
            fileUrl: z.string().refine(isValidStoredFileRef, { message: STORED_FILE_REF_MESSAGE }),
          })),
        }))
        .mutation(async ({ input }) => {
          return db.bulkCreateEpisodes(input.novelId, input.rows);
        }),

      episodesWithNovelTitle: adminProcedure
        .input(z.object({
          rows: z.array(z.object({
            novelTitle: z.string(),
            title: z.string(),
            episodeNumber: z.string(),
            price: z.string(),
            fileUrl: z.string().refine(isValidStoredFileRef, { message: STORED_FILE_REF_MESSAGE }),
          })),
        }))
        .mutation(async ({ input }) => {
          return db.bulkCreateEpisodesWithNovelTitle(input.rows);
        }),
    }),

    analytics: router({
      topSellingNovels: adminProcedure
        .input(z.object({
          period: z.enum(["all", "today", "7d", "month"]).default("all"),
          limit: z.number().min(1).max(100).default(20),
        }))
        .query(async ({ input }) => {
          const novels = await db.getTopSellingNovels(input.period, input.limit);
          const stats = await db.getTopSellingNovelsStats(input.period);
          return { novels, stats };
        }),
    }),

    sportsMatches: router({
      list: adminProcedure.query(async () => {
        return db.getAdminSportsMatches();
      }),

      uploadImage: adminProcedure
        .input(z.object({
          fileName: z.string().min(1),
          mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
          fileBase64: z.string().min(1),
        }))
        .mutation(async ({ input, ctx }) => {
          // fileName is validated/allowlisted (min length, no path use) but
          // otherwise unused below - optimizeAndUploadToR2 generates its own
          // collision-safe key, never trusting a source filename.
          const base64Data = input.fileBase64.split(",")[1] || input.fileBase64;
          const fileBuffer = Buffer.from(base64Data, "base64");

          const maxSize = 2 * 1024 * 1024;
          if (fileBuffer.length > maxSize) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Sports image must be 2MB or smaller" });
          }

          // Optimized to WebP and uploaded to Cloudflare R2 (not the Manus
          // storage proxy) - see the matching comment on
          // admin.novels.uploadCover above. This is the only remaining
          // sports-match upload path; new uploads never touch
          // BUILT_IN_FORGE_API_URL/API_KEY.
          const { url, key } = await optimizeAndUploadToR2(
            fileBuffer,
            `sports-matches/${ctx.user.id}`,
            SPORTS_MATCH_IMAGE_PRESET
          );

          return { url, key };
        }),

      create: adminProcedure
        .input(z.object({
          title: z.string().min(1),
          leagueName: z.string().optional(),
          homeTeamName: z.string().min(1),
          awayTeamName: z.string().min(1),
          homeTeamImageUrl: z.string().optional(),
          awayTeamImageUrl: z.string().optional(),
          coverImageUrl: z.string().optional(),
          matchStartAt: z.date().optional(),
          voteDeadlineAt: z.date(),
          voteCostPoints: z.string(),
          rewardDiscountType: z.enum(["flat", "percentage"]),
          rewardDiscountValue: z.string(),
          rewardMinPurchaseAmount: z.string().optional(),
          rewardCouponExpiresAt: z.date().optional(),
          status: z.enum(["draft", "open", "closed"]).optional(),
          isActive: z.boolean().optional(),
          displayOrder: z.number().optional(),
        }))
        .mutation(async ({ input }) => {
          return db.createSportsMatch(input);
        }),

      update: adminProcedure
        .input(z.object({
          matchId: z.number(),
          title: z.string().optional(),
          leagueName: z.string().nullable().optional(),
          homeTeamName: z.string().optional(),
          awayTeamName: z.string().optional(),
          homeTeamImageUrl: z.string().nullable().optional(),
          awayTeamImageUrl: z.string().nullable().optional(),
          coverImageUrl: z.string().nullable().optional(),
          matchStartAt: z.date().nullable().optional(),
          voteDeadlineAt: z.date().optional(),
          voteCostPoints: z.string().optional(),
          rewardDiscountType: z.enum(["flat", "percentage"]).optional(),
          rewardDiscountValue: z.string().optional(),
          rewardMinPurchaseAmount: z.string().nullable().optional(),
          rewardCouponExpiresAt: z.date().nullable().optional(),
          status: z.enum(["draft", "open", "closed"]).optional(),
          isActive: z.boolean().optional(),
          displayOrder: z.number().optional(),
        }))
        .mutation(async ({ input }) => {
          const { matchId, ...data } = input;
          await db.updateSportsMatch(matchId, data as any);
          return { success: true };
        }),

      settle: adminProcedure
        .input(z.object({ matchId: z.number(), result: z.enum(["home_win", "draw", "away_win"]) }))
        .mutation(async ({ input }) => {
          return db.settleSportsMatch(input.matchId, input.result);
        }),

      cancel: adminProcedure
        .input(z.object({ matchId: z.number() }))
        .mutation(async ({ input }) => {
          return db.cancelSportsMatch(input.matchId);
        }),
    }),
  }),
  wallet: router({
    getBalance: protectedProcedure.query(async ({ ctx }) => {
      const balance = await db.getWalletBalance(ctx.user.id);
      return { balance };
    }),
    getSummary: protectedProcedure.query(async ({ ctx }) => {
      return db.getWalletSummary(ctx.user.id);
    }),
    createTopupRequest: protectedProcedure
      .input(z.object({ requestedAmount: z.string(), slipImageUrl: optionalStoredFileRefSchema }))
      .mutation(async ({ ctx, input }) => {
        await assertSlipCheckoutAvailable("wallet.createTopupRequest");
        return walletService.createWalletTopupRequest(ctx.user.id, input.requestedAmount, input.slipImageUrl);
      }),
    // DEPRECATED: uploadTopupSlip is kept for backward compatibility with existing pending top-ups
    // New flow: slip is uploaded before creating the top-up request
    uploadTopupSlip: protectedProcedure
      .input(z.object({ topupId: z.number(), slipImageUrl: requiredStoredFileRefSchema("Payment slip is required") }))
      .mutation(async ({ ctx, input }) => {
        await assertSlipCheckoutAvailable("wallet.uploadTopupSlip");
        return walletService.uploadWalletTopupSlip(input.topupId, ctx.user.id, input.slipImageUrl);
      }),
    admin: router({
      listPendingTopups: adminProcedure
        .input(z.object({ limit: z.number().default(20), offset: z.number().default(0) }))
        .query(async ({ input }) => {
          const topups = await db.listPendingWalletTopups(input.limit, input.offset);
          return Promise.all(topups.map((topup: any) => withResolvedSlipUrl(topup, "wallet.admin.listPendingTopups")));
        }),
      detail: adminProcedure
        .input(z.object({ topupId: z.number() }))
        .query(async ({ input }) => {
          const rawTopup = await db.getWalletTopupById(input.topupId);
          if (!rawTopup) throw new TRPCError({ code: "NOT_FOUND" });

          // Get user info
          const user = rawTopup.userId ? await db.getUserById(rawTopup.userId) : null;

          // Get topup logs related to this user (audit trail)
          const logs = rawTopup.userId ? await db.getTopupLogs(rawTopup.userId, undefined, undefined, 50) : [];

          const topup = await withResolvedSlipUrl(rawTopup, "wallet.admin.detail");

          const ocrConfig = await getEffectiveOCRConfig();

          // ── DUPLICATE STATE (read-only, admin-only) ─────────────────────
          // Mirrors admin.orders.detail EXACTLY: the same shared classifier,
          // so an admin viewing a wallet top-up sees the SAME conflict a
          // wallet Approve attempt will enforce, before ever attempting one.
          // Without this, a mixed-case reference (or any other advisory
          // ambiguity) was invisible until Approve failed - normal Approve
          // was the discovery mechanism, not the detail page.
          let duplicate:
            | {
                strength: "strong" | "legacy_case_ambiguity" | "unresolved" | "legacy_case_ambiguity_group" | "known_collision";
                kind?: string;
                matchedSourceType: "order_payment" | "wallet_topup";
                matchedSourceId: number;
                matchedOrderId?: number;
                viaLegacyCompatibility?: boolean;
                advisory?: true;
                requiresAdminResolution?: true;
              }
            | undefined;
          let reviewReasonOverride: string | undefined;
          let fileIdentifierStatus: "AVAILABLE" | "MATCH" | "UNAVAILABLE" = "UNAVAILABLE";
          let recipient: ReturnType<typeof verifyRecipient> | undefined;

          if (rawTopup?.extractedData) {
            const { identifiers } = deriveStrongIdentifiersFromExtractedData(
              rawTopup.extractedData as string
            );
            const database = await db.getDb();
            if (database && hasStrongIdentifier(identifiers)) {
              const conflict = await evaluateSlipConflict(
                {
                  identifiers,
                  rawReference: getRawReferenceForLegacyLookup(
                    rawTopup.extractedData as string
                  ),
                  sourceType: "wallet_topup",
                  sourceId: rawTopup.id,
                },
                database
              );

              if (conflict.kind === "strong_duplicate") {
                duplicate = {
                  strength: "strong",
                  kind: conflict.matchedKind,
                  matchedSourceType: conflict.matchedSourceType,
                  matchedSourceId: conflict.matchedSourceId,
                  viaLegacyCompatibility: conflict.viaLegacyCompatibility,
                };
              } else if (conflict.kind === "legacy_case_ambiguity") {
                duplicate = {
                  strength: "legacy_case_ambiguity",
                  matchedSourceType: conflict.matchedSourceType,
                  matchedSourceId: conflict.matchedSourceId,
                  advisory: true,
                  requiresAdminResolution: true,
                };
                reviewReasonOverride = "LEGACY_REFERENCE_CASE_AMBIGUITY";
              } else if (conflict.kind === "unresolved") {
                duplicate = {
                  strength: "unresolved",
                  matchedSourceType: conflict.matchedSourceType,
                  matchedSourceId: conflict.matchedSourceId,
                  advisory: true,
                };
                reviewReasonOverride = "LEGACY_APPROVED_SLIP_UNRESOLVED";
              } else if (conflict.kind === "legacy_case_ambiguity_group") {
                duplicate = {
                  strength: "legacy_case_ambiguity_group",
                  matchedSourceType: conflict.matchedSourceType,
                  matchedSourceId: conflict.matchedSourceId,
                  advisory: true,
                };
                reviewReasonOverride = "LEGACY_ALIAS_GROUP_AMBIGUITY";
              } else if (conflict.kind === "known_collision") {
                // This submission's own strong identifier durably matches a
                // KNOWN historical collision (paymentSlipLegacyCollisions).
                // Reflects the SAME state normal Approve sees: it refuses
                // with LEGACY_KNOWN_COLLISION and never consults a waiver.
                duplicate = {
                  strength: "known_collision",
                  kind: conflict.matchedKind,
                  matchedSourceType: conflict.matchedSourceType,
                  matchedSourceId: conflict.matchedSourceId,
                  advisory: true,
                };
                reviewReasonOverride = "LEGACY_KNOWN_COLLISION";
              }

              if (duplicate) {
                const nav = await resolveMatchedSourceNavigation(
                  duplicate.matchedSourceType,
                  duplicate.matchedSourceId,
                  database
                );
                duplicate.matchedOrderId = nav.orderId;
              }
            }
            fileIdentifierStatus = describeFileIdentifierStatus({
              fileHash: identifiers.fileHash,
              duplicateFileMatch: duplicate?.kind === "file",
            });

            try {
              const parsedExtracted = JSON.parse(rawTopup.extractedData as string);
              recipient = verifyRecipient(parsedExtracted);
            } catch {
              recipient = undefined;
            }
          }

          return {
            topup,
            user,
            logs: logs || [],
            ocrMeta: {
              effectiveWindowMinutes: ocrConfig.maxTimeWindowMinutes,
              minConfidence: ocrConfig.minConfidence,
              duplicate,
              fileIdentifierStatus,
              recipient,
              reviewReason: reviewReasonOverride ?? (rawTopup?.reviewReason as string | undefined),
            },
          };
        }),
      approveTopup: adminProcedure
        .input(z.object({ topupId: z.number() }))
        .mutation(async ({ ctx, input }) => {
          return walletService.adminApproveWalletTopup(input.topupId, ctx.user.id);
        }),
      /**
       * Wallet equivalent of admin.orders.resolveLegacyCaseAmbiguity.
       *
       * Wallet auto-approval and normal wallet Approve both stop on a legacy
       * case ambiguity, so wallet needs the same escape route - without it a
       * legitimate top-up whose reference differs from a legacy alias only by
       * case would be permanently unapprovable.
       *
       * Resolves ONLY the advisory ambiguity. It can never bypass
       * DUPLICATE_REFERENCE / DUPLICATE_FILE / DUPLICATE_QR /
       * NO_STRONG_IDENTIFIER: the exact atomic claim still runs inside the
       * wallet crediting transaction.
       */
      resolveLegacyCaseAmbiguity: adminProcedure
        .input(
          z.object({
            topupId: z.number().int().positive(),
            decision: z.enum(["confirmed_distinct", "confirmed_duplicate"]),
            reason: z.string().trim().min(10).max(1000),
          })
        )
        .mutation(async ({ input, ctx }) => {
          return resolveLegacyCaseAmbiguity({
            subjectType: "wallet_topup",
            subjectId: input.topupId,
            adminUserId: ctx.user.id,
            adminLabel: ctx.user.name || "Admin",
            decision: input.decision,
            reason: input.reason,
          });
        }),

      rejectTopup: adminProcedure
        .input(z.object({ topupId: z.number(), reason: z.string() }))
        .mutation(async ({ ctx, input }) => {
          return walletService.adminRejectWalletTopup(input.topupId, ctx.user.id, input.reason);
        }),
      adjustBalance: adminProcedure
        .input(z.object({
          userId: z.number().int().positive(),
          amount: z.string(),
          mode: z.enum(["add", "subtract", "set"]).default("add"),
          reason: z.string().min(3),
        }))
        .mutation(async ({ ctx, input }) => {
          try {
            const result = await db.adjustWalletBalance(
              input.userId,
              input.amount,
              ctx.user.id,
              input.reason,
              input.mode
            );

            const newBalance = await db.getWalletBalance(input.userId);
            return {
              success: true,
              message: `Wallet adjusted (${input.mode})`,
              balanceBefore: result.balanceBefore,
              balanceAfter: result.balanceAfter,
              newBalance,
              transactionAmount: result.transactionAmount,
            };
          } catch (error: any) {
            console.error("[admin.wallet.adjustBalance] Error:", error);
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: error?.message || "Failed to adjust wallet balance",
            });
          }
        }),
      repairTopupCredit: adminProcedure
        .input(z.object({
          topupId: z.number().int().positive(),
          reason: z.string().min(3),
        }))
        .mutation(async ({ ctx, input }) => {
          try {
            const result = await db.repairWalletTopupCredit(
              input.topupId,
              ctx.user.id,
              input.reason
            );

            return {
              success: true,
              message: "Top-up credit repaired successfully",
              balanceBefore: result.balanceBefore,
              balanceAfter: result.balanceAfter,
              creditAmount: result.creditAmount,
            };
          } catch (error: any) {
            console.error("[admin.wallet.repairTopupCredit] Error:", error);
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: error?.message || "Failed to repair top-up credit",
            });
          }
        }),
      listTopupLogs: adminProcedure
        .input(z.object({
          userId: z.number().optional(),
          startDate: z.date().optional(),
          endDate: z.date().optional(),
          limit: z.number().default(50),
          offset: z.number().default(0),
        }))
        .query(async ({ input }) => {
          const logs = await db.getTopupLogs(input.userId, input.startDate, input.endDate, input.limit, input.offset);
          const total = await db.getTopupLogsCount(input.userId, input.startDate, input.endDate);
          return { logs, total };
        }),
      logDetail: adminProcedure
        .input(z.object({ logId: z.number() }))
        .query(async ({ input }) => {
          const log = await db.getTopupLogById(input.logId);
          if (!log) throw new TRPCError({ code: "NOT_FOUND" });

          // Get user info
          const user = log.userId ? await db.getUserById(log.userId) : null;

          // Get created by admin info if available
          let createdByUser: any = null;
          if (log.createdBy && log.createdBy !== 0) {
            createdByUser = await db.getUserById(log.createdBy);
          }

          // Parse topupId from reference if possible
          let relatedTopup = null;
          if (log.reference) {
            const topupIdMatch = log.reference.match(/^topup-(\d+)/);
            if (topupIdMatch) {
              const topupId = parseInt(topupIdMatch[1], 10);
              relatedTopup = await db.getWalletTopupById(topupId);
            }
          }

          // Get related wallet transactions
          let relatedTransactions: any[] = [];
          if (relatedTopup?.id) {
            relatedTransactions = await db.getWalletTransactionsByReference(
              log.userId,
              "topup",
              relatedTopup.id.toString()
            ).catch(() => []);
          }

          // Get related user logs (latest 10)
          let userRecentLogs: any[] = [];
          if (log.userId) {
            userRecentLogs = (await db.getTopupLogs(log.userId, undefined, undefined, 10, 0)) || [];
          }

          return {
            log,
            user,
            createdByUser,
            relatedTopup: await withResolvedSlipUrl(relatedTopup, "wallet.admin.logDetail"),
            relatedTransactions,
            userRecentLogs,
          };
        }),
      createTopupLog: adminProcedure
        .input(z.object({
          userId: z.number(),
          amount: z.string(),
          bonus: z.string().optional(),
          method: z.enum(["slip", "admin_adjust", "promo"]),
          reference: z.string().optional(),
          note: z.string().optional(),
        }))
        .mutation(async ({ ctx, input }) => {
          const amountNum = parseFloat(input.amount);
          if (amountNum <= 0) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Amount must be greater than 0" });
          }
          const user = await db.getUserById(input.userId);
          if (!user) {
            throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
          }
          return db.createTopupLog(
            input.userId,
            input.amount,
            input.bonus || "0.00",
            input.method,
            input.reference,
            input.note,
            ctx.user.id
          );
        }),
      getBonusConfig: adminProcedure
        .query(async () => {
          const { getWalletBonusConfig } = await import("./services/walletBonusService");
          return await getWalletBonusConfig();
        }),
      updateBonusConfig: adminProcedure
        .input(z.object({
          enabled: z.boolean(),
          tiers: z.array(z.object({
            minAmount: z.number().int().positive("Min amount must be greater than 0"),
            bonusAmount: z.number().int().min(0, "Bonus amount cannot be negative"),
            label: z.string().optional(),
          })),
        }))
        .mutation(async ({ input }) => {
          const { saveWalletBonusConfig, validateBonusConfig } = await import("./services/walletBonusService");

          // Validate: no duplicate minAmount
          const minAmounts = input.tiers.map(t => t.minAmount);
          const uniqueMinAmounts = new Set(minAmounts);
          if (uniqueMinAmounts.size !== minAmounts.length) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Duplicate min amount values" });
          }

          // Auto-generate labels if empty
          const configWithLabels = {
            enabled: input.enabled,
            tiers: input.tiers.map(tier => ({
              minAmount: tier.minAmount,
              bonusAmount: tier.bonusAmount,
              label: tier.label || `เติมครบ ${tier.minAmount} รับโบนัส ${tier.bonusAmount}`,
            })),
          };

          // Validate config
          const error = validateBonusConfig(configWithLabels);
          if (error) {
            throw new TRPCError({ code: "BAD_REQUEST", message: error });
          }

          await saveWalletBonusConfig(configWithLabels);
          return { success: true, config: configWithLabels };
        }),
    }),
    getBonusPreview: protectedProcedure
      .input(z.object({
        amount: z.union([z.string(), z.number()]),
      }))
      .query(async ({ input }) => {
        const { calculateWalletTopupBonus } = await import("./services/walletBonusService");
        return await calculateWalletTopupBonus(input.amount);
      }),
    getBonusTiers: protectedProcedure
      .query(async () => {
        const { getWalletBonusConfig } = await import("./services/walletBonusService");
        return await getWalletBonusConfig();
      }),
  }),

  // ============ SPORTS MATCH PREDICTION VOTING ============
  sports: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return db.getPublicSportsMatches(ctx.user.id);
    }),

    vote: protectedProcedure
      .input(z.object({
        matchId: z.number(),
        prediction: z.enum(["home_win", "draw", "away_win"]),
      }))
      .mutation(async ({ input, ctx }) => {
        try {
          const vote = await db.castSportsVote(ctx.user.id, input.matchId, input.prediction);
          return { success: true, vote };
        } catch (error: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error?.message || "Vote failed" });
        }
      }),

    myRewards: protectedProcedure.query(async ({ ctx }) => {
      return db.getSportsRewardsForUser(ctx.user.id);
    }),
  }),

  // ============ NOVEL READER ============
  reader: router({
    getEpisode: protectedProcedure
      .input(z.object({
        episodeId: z.number(),
      }))
      .query(async ({ input, ctx }) => {
        const { getReaderEpisode, getUserWalletBalance } = await import("./services/readerService");
        // Public reader must behave like a real customer session. Do not pass
        // admin override here, otherwise an admin account can read every paid
        // chapter by navigating previous/next without ever purchasing it.
        const allowAdminPreview = false;
        const episodeData = await getReaderEpisode(ctx.user.id, input.episodeId, allowAdminPreview);

        if (!episodeData) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Episode not found" });
        }

        // Add wallet balance to response
        const walletBalance = await getUserWalletBalance(ctx.user.id);

        return {
          ...episodeData,
          walletBalance,
        };
      }),

    // Reading progress: resume position for long packages (and chapters).
    // Both endpoints gate on canReadEpisode(..., false) - explicitly no
    // admin override, matching reader.getEpisode - so progress can only be
    // read/saved for episodes the user actually has access to (free or
    // purchased). An episode the user hasn't bought yet must never expose or
    // accept a saved reading position.
    getProgress: protectedProcedure
      .input(z.object({ episodeId: z.number() }))
      .query(async ({ input, ctx }) => {
        const canRead = await readerService.canReadEpisode(ctx.user.id, input.episodeId, false);
        if (!canRead) return null;

        const progress = await db.getReadingProgress(ctx.user.id, input.episodeId);
        if (!progress) return null;

        return {
          progressPercent: progress.progressPercent,
          scrollPosition: progress.scrollPosition,
          currentChapterNumber: progress.currentChapterNumber,
          currentChapterTitle: progress.currentChapterTitle,
          anchorKey: progress.anchorKey,
          lastReadAt: progress.lastReadAt,
        };
      }),

    saveProgress: protectedProcedure
      .input(
        z.object({
          episodeId: z.number(),
          progressPercent: z.number().min(0).max(100),
          scrollPosition: z.number().min(0).optional(),
          currentChapterNumber: z.string().max(100).optional(),
          currentChapterTitle: z.string().max(500).optional(),
          anchorKey: z.string().max(100).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const canRead = await readerService.canReadEpisode(ctx.user.id, input.episodeId, false);
        if (!canRead) {
          throw new TRPCError({ code: "FORBIDDEN", message: "No access to this episode" });
        }

        // Derive novelId server-side from the episode record rather than
        // trusting a client-supplied value - the episode is the source of
        // truth for which novel it belongs to.
        const episode = await db.getEpisodeById(input.episodeId);
        if (!episode) throw new TRPCError({ code: "NOT_FOUND" });

        await db.upsertReadingProgress({
          userId: ctx.user.id,
          novelId: episode.novelId,
          episodeId: input.episodeId,
          progressPercent: input.progressPercent,
          scrollPosition: input.scrollPosition,
          currentChapterNumber: input.currentChapterNumber,
          currentChapterTitle: input.currentChapterTitle,
          anchorKey: input.anchorKey,
        });

        return { success: true };
      }),

    purchaseEpisode: protectedProcedure
      .input(z.object({
        episodeId: z.number(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { purchaseEpisodeWithWallet } = await import("./services/episodePurchaseService");

        const result = await purchaseEpisodeWithWallet(ctx.user.id, input.episodeId);

        if (!result.success) {
          // Structured codes (from PurchaseError inside the service) are passed
          // through verbatim so the frontend can match on the exact code rather
          // than substring-matching a human-readable message. Legacy plain
          // messages are translated to Thai for direct display.
          const passthroughCodes = new Set([
            "INSUFFICIENT_WALLET_BALANCE",
            "INSUFFICIENT_WALLET_BALANCE_ATOMIC",
            "INVALID_EPISODE_PRICE",
            "INVALID_WALLET_BALANCE",
            "PACKAGE_MUST_USE_CART",
          ]);

          if (result.error && passthroughCodes.has(result.error)) {
            throw new TRPCError({ code: "BAD_REQUEST", message: result.error });
          }

          const errorMap: Record<string, string> = {
            "Episode not found": "ไม่พบตอนนี้",
            "Free episodes do not require purchase": "ตอนฟรีไม่ต้องซื้อ",
            "Episode is not published": "ตอนนี้ยังไม่เปิดให้อ่าน",
            "Already purchased": "ซื้อไปแล้ว",
            "Wallet not found": "กระเป๋าไม่พบ",
            "Database not available": "ระบบขัดข้อง",
          };

          const message = errorMap[result.error || ""] || result.error || "ซื้อไม่สำเร็จ";
          throw new TRPCError({ code: "BAD_REQUEST", message });
        }

        return {
          success: true,
          episodePurchaseId: result.episodePurchaseId,
          newBalance: result.newBalance,
        };
      }),

    myPurchases: protectedProcedure
      .input(z.object({
        novelId: z.number(),
      }))
      .query(async ({ input, ctx }) => {
        const { getUserPurchasedEpisodes } = await import("./services/episodePurchaseService");
        return await getUserPurchasedEpisodes(ctx.user.id, input.novelId);
      }),

    myLibrary: protectedProcedure
      .input(z.object({
        novelId: z.number().optional(),
      }))
      .query(async ({ input, ctx }) => {
        const getDb = await import("./db").then(m => m.getDb);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

        const { episodePurchases, episodes, novels, readingProgress } = await import("../drizzle/schema").then(s => ({
          episodePurchases: s.episodePurchases,
          episodes: s.episodes,
          novels: s.novels,
          readingProgress: s.readingProgress,
        }));
        const { eq, inArray, and } = await import("drizzle-orm").then(m => ({ eq: m.eq, inArray: m.inArray, and: m.and }));

        // Get all purchases for this user
        const purchases = await db
          .select()
          .from(episodePurchases)
          .where(eq(episodePurchases.userId, ctx.user.id));

        if (purchases.length === 0) {
          return [];
        }

        // Get episode details for purchases - filter by episodeIds to prevent data leak
        const episodeIds = purchases.map(p => p.episodeId);
        const episodeData = await db
          .select()
          .from(episodes)
          .where(and(
            inArray(episodes.id, episodeIds),
            input.novelId ? eq(episodes.novelId, input.novelId) : undefined
          ));

        // Get novel details
        const novelIds = new Set(episodeData.map((ep: any) => ep.novelId));
        const novelData = await db
          .select()
          .from(novels)
          .where(inArray(novels.id, Array.from(novelIds)));

        // Get reading progress for these episodes, for a "continue reading" hint
        const progressData = await db
          .select()
          .from(readingProgress)
          .where(and(eq(readingProgress.userId, ctx.user.id), inArray(readingProgress.episodeId, episodeIds)));

        // Build result
        return episodeData.map((ep: any) => {
          const progress = progressData.find((p: any) => p.episodeId === ep.id);
          return {
            purchaseId: purchases.find(p => p.episodeId === ep.id)?.id,
            purchasedAt: purchases.find(p => p.episodeId === ep.id)?.purchasedAt,
            pricePaid: purchases.find(p => p.episodeId === ep.id)?.pricePaid,
            episode: {
              id: ep.id,
              novelId: ep.novelId,
              episodeNumber: ep.episodeNumber,
              title: ep.title,
              description: ep.description,
              wordCount: ep.wordCount,
              isPublished: ep.isPublished,
              price: ep.price,
              isFree: ep.isFree,
            },
            novel: novelData.find((n: any) => n.id === ep.novelId),
            progressPercent: progress?.progressPercent ?? null,
            currentChapterNumber: progress?.currentChapterNumber ?? null,
            currentChapterTitle: progress?.currentChapterTitle ?? null,
          };
        });
      }),
  }),

  // ============ ACCOUNT RECOVERY (post-VPS-migration Google identity moves) ============
  // See server/services/accountRecoveryService.ts for the safety-rule and
  // transactional-approval logic every mutation below defers to - this
  // router is deliberately thin: input validation, ownership/authorization
  // checks the service layer itself cannot know (e.g. "is this MY pending
  // request"), and mapping AccountRecoveryError -> TRPCError.
  accountRecovery: router({
    myRequests: authenticatedProcedure.query(async ({ ctx }) => {
      return db.listAccountRecoveryRequestsForUser(ctx.user.id);
    }),

    create: authenticatedProcedure
      .input(
        z.object({
          requestedLegacyUserId: z.number().int().positive().optional(),
          claimedLegacyEmail: z.string().trim().email().optional(),
          claimedLegacyOpenId: z.string().trim().min(1).max(64).optional(),
          claimedDisplayName: z.string().trim().min(1).max(255).optional(),
          evidenceNote: z.string().trim().max(2000).optional(),
          referenceOrderNumber: z.string().trim().min(1).max(50).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        try {
          return await accountRecoveryService.submitAccountRecoveryRequest({
            requesterUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          throw mapAccountRecoveryError(error);
        }
      }),

    // requestId ownership is verified here, never inside the service layer
    // (which has no concept of "the caller's own session") - same request
    // id + status combination is used for both "not found" and "belongs to
    // someone else", so this never confirms/denies whether a given id
    // exists for another user.
    cancel: authenticatedProcedure
      .input(z.object({ requestId: z.number().int().positive(), reason: z.string().trim().max(500).optional() }))
      .mutation(async ({ input, ctx }) => {
        const request = await db.getAccountRecoveryRequestById(input.requestId);
        if (!request || request.requesterUserId !== ctx.user.id) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Recovery request not found" });
        }
        try {
          return await accountRecoveryService.reviewAccountRecoveryRequest({
            requestId: input.requestId,
            action: "cancel",
            actorAdminId: null,
            reason: input.reason || "ยกเลิกโดยผู้ใช้",
          });
        } catch (error) {
          throw mapAccountRecoveryError(error);
        }
      }),

    admin: router({
      list: adminProcedure
        .input(
          z.object({
            page: z.number().int().positive().default(1),
            pageSize: z.number().int().positive().max(100).default(20),
          })
        )
        .query(async ({ input }) => {
          return db.listPendingAccountRecoveryRequests(input);
        }),

      detail: adminProcedure.input(z.object({ requestId: z.number().int().positive() })).query(async ({ input }) => {
        const request = await db.getAccountRecoveryRequestById(input.requestId);
        if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "Recovery request not found" });

        const [requesterIdentity, economicDataFindings, userOwnedDataFindings, requesterUser] = await Promise.all([
          db.getAuthIdentityByUserAndProvider(request.requesterUserId, "google"),
          db.findAccountRecoveryEconomicData(request.requesterUserId),
          db.findAccountRecoveryUserOwnedData(request.requesterUserId, request.id),
          db.getUserById(request.requesterUserId),
        ]);

        return {
          request,
          requester: requesterUser ? maskUserForAdmin(requesterUser) : null,
          requesterHasGoogleIdentity: Boolean(requesterIdentity),
          economicDataFindings,
          userOwnedDataFindings,
        };
      }),

      // EXACT match only, by design - never a fuzzy/partial/LIKE search.
      // Anti-enumeration: at most one row can ever match a given exact key,
      // and the caller must already be an authenticated admin.
      searchLegacyAccount: adminProcedure
        .input(z.object({ mode: z.enum(["id", "email", "openId"]), value: z.string().trim().min(1).max(320) }))
        .query(async ({ input }) => {
          let user: Awaited<ReturnType<typeof db.getUserById>>;
          if (input.mode === "id") {
            const id = Number(input.value);
            if (!Number.isInteger(id) || id <= 0) return { user: null, hasGoogleIdentity: false };
            user = await db.getUserById(id);
          } else if (input.mode === "email") {
            user = await db.getUserByEmail(input.value);
          } else {
            user = await db.getUserByOpenId(input.value);
          }
          if (!user) return { user: null, hasGoogleIdentity: false };

          const googleIdentity = await db.getAuthIdentityByUserAndProvider(user.id, "google");
          return { user: maskUserForAdmin(user), hasGoogleIdentity: Boolean(googleIdentity) };
        }),

      // Backs the approve confirmation modal's safety assessment display -
      // read-only, safe to call repeatedly as the admin picks different
      // candidate targets before committing to one.
      previewApproval: adminProcedure
        .input(z.object({ requestId: z.number().int().positive(), targetUserId: z.number().int().positive() }))
        .query(async ({ input }) => {
          const request = await db.getAccountRecoveryRequestById(input.requestId);
          if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "Recovery request not found" });
          const assessment = await accountRecoveryService.assessAccountRecoverySafety({
            requestId: input.requestId,
            sourceUserId: request.requesterUserId,
            targetUserId: input.targetUserId,
          });
          // NEVER return the internal assessment as-is - it carries
          // sourceGoogleIdentity.providerSubject (the Google `sub`) and
          // .emailAtLink (a full email address), neither of which the
          // admin UI needs or may see. toSafeAdminAssessmentDto strips
          // this down to the allowlisted, boolean-only-for-identity shape.
          return accountRecoveryService.toSafeAdminAssessmentDto(assessment);
        }),

      approve: adminProcedure
        .input(
          z.object({
            requestId: z.number().int().positive(),
            targetUserId: z.number().int().positive(),
            reason: z.string().trim().min(1).max(1000),
          })
        )
        .mutation(async ({ input, ctx }) => {
          try {
            const result = await accountRecoveryService.executeAccountRecovery({
              requestId: input.requestId,
              targetUserId: input.targetUserId,
              adminId: ctx.user.id,
              reason: input.reason,
            });
            return { success: true, request: result.request };
          } catch (error) {
            throw mapAccountRecoveryError(error);
          }
        }),

      reject: adminProcedure
        .input(z.object({ requestId: z.number().int().positive(), reason: z.string().trim().min(1).max(1000) }))
        .mutation(async ({ input, ctx }) => {
          try {
            return await accountRecoveryService.reviewAccountRecoveryRequest({
              requestId: input.requestId,
              action: "reject",
              actorAdminId: ctx.user.id,
              reason: input.reason,
            });
          } catch (error) {
            throw mapAccountRecoveryError(error);
          }
        }),

      block: adminProcedure
        .input(z.object({ requestId: z.number().int().positive(), reason: z.string().trim().min(1).max(1000) }))
        .mutation(async ({ input, ctx }) => {
          try {
            return await accountRecoveryService.reviewAccountRecoveryRequest({
              requestId: input.requestId,
              action: "block",
              actorAdminId: ctx.user.id,
              reason: input.reason,
            });
          } catch (error) {
            throw mapAccountRecoveryError(error);
          }
        }),
    }),
  }),

  // ============ ADVANCED ACCOUNT MERGE (IPE-003 Foundation & Preview) ============
  // See server/services/accountMergePreviewService.ts for the read-only
  // safety/inventory logic below - this router is deliberately thin, same
  // split as the accountRecovery router above. IPE-005 through IPE-008 add
  // the actual merge-execution procedures in later phases; this phase adds
  // only the read-only preview.
  accountMerge: router({
    admin: router({
      // Read-only, safe to call repeatedly as the admin picks different
      // candidate targets - same shape/purpose as
      // accountRecovery.admin.previewApproval above. `requestId` must name
      // an existing, BLOCKED recovery request - Source is ALWAYS that
      // request's own requesterUserId, never accepted as input here, so
      // nothing a client sends can redirect this to a different source
      // account. `targetUserId` is the one thing an admin actually
      // supplies, exactly like previewApproval's targetUserId.
      preview: adminProcedure
        .input(z.object({ requestId: z.number().int().positive(), targetUserId: z.number().int().positive() }))
        .query(async ({ input }) => {
          const request = await db.getAccountRecoveryRequestById(input.requestId);
          if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "Recovery request not found" });
          if (request.status !== "blocked") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Advanced Account Merge preview requires a BLOCKED recovery request",
            });
          }

          return buildAccountMergePreview({
            requestId: input.requestId,
            sourceUserId: request.requesterUserId,
            targetUserId: input.targetUserId,
          });
        }),
    }),
  }),

});

export type AppRouter = typeof appRouter;
