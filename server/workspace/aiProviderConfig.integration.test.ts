import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  users,
  workspaceAiProviderAuditLogs,
  workspaceAiProviderProfiles,
  workspaceAiProviderState,
} from "../../drizzle/schema";
import { createTestUser } from "../test-helpers/fixtures";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import {
  listWorkspaceAiProviderAuditLogsForAdmin,
  listWorkspaceAiProviderProfilesForAdmin,
  resolveManagedWorkspaceAiProviderRuntimeConfig,
  saveWorkspaceAiProviderProfile,
  setActiveWorkspaceAiProvider,
} from "./aiProviderConfig.service";

const SECRET_1 = "d0-integration-secret-alpha-1234";
const SECRET_2 = "d0-integration-secret-rotated-5678";

describe.sequential("IPE-054-D0 admin-managed AI provider persistence", () => {
  it("encrypts, masks, rotates, activates and audits provider configuration", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const admin = await createTestUser({ role: "admin" });
    const ordinaryUser = await createTestUser({ role: "user" });
    let profileId: number | null = null;
    try {
      const created = await saveWorkspaceAiProviderProfile(admin.id, {
        name: `D0 Gemini ${Date.now()}`,
        providerType: "openai_compatible",
        providerName: "gemini",
        apiUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        apiKey: SECRET_1,
        model: "synthetic-gemini-model",
        reconcileUrlTemplate: "https://ai.example.test/receipts/{providerRequestId}",
        timeoutMs: 30000,
        maxInputChars: 200000,
        status: "enabled",
      });
      profileId = created.id;
      expect(created.apiKeyMasked).toBe("••••••••1234");
      expect(JSON.stringify(created)).not.toContain(SECRET_1);
      expect(JSON.stringify(created)).not.toContain("apiKeyCiphertext");

      const stored = (await db.select().from(workspaceAiProviderProfiles)
        .where(eq(workspaceAiProviderProfiles.id, profileId)).limit(1))[0];
      expect(stored.apiKeyCiphertext).not.toContain(SECRET_1);
      expect(stored.apiKeyCiphertext).toMatch(/^v1\./);

      const listBefore = await listWorkspaceAiProviderProfilesForAdmin();
      expect(listBefore.profiles.find((row) => row.id === profileId)?.apiKeyMasked).toBe("••••••••1234");
      expect(JSON.stringify(listBefore)).not.toContain(SECRET_1);
      expect(listBefore.stateRevision).toBe(0);

      const active = await setActiveWorkspaceAiProvider(admin.id, profileId, 0);
      expect(active).toEqual({ activeProfileId: profileId, stateRevision: 1 });
      const runtime1 = await resolveManagedWorkspaceAiProviderRuntimeConfig();
      expect(runtime1).toMatchObject({
        profileId,
        providerType: "openai_compatible",
        apiKey: SECRET_1,
        providerName: "gemini",
      });

      await expect(saveWorkspaceAiProviderProfile(admin.id, {
        ...created,
        expectedRevision: created.revision,
        apiKey: undefined,
        status: "disabled",
      })).rejects.toThrow(/Clear the active provider/i);

      const updated = await saveWorkspaceAiProviderProfile(admin.id, {
        id: profileId,
        expectedRevision: created.revision,
        name: created.name,
        providerType: created.providerType,
        providerName: created.providerName,
        apiUrl: created.apiUrl,
        model: created.model,
        reconcileUrlTemplate: created.reconcileUrlTemplate,
        timeoutMs: created.timeoutMs,
        maxInputChars: created.maxInputChars,
        apiKey: SECRET_2,
        status: "enabled",
      });
      expect(updated.revision).toBe(created.revision + 1);
      expect(updated.apiKeyMasked).toBe("••••••••5678");
      expect(JSON.stringify(updated)).not.toContain(SECRET_2);
      const runtime2 = await resolveManagedWorkspaceAiProviderRuntimeConfig();
      expect(runtime2?.apiKey).toBe(SECRET_2);

      await expect(saveWorkspaceAiProviderProfile(admin.id, {
        id: profileId,
        expectedRevision: created.revision,
        name: created.name,
        providerType: created.providerType,
        providerName: created.providerName,
        apiUrl: created.apiUrl,
        model: created.model,
        status: "enabled",
      })).rejects.toMatchObject({ code: "CONFLICT" });

      await expect(saveWorkspaceAiProviderProfile(ordinaryUser.id, {
        name: `D0 unauthorized ${Date.now()}`,
        providerType: "openai_compatible",
        providerName: "blocked",
        apiUrl: "https://ai.example.test/v1/chat/completions",
        apiKey: "must-not-be-written",
        model: "blocked-model",
        status: "enabled",
      })).rejects.toThrow(/no longer authorized/i);

      const cleared = await setActiveWorkspaceAiProvider(admin.id, null, 1);
      expect(cleared).toEqual({ activeProfileId: null, stateRevision: 2 });
      const disabled = await saveWorkspaceAiProviderProfile(admin.id, {
        id: profileId,
        expectedRevision: updated.revision,
        name: updated.name,
        providerType: updated.providerType,
        providerName: updated.providerName,
        apiUrl: updated.apiUrl,
        model: updated.model,
        reconcileUrlTemplate: updated.reconcileUrlTemplate,
        timeoutMs: updated.timeoutMs,
        maxInputChars: updated.maxInputChars,
        status: "disabled",
      });
      expect(disabled.status).toBe("disabled");

      const audit = await listWorkspaceAiProviderAuditLogsForAdmin(20);
      const related = audit.filter((row) => row.profileId === profileId || row.actorAdminId === admin.id);
      expect(related.some((row) => row.action === "create_profile")).toBe(true);
      expect(related.some((row) => row.action === "set_active_profile")).toBe(true);
      expect(related.some((row) => row.action === "update_profile")).toBe(true);
      expect(related.some((row) => row.action === "clear_active_profile")).toBe(true);
      const auditJson = JSON.stringify(related);
      expect(auditJson).not.toContain(SECRET_1);
      expect(auditJson).not.toContain(SECRET_2);
      expect(auditJson).not.toContain("must-not-be-written");
    } finally {
      await db.delete(workspaceAiProviderAuditLogs).where(eq(workspaceAiProviderAuditLogs.actorAdminId, admin.id));
      await db.delete(workspaceAiProviderState).where(eq(workspaceAiProviderState.id, 1));
      await db.delete(workspaceAiProviderProfiles).where(eq(workspaceAiProviderProfiles.createdByAdminId, admin.id));
      await db.delete(users).where(inArray(users.id, [admin.id, ordinaryUser.id]));
    }
  });
});
