import { Router, Request, Response } from "express";
import { getDb } from "../db";
import { episodes, purchases } from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";

const router = Router();

/**
 * GET /api/download/:episodeId
 * 
 * Centralized episode download/access route with:
 * 1. Authentication check (Manus Auth)
 * 2. Authorization check (user has purchase entitlement)
 * 3. Episode existence check
 * 4. fileUrl validation
 * 5. Redirect to episode.fileUrl if authorized
 */
router.get("/download/:episodeId", async (req: Request, res: Response) => {
  const episodeId = parseInt(req.params.episodeId, 10);
  
  // 1. Authentication check
  const user = (req as any).user;
  if (!user || !user.id) {
    console.warn(`[Download] Unauthenticated access attempt to episode ${episodeId}`);
    return res.status(401).json({ error: "Unauthorized: Please log in" });
  }

  try {
    const db = await getDb();
    if (!db) {
      console.error("[Download] Database connection failed");
      return res.status(500).json({ error: "Server error" });
    }

    // 3. Episode existence check
    const episodeResult = await db
      .select()
      .from(episodes)
      .where(eq(episodes.id, episodeId))
      .limit(1);

    if (episodeResult.length === 0) {
      console.warn(`[Download] Episode not found: ${episodeId}`);
      return res.status(404).json({ error: "Episode not found" });
    }

    const episode = episodeResult[0];

    // 4. fileUrl validation
    if (!episode.fileUrl || episode.fileUrl.trim() === "") {
      console.warn(`[Download] Episode ${episodeId} has no fileUrl`);
      return res.status(404).json({ error: "Episode file not available" });
    }

    // Check if episode is free
    const isFree = episode.isFree === true;

    if (!isFree) {
      // 2. Authorization check for paid episodes
      const purchaseResult = await db
        .select()
        .from(purchases)
        .where(
          and(
            eq(purchases.userId, user.id),
            eq(purchases.episodeId, episodeId)
          )
        )
        .limit(1);

      if (purchaseResult.length === 0) {
        console.warn(
          `[Download] Access denied for user ${user.id} to episode ${episodeId}`
        );
        return res.status(403).json({ error: "Access denied: Episode not purchased" });
      }
    }

    // Log successful access
    console.info(
      `[Download] User ${user.id} redirected to episode ${episodeId} (free=${isFree})`
    );

    // 5. Redirect to fileUrl
    return res.redirect(episode.fileUrl);
  } catch (error) {
    console.error(`[Download] Error processing episode ${episodeId}:`, error);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
