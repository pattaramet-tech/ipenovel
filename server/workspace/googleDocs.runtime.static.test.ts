import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("IPE-054-D2A static safety", () => {
  it("keeps Workspace Docs OAuth incremental and separate from login scope", () => {
    const login = source("server/_core/googleOAuth.ts");
    const runtime = source("server/workspace/googleDocs.runtime.ts");
    expect(login).toContain(
      'const GOOGLE_OAUTH_SCOPE = "openid email profile"'
    );
    expect(login).not.toContain("documents.readonly");
    expect(runtime).toContain("https://www.googleapis.com/drive/v3/files");
    expect(runtime).toContain("https://docs.googleapis.com/v1/documents");
    expect(runtime).toContain("WORKSPACE_GOOGLE_DOCS_REDIRECT_URI");
    expect(runtime).toContain("WORKSPACE_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY");
  });

  it("keeps the callback Preview-only and bound to an authenticated admin session", () => {
    const routes = source("server/workspace/googleDocs.routes.ts");
    expect(routes).toContain('WORKSPACE_AI_QC_RUNTIME_TARGET !== "preview"');
    expect(routes).toContain("sdk.authenticateRequest(req)");
    expect(routes).toContain('user.role !== "admin"');
    expect(routes).toContain("completeWorkspaceGoogleDocsConsent");
  });
  it("requires all AI/publish execution paths to remain explicitly disarmed", () => {
    const candidate = source("server/workspace/aiQc.realCandidate.ts");
    expect(candidate).toContain("WORKSPACE_AI_QC_PROVIDER_ENABLED");
    expect(candidate).toContain("WORKSPACE_AI_QC_EXECUTION_ENABLED");
    expect(candidate).toContain("WORKSPACE_PUBLISH_EXECUTION_ENABLED");
    expect(candidate).toContain('value === "false"');
    expect(candidate).not.toMatch(
      /createRuntimeWorkspaceAiQcProvider|runConfiguredPreviewAiQcWorkerOnce/
    );
  });

  it("exposes preparation but not provider-worker primitives through the Workspace router", () => {
    const router = source("server/workspace/router.ts");
    const page = source("client/src/pages/WorkspacePage.tsx");
    expect(router).toContain("prepareAiQcCandidate: adminProcedure");
    expect(router).toContain("beginConsent: adminProcedure");
    expect(router).not.toContain("runConfiguredPreviewAiQcWorkerOnce");
    expect(page).toContain("Prepare real AI QC candidate");
    expect(page).toContain("it does not call Gemini or publish");
  });
  it("wires the configured worker to the lazy Preview Google Docs runtime", () => {
    const worker = source("server/workspace/aiQc.worker.ts");
    const runtime = source("server/workspace/googleDocs.runtime.ts");
    expect(worker).toContain("resolveWorkspaceGoogleDocsAiQcExecutionRuntime");
    expect(worker).toContain("resolveDocsRuntime: () =>");
    expect(worker).toContain('| "accessToken"');
    expect(worker).toContain('| "docsAdapter"');
    expect(runtime).toContain('WORKSPACE_AI_QC_RUNTIME_TARGET !== "preview"');
    expect(runtime).toContain("connectionUserId !== input.actorUserId");
  });
});
