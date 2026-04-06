"use server";

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

  // ============ NOVELS ============
  novels: router({
    list: publicProcedure
      .input(
        z.object({
          page: z.number().int().positive().default(1),
          limit: z.number().int().min(1).max(100).default(20),
          search: z.string().optional(),
          genre: z.string().optional(),
          sortBy: z.enum(["popular", "new", "rating"]).default("new"),
        })
      )
      .query(async ({ input }) => {
        return db.listNovels(input.page, input.limit, input.search, input.genre, input.sortBy);
      }),

    detail: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const novel = await db.getNovelById(input.id);
        if (!novel) throw new TRPCError({ code: "NOT_FOUND" });

        const episodes = await db.getEpisodesByNovelId(input.id);

        // Check user access if authenticated
        let userAccess: Record<number, boolean> = {};
        if (ctx.user) {
          userAccess = await db.getUserEpisodeAccess(ctx.user.id, input.id);
        }

        return {
          ...novel,
          episodes: episodes.map((ep) => ({
            ...ep,
            hasAccess: userAccess[ep.id] || false,
          })),
        };
      }),

    read: protectedProcedure
      .input(z.object({ episodeId: z.number() }))
      .query(async ({ input, ctx }) => {
        const episode = await db.getEpisodeById(input.episodeId);
        if (!episode) throw new TRPCError({ code: "NOT_FOUND" });

        // Check access
        const hasAccess = await db.hasAccessToEpisode(ctx.user.id, input.episodeId);
        if (!hasAccess) throw new TRPCError({ code: "FORBIDDEN" });

        // Record read event
        await db.recordReadEvent(ctx.user.id, input.episodeId);

        return episode;
      }),
  }),

  // ============ CART & CHECKOUT ============
  cart: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      return db.getCart(ctx.user.id);
    }),

    add: protectedProcedure
      .input(z.object({ episodeId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        // Check if already in cart
        const existing = await db.getCartItem(ctx.user.id, input.episodeId);
        if (existing) {
          return { success: false, message: "Already in cart" };
        }

        // Check if already purchased
        const purchased = await db.isEpisodeAlreadyPurchased(ctx.user.id, input.episodeId);
        if (purchased) {
          return { success: false, message: "Already purchased" };
        }

        await db.addToCart(ctx.user.id, input.episodeId);
        return { success: true };
      }),

    remove: protectedProcedure
      .input(z.object({ episodeId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await db.removeFromCart(ctx.user.id, input.episodeId);
        return { success: true };
      }),

    clear: protectedProcedure.mutation(async ({ ctx }) => {
      await db.clearCart(ctx.user.id);
      return { success: true };
    }),
  }),

  orders: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return db.getOrdersByUserId(ctx.user.id);
    }),

    detail: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const order = await db.getOrderById(input.id);
        if (!order || order.userId !== ctx.user.id) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }
        return order;
      }),

    create: protectedProcedure
      .input(
        z.object({
          couponCode: z.string().optional(),
          pointsToRedeem: z.number().int().nonnegative().optional(),
          slipImageUrl: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const cartItems = await db.getCart(ctx.user.id);
        if (!cartItems || cartItems.items.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Cart is empty" });
        }

        const order = await orderService.createOrderFromCart(String(ctx.user.id), cartItems.items, input.couponCode, input.pointsToRedeem, input.slipImageUrl);
        return order;
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
          // Auto-approved: mark order as completed
          await db.updateOrder(order.id, {
            paymentStatus: "approved",
            status: "completed",
          });

          // Record order history for auto-approval
          await db.recordOrderHistory({
            orderId: order.id,
            action: "payment_auto_approved",
            fromStatus: order.status,
            toStatus: "completed",
            actorUserId: 0, // 0 indicates system auto-approval
            note: `Payment auto-approved via OCR verification (confidence: ${verificationResult.extractedData?.confidence || 0}%)`,
          });
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
        if (!novelMap.has(purchase.novelId)) {
          const novel = await db.getNovelById(purchase.novelId);
          if (novel) {
            novelMap.set(purchase.novelId, {
              ...novel,
              purchasedEpisodes: [],
            });
          }
        }
        const novel = novelMap.get(purchase.novelId);
        if (novel) {
          novel.purchasedEpisodes.push(purchase.episodeId);
        }
      }

      return Array.from(novelMap.values());
    }),
  }),

  // ============ ADMIN PANEL ============
  admin: router({
    dashboard: adminProcedure.query(async () => {
      return dashboardRouter.createCaller({}).summary();
    }),

    novels: router({
      list: adminProcedure.query(async () => {
        return db.getAllNovels();
      }),

      create: adminProcedure
        .input(
          z.object({
            title: z.string().min(1),
            description: z.string(),
            author: z.string(),
            genre: z.string(),
            coverImageUrl: z.string().optional(),
          })
        )
        .mutation(async ({ input }) => {
          return db.createNovel(input);
        }),

      update: adminProcedure
        .input(
          z.object({
            id: z.number(),
            title: z.string().optional(),
            description: z.string().optional(),
            author: z.string().optional(),
            genre: z.string().optional(),
            coverImageUrl: z.string().optional(),
          })
        )
        .mutation(async ({ input }) => {
          const { id, ...updates } = input;
          return db.updateNovel(id, updates);
        }),

      delete: adminProcedure
        .input(z.object({ id: z.number() }))
        .mutation(async ({ input }) => {
          return db.deleteNovel(input.id);
        }),
    }),

    episodes: router({
      list: adminProcedure
        .input(z.object({ novelId: z.number() }))
        .query(async ({ input }) => {
          return db.getEpisodesByNovelId(input.novelId);
        }),

      create: adminProcedure
        .input(
          z.object({
            novelId: z.number(),
            title: z.string().min(1),
            content: z.string(),
            episodeNumber: z.number().int().positive(),
            price: z.number().nonnegative(),
          })
        )
        .mutation(async ({ input }) => {
          return db.createEpisode(input);
        }),

      update: adminProcedure
        .input(
          z.object({
            id: z.number(),
            title: z.string().optional(),
            content: z.string().optional(),
            episodeNumber: z.number().int().positive().optional(),
            price: z.number().nonnegative().optional(),
          })
        )
        .mutation(async ({ input }) => {
          const { id, ...updates } = input;
          return db.updateEpisode(id, updates);
        }),

      delete: adminProcedure
        .input(z.object({ id: z.number() }))
        .mutation(async ({ input }) => {
          return db.deleteEpisode(input.id);
        }),
    }),

    payments: router({
      list: adminProcedure.query(async () => {
        return db.getAllPayments();
      }),

      pending: adminProcedure.query(async () => {
        // Get all pending_review payments with related order and user data
        const payments = await db.getAllPayments();
        return payments.filter(p => p.status === "pending_review");
      }),

      detail: adminProcedure
        .input(z.object({ id: z.number() }))
        .query(async ({ input }) => {
          return db.getPaymentById(input.id);
        }),

      approve: adminProcedure
        .input(z.object({ paymentId: z.number() }))
        .mutation(async ({ input, ctx }) => {
          const payment = await db.getPaymentById(input.paymentId);
          if (!payment) throw new TRPCError({ code: "NOT_FOUND" });

          if (payment.status !== "pending_review") {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Payment is not pending review" });
          }

          // Approve payment
          await db.approvePayment(payment.id, ctx.user.id);

          // Get order and mark as completed
          const order = await db.getOrderById(payment.orderId);
          if (order) {
            await db.updateOrder(order.id, {
              paymentStatus: "approved",
              status: "completed",
            });

            // Record order history
            await db.recordOrderHistory({
              orderId: order.id,
              action: "payment_approved",
              fromStatus: order.status,
              toStatus: "completed",
              actorUserId: ctx.user.id,
              note: "Payment approved by admin",
            });
          }

          return { success: true };
        }),

      reject: adminProcedure
        .input(z.object({ paymentId: z.number(), reason: z.string() }))
        .mutation(async ({ input, ctx }) => {
          const payment = await db.getPaymentById(input.paymentId);
          if (!payment) throw new TRPCError({ code: "NOT_FOUND" });

          if (payment.status !== "pending_review") {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Payment is not pending review" });
          }

          // Reject payment
          await db.rejectPayment(payment.id, ctx.user.id, input.reason);

          // Get order and revert to pending
          const order = await db.getOrderById(payment.orderId);
          if (order) {
            await db.updateOrder(order.id, {
              paymentStatus: "rejected",
              status: "pending",
            });

            // Record order history
            await db.recordOrderHistory({
              orderId: order.id,
              action: "payment_rejected",
              fromStatus: order.status,
              toStatus: "pending",
              actorUserId: ctx.user.id,
              note: `Payment rejected: ${input.reason}`,
            });
          }

          return { success: true };
        }),
    }),

    orders: router({
      list: adminProcedure.query(async () => {
        return db.getAllOrders();
      }),

      detail: adminProcedure
        .input(z.object({ id: z.number() }))
        .query(async ({ input }) => {
          return db.getOrderById(input.id);
        }),
    }),

    users: router({
      list: adminProcedure.query(async () => {
        return db.getAllUsers();
      }),

      detail: adminProcedure
        .input(z.object({ id: z.string() }))
        .query(async ({ input }) => {
          return db.getUserById(input.id);
        }),
    }),

    dashboard: dashboardRouter,
  }),

  // ============ WALLET ============
  wallet: router({
    getBalance: protectedProcedure.query(async ({ ctx }) => {
      return walletService.getWalletBalance(ctx.user.id);
    }),

    createTopupRequest: protectedProcedure
      .input(z.object({ requestedAmount: z.string(), slipImageUrl: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        return walletService.createWalletTopupRequest(ctx.user.id, input.requestedAmount, input.slipImageUrl);
      }),

    uploadTopupSlip: protectedProcedure
      .input(z.object({ topupId: z.number(), slipImageUrl: z.string() }))
      .mutation(async ({ input, ctx }) => {
        return walletService.uploadWalletTopupSlip(input.topupId, ctx.user.id, input.slipImageUrl);
      }),

    getTopupLogs: protectedProcedure.query(async ({ ctx }) => {
      return walletService.getTopupLogs(ctx.user.id);
    }),

    getTopupRequests: adminProcedure.query(async () => {
      return walletService.getTopupRequests();
    }),

    approveTopup: adminProcedure
      .input(z.object({ topupId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        return walletService.approveWalletTopup(input.topupId, ctx.user.id);
      }),

    rejectTopup: adminProcedure
      .input(z.object({ topupId: z.number(), reason: z.string() }))
      .mutation(async ({ input, ctx }) => {
        return walletService.rejectWalletTopup(input.topupId, ctx.user.id, input.reason);
      }),
  }),

  // ============ CHECKOUT ============
  checkout: router({
    createOrder: protectedProcedure
      .input(
        z.object({
          couponCode: z.string().optional(),
          pointsToRedeem: z.number().int().nonnegative().optional(),
          slipImageUrl: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const cartItems = await db.getCart(ctx.user.id);
        if (!cartItems || cartItems.items.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Cart is empty" });
        }

        const order = await orderService.createOrderFromCart(String(ctx.user.id), cartItems.items, input.couponCode, input.pointsToRedeem, input.slipImageUrl);
        return order;
      }),

    walletCheckout: protectedProcedure
      .input(z.object({ orderId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        return orderService.walletCheckout(String(ctx.user.id), input.orderId);
      }),
  }),

  // ============ FILES ============
  files: fileRouter,
});
