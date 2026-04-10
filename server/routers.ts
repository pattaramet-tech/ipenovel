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
import { fileRouter } from "./routers/fileRouter";
import { parseSlipImage } from "./ocr-slip-verification";
import { processSlipVerification } from "./ocr-slip-integration";

// ============ HELPER PROCEDURES ============

const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return next({ ctx });
});

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
      const [popularNovels, newNovels, freeNovels, latestEpisodes] = await Promise.all([
        db.getPopularNovels(4),
        db.getNewNovels(4),
        db.getFreeNovels(4),
        db.getLatestEpisodes(4),
      ]);

      return {
        popularNovels,
        newNovels,
        freeNovels,
        latestEpisodes,
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

      // Enrich episodes with purchase status
      const enriched = await Promise.all(
        episodes.map(async (ep: any) => {
          const isPurchased = await orderService.isEpisodeAlreadyPurchased(ctx.user.id, ep.id);
          return {
            ...ep,
            isPurchased,
            isFree: ep.isFree,
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

        // Check if already purchased
        const isPurchased = await orderService.isEpisodeAlreadyPurchased(ctx.user.id, input.episodeId);
        if (isPurchased) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This episode has already been purchased" });
        }

        // Free episodes cannot be added to cart
        if (episode.isFree) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Free episodes cannot be added to cart" });
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
    validateCoupon: publicProcedure
      .input(z.object({ couponCode: z.string(), subtotal: z.string() }))
      .query(async ({ input }) => {
        try {
          const { discountAmount } = await orderService.validateAndApplyCoupon(input.couponCode, input.subtotal);
          return { discountAmount, valid: true };
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
          const order = await orderService.createOrderFromCart(String(ctx.user.id), cartItems, input.couponCode, input.pointsToRedeem, input.slipImageUrl);

          // Clear cart after successful order creation
          await db.clearCart(cart.id);

          return order;
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
            const { discountAmount: discount } = await orderService.validateAndApplyCoupon(input.couponCode, subtotal.toString());
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
            
            // STEP 5-7: Use central approval service for wallet payment
            // This ensures wallet uses the same finalization path as manual and auto approvals
            const payment = await db.getPaymentByOrderId(newOrder.id, tx);
            if (payment) {
              await orderService.approvePaymentWithSource(
                payment.id,
                "wallet",
                undefined,
                "Wallet",
                tx
              );
            }
            
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
        // Validate slip URL is not empty
        if (!input.slipImageUrl || input.slipImageUrl.trim().length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Payment slip is required" });
        }

        const order = await db.getOrderById(input.orderId);
        if (!order) throw new TRPCError({ code: "NOT_FOUND" });

        if (order.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        const payment = await db.getPaymentByOrderId(order.id);
        if (!payment) throw new TRPCError({ code: "NOT_FOUND" });

        // Update payment with slip URL and submission time
        await db.updatePayment(payment.id, {
          slipImageUrl: input.slipImageUrl,
          slipSubmittedAt: new Date(),
          status: "pending",
        });

        // Extract OCR text from slip image
        const slipOcrText = await parseSlipImage(input.slipImageUrl);

        // Process slip verification and auto-approval
        const verificationResult = await processSlipVerification(payment.id, slipOcrText);

        // Sync order status based on verification result
        if (verificationResult.isAutoApproved) {
          // Auto-approved: use central approval service to ensure finalization runs
          await orderService.approvePaymentWithSource(
            payment.id,
            "auto", // approval source
            undefined, // no admin ID for auto-approval
            "AutoApp" // display label
          );
        } else {
          // Pending review: keep order pending
          await db.updateOrder(order.id, {
            paymentStatus: "submitted",
            status: "pending",
          });

          // Record order history for pending review
          await db.recordOrderHistory({
            orderId: order.id,
            action: "payment_slip_submitted",
            fromStatus: order.status,
            toStatus: "pending",
            actorUserId: ctx.user.id,
            note: `Payment slip submitted for manual review. Reason: ${verificationResult.reviewReason || "Unknown"}`,
          });
        }

        return {
          success: true,
          isAutoApproved: verificationResult.isAutoApproved,
          reviewReason: verificationResult.reviewReason,
        };
      }),
  }),

  // ============ MY NOVELS (PURCHASED CONTENT) ============
  myNovels: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const purchases = await db.getPurchasesByUserId(ctx.user.id);

      // Group by novel
      const novelMap = new Map();

      for (const purchase of purchases) {
        const novel = await db.getNovelById(purchase.novelId);
        const episode = await db.getEpisodeById(purchase.episodeId);

        if (!novelMap.has(purchase.novelId)) {
          novelMap.set(purchase.novelId, {
            novel,
            episodes: [],
          });
        }

        novelMap.get(purchase.novelId).episodes.push({
          ...episode,
          purchasedAt: purchase.grantedAt,
        });
      }

      return Array.from(novelMap.values());
    }),

    episode: protectedProcedure
      .input(z.object({ episodeId: z.number() }))
      .query(async ({ input, ctx }) => {
        // Check access
        const hasAccess = await orderService.hasAccessToEpisode(ctx.user.id, input.episodeId);
        if (!hasAccess) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        const episode = await db.getEpisodeById(input.episodeId);
        if (!episode) throw new TRPCError({ code: "NOT_FOUND" });

        return episode;
      }),

    downloadUrl: protectedProcedure
      .input(z.object({ episodeId: z.number() }))
      .query(async ({ input, ctx }) => {
        // Check access
        const hasAccess = await orderService.hasAccessToEpisode(ctx.user.id, input.episodeId);
        if (!hasAccess) {
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
            return { ...p, order, items, user };
          })
        );

        return enriched;
      }),

      approve: adminProcedure
        .input(z.object({ paymentId: z.number() }))
        .mutation(async ({ input, ctx }) => {
          try {
            // Use central approval service with manual approval source
            const adminName = ctx.user.name || ctx.user.email || `Admin ${ctx.user.id}`;
            await orderService.approvePaymentWithSource(
              input.paymentId,
              "manual", // approval source
              ctx.user.id, // admin ID
              adminName // display label
            );
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
    }),

    orders: router({
      list: adminProcedure
        .input(
          z.object({
            page: z.number().int().positive().default(1),
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
          return db.getAdminOrdersWithUsers({
            page: input.page,
            pageSize: input.pageSize,
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
        }),

      detail: adminProcedure
        .input(z.object({ orderId: z.number() }))
        .query(async ({ input }) => {
          const order = await db.getOrderById(input.orderId);
          if (!order) throw new TRPCError({ code: "NOT_FOUND" });

          const items = await db.getOrderItems(order.id);
          const payment = await db.getPaymentByOrderId(order.id);
          const history = await db.getOrderHistory(order.id);

          return { order, items, payment, history };
        }),

      approve: adminProcedure
        .input(z.object({ orderId: z.number(), reason: z.string().optional() }))
        .mutation(async ({ input, ctx }) => {
          const order = await db.getOrderById(input.orderId);
          if (!order) throw new TRPCError({ code: "NOT_FOUND" });
          if (order.status !== "pending") {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Order is not pending" });
          }

          const payment = await db.getPaymentByOrderId(input.orderId);
          if (!payment) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Payment not found" });
          }

          // Use central approval service for consistency
          const adminName = ctx.user.name || ctx.user.email || `Admin ${ctx.user.id}`;
          await orderService.approvePaymentWithSource(
            payment.id,
            "manual",
            ctx.user.id,
            adminName
          );

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

          const payment = await db.getPaymentByOrderId(input.orderId);
          if (!payment) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Payment not found" });
          }

          // Use central rejection service for consistency
          await orderService.rejectPayment(
            payment.id,
            String(ctx.user.id),
            input.rejectionReason
          );

          return { success: true };
        }),
    }),

    dashboard: dashboardRouter,

    getAllEpisodes: adminProcedure.query(async () => {
      return db.getAllEpisodes();
    }),

    novels: router({
      list: adminProcedure.query(async () => {
        return db.getAllNovelsForAdmin();
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
      list: adminProcedure
        .input(z.object({ novelId: z.number().optional() }))
        .query(async ({ input }) => {
          if (input.novelId) {
            return db.getEpisodesByNovelId(input.novelId);
          }
          return db.getAllEpisodes();
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

    banners: router({
      list: adminProcedure.query(async () => {
        // Admin needs all banners (including inactive)
        return db.getAllBannersAdmin();
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
        .input(z.object({ userId: z.number(), amount: z.string(), reason: z.string() }))
        .mutation(async ({ ctx, input }) => {
          const amountNum = parseFloat(input.amount);
          if (isNaN(amountNum)) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid amount" });
          }
          // Bidirectional wallet adjustment: positive = credit, negative = debit
          const reference = `admin-adjust-${Date.now()}`;
          const absAmount = Math.abs(amountNum).toString();
          let operation = 'credit';
          
          if (amountNum > 0) {
            // Credit operation
            await db.creditWalletBalance(input.userId, absAmount, "admin_adjust", 0);
          } else if (amountNum < 0) {
            // Debit operation
            await db.debitWalletBalance(input.userId, absAmount, "admin_adjust", 0);
            operation = 'debit';
          } else {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Amount must be non-zero" });
          }
          
          // Create topup log for audit trail
          await db.createTopupLog(
            input.userId,
            absAmount,
            "0.00",
            "admin_adjust",
            reference,
            `Admin ${operation}: ${input.reason}`,
            ctx.user.id
          );
          const newBalance = await db.getWalletBalance(input.userId);
          return { success: true, newBalance, operation };
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
    }),
  }),

});

export type AppRouter = typeof appRouter;
