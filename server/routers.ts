import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as db from "./db";
import * as orderService from "./services/orderService";
import { fileRouter } from "./routers/fileRouter";

// ============ HELPER PROCEDURES ============

const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return next({ ctx });
});

// ============ MAIN ROUTER ============

export const appRouter = router({
  system: systemRouter,

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

    detail: publicProcedure.input(z.object({ novelId: z.number() })).query(async ({ input }) => {
      const novel = await db.getNovelById(input.novelId);
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
          throw new TRPCError({ code: "BAD_REQUEST" });
        }

        // Free episodes cannot be added to cart
        if (episode.isFree) {
          throw new TRPCError({ code: "BAD_REQUEST" });
        }

        const cart = await db.getOrCreateCart(ctx.user.id);
        if (!cart) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        // Check if already in cart
        const items = await db.getCartItems(cart.id);
        const alreadyInCart = items.some((i: any) => i.episodeId === input.episodeId);
        if (alreadyInCart) {
          throw new TRPCError({ code: "BAD_REQUEST" });
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
          throw new TRPCError({ code: "FORBIDDEN" });
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
          return { discountAmount };
        } catch (error: any) {
          throw new TRPCError({ code: "BAD_REQUEST" });
        }
      }),

    create: protectedProcedure
      .input(
        z.object({
          couponCode: z.string().optional(),
          pointsToRedeem: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const cart = await db.getOrCreateCart(ctx.user.id);
        if (!cart) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        const cartItems = await db.getCartItems(cart.id);
        if (cartItems.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST" });
        }

        try {
          const order = await orderService.createOrderFromCart(ctx.user.id, cartItems, input.couponCode, input.pointsToRedeem);

          // Clear cart after successful order creation
          await db.clearCart(cart.id);

          return order;
        } catch (error: any) {
          throw new TRPCError({ code: "BAD_REQUEST" });
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

        return { order, items, payment, history };
      }),

    uploadPaymentSlip: protectedProcedure
      .input(z.object({ orderId: z.number(), slipImageUrl: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const order = await db.getOrderById(input.orderId);
        if (!order) throw new TRPCError({ code: "NOT_FOUND" });

        if (order.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        const payment = await db.getPaymentByOrderId(order.id);
        if (!payment) throw new TRPCError({ code: "NOT_FOUND" });

        await db.updatePayment(payment.id, {
          slipImageUrl: input.slipImageUrl,
          slipSubmittedAt: new Date(),
          status: "pending",
        });

        return { success: true };
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
          throw new TRPCError({ code: "BAD_REQUEST" });
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
    payments: router({
      pending: adminProcedure.query(async () => {
        const payments = await db.getPendingPayments(50);

        const enriched = await Promise.all(
          payments.map(async (p: any) => {
            const order = await db.getOrderById(p.orderId);
            const items = order ? await db.getOrderItems(order.id) : [];
            return { ...p, order, items };
          })
        );

        return enriched;
      }),

      approve: adminProcedure
        .input(z.object({ paymentId: z.number() }))
        .mutation(async ({ input, ctx }) => {
        try {
          await orderService.approvePayment(input.paymentId, ctx.user.id);
          return { success: true };
        } catch (error: any) {
          throw new TRPCError({ code: "BAD_REQUEST" });
        }
      }),

      reject: adminProcedure
        .input(z.object({ paymentId: z.number(), rejectionReason: z.string() }))
        .mutation(async ({ input, ctx }) => {
          try {
            await orderService.rejectPayment(input.paymentId, ctx.user.id, input.rejectionReason);
            return { success: true };
          } catch (error: any) {
            throw new TRPCError({ code: "BAD_REQUEST" });
          }
        }),
    }),

    orders: router({
      list: adminProcedure.query(async () => {
        return db.getAllOrders(100);
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
    }),

    novels: router({
      list: adminProcedure.query(async () => {
        return db.getAllNovels();
      }),

      create: adminProcedure
        .input(
          z.object({
            title: z.string(),
            slug: z.string(),
            description: z.string().optional(),
            author: z.string().optional(),
            coverImageUrl: z.string().optional(),
            status: z.enum(["ongoing", "completed", "hiatus"]),
          })
        )
        .mutation(async ({ input }) => {
          // TODO: Implement novel creation in db
          return { success: true };
        }),
    }),

    banners: router({
      list: adminProcedure.query(async () => {
        return db.getAllBanners();
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
        return db.getAllCoupons();
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
          await db.createCoupon(input);
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
  }),
});

export type AppRouter = typeof appRouter;
