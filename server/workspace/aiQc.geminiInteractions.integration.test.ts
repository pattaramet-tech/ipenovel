import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  users,
  workspaceAiProviderAuditLogs,
  workspaceAiProviderProfiles,
  workspaceAiProviderState,
} from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { createTestUser } from "../test-helpers/fixtures";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import {
  saveWorkspaceAiProviderProfile,
  setActiveWorkspaceAiProvider,
} from "./aiProviderConfig.service";
import { createRuntimeWorkspaceAiQcProvider } from "./aiProviderRuntime";

const originalEnabled = ENV.workspaceAiQcProviderEnabled;
const originalVaultKey = ENV.workspaceSecretEncryptionKey;
const vaultKey = "44".repeat(32);

function interaction(id: string) {
  return {
    id,
    object: "interaction",
    status: "completed",
    model: "gemini-3.8-flash",
    steps: [
      {
        type: "model_output",
        content: [{ type: "text", text: JSON.stringify({ findings: [] }) }],
      },
    ],
  };
}

afterEach(() => {
  ENV.workspaceAiQcProviderEnabled = originalEnabled;
  ENV.workspaceSecretEncryptionKey = originalVaultKey;
});

describe.sequential("IPE-054-D1 managed Gemini Interactions runtime", () => {
  it("resolves an encrypted active profile, executes once, then reconciles by Interaction id", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    ENV.workspaceAiQcProviderEnabled = "true";
    ENV.workspaceSecretEncryptionKey = vaultKey;
    const admin = await createTestUser({ role: "admin" });
    let profileId: number | null = null;
    try {
      await expect(
        saveWorkspaceAiProviderProfile(admin.id, {
          name: `D1 invalid host ${Date.now()}`,
          providerType: "gemini_interactions",
          providerName: "gemini",
          apiUrl: "https://evil.example.test/v1beta/interactions",
          apiKey: "blocked-key",
          model: "gemini-3.8-flash",
          status: "enabled",
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        saveWorkspaceAiProviderProfile(admin.id, {
          name: `D1 override ${Date.now()}`,
          providerType: "gemini_interactions",
          providerName: "gemini",
          apiUrl:
            "https://generativelanguage.googleapis.com/v1beta/interactions",
          apiKey: "blocked-key",
          model: "gemini-3.8-flash",
          reconcileUrlTemplate:
            "https://generativelanguage.googleapis.com/v1beta/interactions/{providerRequestId}",
          status: "enabled",
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const created = await saveWorkspaceAiProviderProfile(admin.id, {
        name: `D1 Gemini ${Date.now()}`,
        providerType: "gemini_interactions",
        providerName: "gemini",
        apiUrl: "https://generativelanguage.googleapis.com/v1beta/interactions",
        apiKey: "gemini-integration-key",
        model: "gemini-3.8-flash",
        reconcileUrlTemplate: null,
        timeoutMs: 30000,
        maxInputChars: 200000,
        status: "enabled",
      });
      profileId = created.id;
      expect(created.reconcileUrlTemplate).toBeNull();
      await setActiveWorkspaceAiProvider(admin.id, profileId, 0);

      let callNo = 0;
      const fetchMock = vi.fn(
        async (url: string | URL | Request, init?: RequestInit) => {
          callNo += 1;
          const headers = new Headers(init?.headers);
          expect(headers.get("x-goog-api-key")).toBe("gemini-integration-key");
          expect(headers.get("authorization")).toBeNull();
          if (callNo === 1) {
            expect(String(url)).toBe(
              "https://generativelanguage.googleapis.com/v1beta/interactions"
            );
            expect(init?.method).toBe("POST");
            return new Response(JSON.stringify(interaction("int_d1_receipt")), {
              status: 200,
            });
          }
          expect(String(url)).toBe(
            "https://generativelanguage.googleapis.com/v1beta/interactions/int_d1_receipt"
          );
          expect(init?.method).toBe("GET");
          expect(init?.body).toBeUndefined();
          return new Response(JSON.stringify(interaction("int_d1_receipt")), {
            status: 200,
          });
        }
      );

      const provider = await createRuntimeWorkspaceAiQcProvider(
        fetchMock as typeof fetch
      );
      const executeResult = (await provider.execute({
        requestKey: "c".repeat(64),
        operation: "novel_qc",
        promptVersion: "prompt-v1",
        modelPolicyVersion: "policy-v1",
        snapshotId: 9,
        normalizedSha256: "d".repeat(64),
        content: "synthetic D1 integration content",
      })) as any;
      expect(executeResult.providerRequestId).toBe("int_d1_receipt");
      expect(executeResult.findings).toEqual([]);

      const reconcileResult = (await provider.reconcile!({
        providerRequestId: "int_d1_receipt",
        requestKey: "c".repeat(64),
        operation: "novel_qc",
        promptVersion: "prompt-v1",
        modelPolicyVersion: "policy-v1",
        snapshotId: 9,
        normalizedSha256: "d".repeat(64),
      })) as any;
      expect(reconcileResult.providerRequestId).toBe("int_d1_receipt");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      if (profileId) {
        await db
          .delete(workspaceAiProviderAuditLogs)
          .where(eq(workspaceAiProviderAuditLogs.actorAdminId, admin.id));
        await db
          .delete(workspaceAiProviderState)
          .where(eq(workspaceAiProviderState.id, 1));
        await db
          .delete(workspaceAiProviderProfiles)
          .where(eq(workspaceAiProviderProfiles.id, profileId));
      }
      await db.delete(users).where(eq(users.id, admin.id));
    }
  });
});
