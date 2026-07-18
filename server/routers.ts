import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { sdk } from "./_core/sdk";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as db from "./db";
import * as orderService from "./services/orderService";
import * as walletService from "./services/walletService";
import { ApprovalService } from "./services/approvalService";
import { submitPaymentSlip } from "./services/slipSubmissionService";
import { uploadPaymentSlipFile } from "./services/slipFileUploadService";
import { fileRouter } from "./routers/fileRouter";
import { ocrMetricsRouter } from "./routers/ocrMetricsRouter";
import { storagePut } from "./storage";
import { parseSlipImage } from "./ocr-slip-verification-v2";
import { processSlipVerificationStaging } from "./ocr-slip-integration-staging";
import { getOCRConfig } from "./_core/ocr-config";
import {
  generateApprovalNote,
  generateManualReviewNote,
  generateShadowModeNote,
} from "./_core/ocr-order-notes";
import * as readerService from "./services/readerService";
import * as packageZipImportService from "./services/packageZipImportService";

// ============ HELPER PROCEDURES ============

const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return next({ ctx });
});

const BANNER_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const MAX_BANNER_IMAGE_SIZE = 5 * 1024 * 1024;

function sanitizeUploadFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
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
      const [popularNovels, newNovels, freeNovels, latestEpisodes, finishedNovels, banners] = await Promise.all([
        db.getPopularNovels(4),
        db.getNewNovels(4),
        db.getFreeNovels(4),
        db.getLatestEpisodes(4),
        db.getFinishedNovels(4),
        db.getAllBanners(),
      ]);

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
          search: z.string().optional(),
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

      const episodes = await db.getEpisodesByNovelId(input.novelId);
      const categories = await db.getCategoriesByNovelId(input.novelId);

      return {
        novel,
        episodes,
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
            fileUrl: canRead ? fileUrl ?? null : null,
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
          const message = error?.message || "Invalid coupon";
          throw new TRPCError({ code: "BAD_REQUEST", message });
        }
      }),

    create: protectedProcedure
      .input(
        z.object({
          couponCode: z.string().optional(),
          pointsToRedeem: z.string().optional(),
          slipImageUrl: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const cart = await db.getOrCreateCart(ctx.user.id);
        if (!cart) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        const cartItems = await db.getCartItems(cart.id);
        if (cartItems.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Your cart is empty. Please add items before checkout." });
        }

        try {
          // Create order WITHOUT slipImageUrl - let submitPaymentSlip handle the slip flow
          const order = await orderService.createOrderFromCart(String(ctx.user.id), cartItems, input.couponCode, input.pointsToRedeem, undefined);

          let slipResult = undefined;
          if (input.slipImageUrl) {
            // Call shared slip submission service
            slipResult = await submitPaymentSlip({
              orderId: order.id,
              slipImageUrl: input.slipImageUrl,
              userId: ctx.user.id,
            });
          }

          // Clear cart only after order and slip submission both succeed
          await db.clearCart(cart.id);

          return { ...order, slipResult };
        } catch (error: any) {
          const message = error?.message || "Failed to create order";
          throw new TRPCError({ code: "BAD_REQUEST", message });
        }
      }),

    walletCheckout: protectedProcedure
      .input(z.object({ couponCode: z.string().optional(), pointsToRedeem: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
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
          throw new TRPCError({ code: "BAD_REQUEST", message: error?.message || "Wallet checkout failed" });
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
          const payment = await db.getPaymentByOrderId(order.id);
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
        const payment = await db.getPaymentByOrderId(order.id);
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
      .input(z.object({ orderId: z.number(), slipImageUrl: z.string().min(1, "Payment slip is required") }))
      .mutation(async ({ input, ctx }) => {
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

      // Group by novel
      const novelMap = new Map();

      for (const purchase of purchases) {
        const novel = await db.getNovelById(purchase.novelId);
        const episode = await db.getEpisodeById(purchase.episodeId);
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

        return episode;
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

        // In a real implementation, generate a pre-signed URL or proxy the download
        return { downloadUrl: episode.fileUrl };
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
          // Bidirectional points adjustment: positive = add, negative = subtract
          const absAmount = Math.abs(amountNum);
          let operation = 'add';
          
          if (amountNum > 0) {
            // Add points
            const newPointsBalance = (parseFloat(await db.getUserPointsBalance(input.userId)) + absAmount).toString();
          await db.recordPointsTransaction({ userId: input.userId, amount: absAmount.toString(), type: "adjust", balanceAfter: newPointsBalance, note: `Admin add: ${input.reason}` });
          } else if (amountNum < 0) {
            // Subtract points
            const newPointsBalance2 = (parseFloat(await db.getUserPointsBalance(input.userId)) - absAmount).toString();
          await db.recordPointsTransaction({ userId: input.userId, amount: (-absAmount).toString(), type: "adjust", balanceAfter: newPointsBalance2, note: `Admin subtract: ${input.reason}` });
            operation = 'subtract';
          } else {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Amount must be non-zero" });
          }
          
          const newBalance = await db.getUserPointsBalance(input.userId);
          return { success: true, newBalance, operation };
        }),
    }),
  }),

  // ============ WISHLISTS ============
  wishlists: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const wishlists = await db.getWishlistsByUserId(ctx.user.id);

      const enriched = await Promise.all(
        wishlists.map(async (w: any) => {
          const novel = await db.getNovelById(w.novelId);
          return { ...w, novel };
        })
      );

      return enriched;
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
        const existing = await db.getWishlistByUserAndNovel(ctx.user.id, input.novelId);
        if (existing) {
          throw new TRPCError({ code: "CONFLICT", message: "This novel is already in your wishlist" });
        }

        await db.addToWishlist(ctx.user.id, input.novelId);
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

  // ============ FILE MANAGEMENT ============
  files: fileRouter,

  // ============ ADMIN ROUTES ============
  admin: router({
    ocr: ocrMetricsRouter,
    login: publicProcedure
      .input(z.object({ email: z.string().email(), password: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const admin = await db.getAdminByEmail(input.email);
        if (!admin || !admin.passwordHash) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" });
        }

        const bcrypt = await import("bcryptjs");
        const isPasswordValid = await bcrypt.compare(input.password, admin.passwordHash);
        if (!isPasswordValid) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" });
        }

        // Create a session token for the admin user
        const sessionToken = await sdk.createSessionToken(`admin-${admin.id}`, {
          name: admin.email || "admin",
        });

        // Set the session cookie
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, sessionToken, {
          ...cookieOptions,
          maxAge: ONE_YEAR_MS,
        });

        return { success: true, adminId: admin.id };
      }),

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
          const payment = await db.getPaymentByOrderId(order.id);
          const history = await db.getOrderHistory(order.id);

          // Include approval metadata if payment exists
          let approvalMetadata = null;
          let formattedApprovalSource = null;
          if (payment) {
            approvalMetadata = ApprovalService.getDisplayMetadata(payment);
            formattedApprovalSource = ApprovalService.formatApprovalSource(payment.approvalSource);
          }

          return { order, items, payment, history, approvalMetadata, formattedApprovalSource };
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
            throw new TRPCError({ code: "BAD_REQUEST", message: error?.message || "Failed to approve payment. Please try again." });
          }
          return { success: true };
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

          const timestamp = Date.now();
          const randomSuffix = Math.random().toString(36).substring(2, 8);
          const sanitizedFileName = sanitizeUploadFileName(input.fileName);
          const fileKey = `novel-covers/${ctx.user.id}/${timestamp}-${randomSuffix}-${sanitizedFileName}`;

          const { url, key } = await storagePut(fileKey, fileBuffer, input.mimeType);

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
            fileUrl: z.string().optional(),
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
            fileUrl: z.string().optional(),
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

    // ============ HYBRID CONTENT HEALTH DASHBOARD (Phase 1, read-only) ============
    // Surfaces episodes at risk from the hybrid fileUrl/content model: rows
    // with neither content nor fileUrl (unreadable even if purchased),
    // packages whose episodeNumber can't be normalized, and duplicate
    // normalized ranges within a novel. No mutations - purely diagnostic.
    hybridHealth: router({
      overview: adminProcedure.query(async () => {
        const { getAllNovelHealthOverview } = await import("./services/hybridHealthService");
        return getAllNovelHealthOverview();
      }),

      detail: adminProcedure
        .input(z.object({ novelId: z.number() }))
        .query(async ({ input }) => {
          const { getNovelHealthDetail } = await import("./services/hybridHealthService");
          return getNovelHealthDetail(input.novelId);
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

          const timestamp = Date.now();
          const randomSuffix = Math.random().toString(36).substring(2, 8);
          const sanitizedFileName = sanitizeUploadFileName(input.fileName);
          const fileKey = `banners/${timestamp}-${randomSuffix}-${sanitizedFileName}`;

          const { url, key } = await storagePut(fileKey, fileBuffer, input.mimeType);

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
        const coupons = await db.getAllCoupons();
        return coupons.map((coupon: any) => ({
          ...coupon,
          discountValue: coupon.discountValue ? String(coupon.discountValue).trim() : "0.00",
          minPurchaseAmount: coupon.minPurchaseAmount ? String(coupon.minPurchaseAmount).trim() : null,
        }));
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
          })
        )
        .mutation(async ({ input }) => {
          const normalizedInput = {
            ...input,
            discountValue: String(input.discountValue).trim(),
            minPurchaseAmount: input.minPurchaseAmount ? String(input.minPurchaseAmount).trim() : undefined,
          };
          await db.createCoupon(normalizedInput);
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
          await db.updateCoupon(couponId, normalizedData);
          return { success: true };
        }),

      delete: adminProcedure
        .input(z.object({ couponId: z.number() }))
        .mutation(async ({ input }) => {
          await db.deleteCoupon(input.couponId);
          return { success: true };
        }),
    }),

    settings: router({
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
            fileUrl: z.string(),
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
            fileUrl: z.string(),
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
          const base64Data = input.fileBase64.split(",")[1] || input.fileBase64;
          const fileBuffer = Buffer.from(base64Data, "base64");

          const maxSize = 2 * 1024 * 1024;
          if (fileBuffer.length > maxSize) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Sports image must be 2MB or smaller" });
          }

          const timestamp = Date.now();
          const randomSuffix = Math.random().toString(36).substring(2, 8);
          const sanitizedFileName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
          const fileKey = `sports-matches/${ctx.user.id}/${timestamp}-${randomSuffix}-${sanitizedFileName}`;

          const { url, key } = await storagePut(fileKey, fileBuffer, input.mimeType);
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
      .input(z.object({ requestedAmount: z.string(), slipImageUrl: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        return walletService.createWalletTopupRequest(ctx.user.id, input.requestedAmount, input.slipImageUrl);
      }),
    // DEPRECATED: uploadTopupSlip is kept for backward compatibility with existing pending top-ups
    // New flow: slip is uploaded before creating the top-up request
    uploadTopupSlip: protectedProcedure
      .input(z.object({ topupId: z.number(), slipImageUrl: z.string() }))
      .mutation(async ({ ctx, input }) => {
        return walletService.uploadWalletTopupSlip(input.topupId, ctx.user.id, input.slipImageUrl);
      }),
    admin: router({
      listPendingTopups: adminProcedure
        .input(z.object({ limit: z.number().default(20), offset: z.number().default(0) }))
        .query(async ({ input }) => {
          return db.listPendingWalletTopups(input.limit, input.offset);
        }),
      detail: adminProcedure
        .input(z.object({ topupId: z.number() }))
        .query(async ({ input }) => {
          const topup = await db.getWalletTopupById(input.topupId);
          if (!topup) throw new TRPCError({ code: "NOT_FOUND" });

          // Get user info
          const user = topup.userId ? await db.getUserById(topup.userId) : null;

          // Get topup logs related to this user (audit trail)
          const logs = topup.userId ? await db.getTopupLogs(topup.userId, undefined, undefined, 50) : [];

          return {
            topup,
            user,
            logs: logs || [],
          };
        }),
      approveTopup: adminProcedure
        .input(z.object({ topupId: z.number() }))
        .mutation(async ({ ctx, input }) => {
          return walletService.adminApproveWalletTopup(input.topupId, ctx.user.id);
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
            relatedTopup,
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

});

export type AppRouter = typeof appRouter;
