import type { Express, Request, Response } from "express";
import { safeErrorSummary } from "../../scripts/lib/safeErrorSummary.mjs";
import { sdk } from "../_core/sdk";
import { completeWorkspaceGoogleDocsConsent } from "./googleDocs.runtime";

function queryValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function registerWorkspaceGoogleDocsRoutes(app: Express) {
  app.get(
    "/api/workspace/google/callback",
    async (req: Request, res: Response) => {
      if (process.env.WORKSPACE_AI_QC_RUNTIME_TARGET !== "preview") {
        res.status(404).send("Not found");
        return;
      }
      try {
        const user = await sdk.authenticateRequest(req);
        if (!user || user.role !== "admin") {
          res.status(403).send("Forbidden");
          return;
        }
        const code = queryValue(req.query.code);
        const state = queryValue(req.query.state);
        if (!code || !state || code.length > 4096 || state.length > 512) {
          res.redirect(302, "/workspace?workspaceDocs=invalid_callback");
          return;
        }
        await completeWorkspaceGoogleDocsConsent({
          actorUserId: user.id,
          code,
          state,
        });
        res.redirect(302, "/workspace?workspaceDocs=connected");
      } catch (error) {
        console.error(
          `[WorkspaceGoogleDocs] callback failed: ${safeErrorSummary(error)}`
        );
        res.redirect(302, "/workspace?workspaceDocs=error");
      }
    }
  );
}
