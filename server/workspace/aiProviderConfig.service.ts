import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "../db";
import {
  workspaceAiProviderAuditLogs,
  workspaceAiProviderProfiles,
  workspaceAiProviderState,
  users,
} from "../../drizzle/schema";
import {
  decryptWorkspaceAiProviderSecret,
  encryptWorkspaceAiProviderSecret,
  maskWorkspaceAiProviderSecret,
} from "./aiProviderSecretVault";
import { validateGeminiInteractionsApiUrl } from "./aiQc.geminiInteractions";

const STATE_ID = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_INPUT_CHARS = 200_000;

export class WorkspaceAiProviderConfigError extends Error {
  constructor(
    readonly code: "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "CONFIG_INVALID" | "CONFIG_UNSUPPORTED",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceAiProviderConfigError";
  }
}

export interface WorkspaceAiProviderProfileInput {
  id?: number;
  expectedRevision?: number;
  name: string;
  providerType: string;
  providerName: string;
  apiUrl: string;
  apiKey?: string;
  model: string;
  reconcileUrlTemplate?: string | null;
  timeoutMs?: number;
  maxInputChars?: number;
  status?: "enabled" | "disabled";
}

function text(raw: string, field: string, max: number) {
  const value = raw.trim();
  if (!value || value.length > max) throw new WorkspaceAiProviderConfigError("BAD_REQUEST", `${field} must be 1-${max} characters.`);
  return value;
}
function boundedInt(raw: number | undefined, fallback: number, field: string, max: number) {
  const value = raw ?? fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new WorkspaceAiProviderConfigError("BAD_REQUEST", `${field} is outside the allowed range.`);
  return value;
}
function httpsUrl(raw: string, field: string) {
  const value = text(raw, field, 2048);
  let url: URL;
  try { url = new URL(value); }
  catch { throw new WorkspaceAiProviderConfigError("BAD_REQUEST", `${field} must be an absolute HTTPS URL.`); }
  if (url.protocol !== "https:" || url.username || url.password) throw new WorkspaceAiProviderConfigError("BAD_REQUEST", `${field} must use HTTPS and must not embed credentials.`);
  return url.toString();
}
function reconcileTemplate(raw?: string | null) {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  if (value.length > 2048) throw new WorkspaceAiProviderConfigError("BAD_REQUEST", "reconcileUrlTemplate is too long.");
  const marker = "{providerRequestId}";
  if (value.split(marker).length !== 2) throw new WorkspaceAiProviderConfigError("BAD_REQUEST", "reconcileUrlTemplate must contain {providerRequestId} exactly once.");
  httpsUrl(value.replace(marker, "receipt-probe"), "reconcileUrlTemplate");
  return value;
}
function validateInput(input: WorkspaceAiProviderProfileInput) {
  const providerType = text(input.providerType, "providerType", 80).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(providerType)) throw new WorkspaceAiProviderConfigError("BAD_REQUEST", "providerType must use lowercase letters, digits, underscore, or hyphen.");
  let apiUrl = httpsUrl(input.apiUrl, "apiUrl");
  let reconcileUrlTemplate = reconcileTemplate(input.reconcileUrlTemplate);
  if (providerType === "gemini_interactions") {
    if (reconcileUrlTemplate) throw new WorkspaceAiProviderConfigError("BAD_REQUEST", "Gemini Interactions reconciliation URL is derived automatically and must not be overridden.");
    try { apiUrl = validateGeminiInteractionsApiUrl(apiUrl); }
    catch { throw new WorkspaceAiProviderConfigError("BAD_REQUEST", "Gemini Interactions must use the official Google /v1 or /v1beta interactions endpoint."); }
    reconcileUrlTemplate = null;
  }
  return {
    name: text(input.name, "name", 160),
    providerType,
    providerName: text(input.providerName, "providerName", 120),
    apiUrl,
    model: text(input.model, "model", 160),
    reconcileUrlTemplate,
    timeoutMs: boundedInt(input.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", 120_000),
    maxInputChars: boundedInt(input.maxInputChars, DEFAULT_MAX_INPUT_CHARS, "maxInputChars", 1_000_000),
    status: input.status ?? "enabled" as const,
  };
}
function safeProfile(row: typeof workspaceAiProviderProfiles.$inferSelect, apiKeyMasked: string) {
  return {
    id: row.id,
    name: row.name,
    providerType: row.providerType,
    providerName: row.providerName,
    apiUrl: row.apiUrl,
    model: row.model,
    reconcileUrlTemplate: row.reconcileUrlTemplate,
    timeoutMs: row.timeoutMs,
    maxInputChars: row.maxInputChars,
    status: row.status,
    revision: row.revision,
    apiKeyConfigured: true,
    apiKeyMasked,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function safeAuditMetadata(value: Record<string, unknown>) { return JSON.stringify(value); }

async function assertActorIsAdmin(tx: any, actorAdminId: number) {
  const actor = (await tx.select({ id: users.id, role: users.role }).from(users)
    .where(eq(users.id, actorAdminId)).limit(1).for("update"))[0];
  if (!actor || actor.role !== "admin") {
    throw new WorkspaceAiProviderConfigError("FORBIDDEN", "Acting admin session is no longer authorized.");
  }
}

export async function listWorkspaceAiProviderProfilesForAdmin() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [profiles, stateRows] = await Promise.all([
    db.select().from(workspaceAiProviderProfiles).orderBy(workspaceAiProviderProfiles.name),
    db.select().from(workspaceAiProviderState).where(eq(workspaceAiProviderState.id, STATE_ID)).limit(1),
  ]);
  return {
    profiles: profiles.map(row => safeProfile(row, maskWorkspaceAiProviderSecret(decryptWorkspaceAiProviderSecret(row.apiKeyCiphertext, row.secretContext)))),
    activeProfileId: stateRows[0]?.activeProfileId ?? null,
    stateRevision: stateRows[0]?.revision ?? 0,
  };
}

export async function saveWorkspaceAiProviderProfile(actorAdminId: number, input: WorkspaceAiProviderProfileInput) {
  const data = validateInput(input);
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async (tx: any) => {
    await assertActorIsAdmin(tx, actorAdminId);
    if (!input.id) {
      if (!input.apiKey?.trim()) throw new WorkspaceAiProviderConfigError("BAD_REQUEST", "apiKey is required when creating a provider profile.");
      const secretContext = randomUUID();
      const apiKeyCiphertext = encryptWorkspaceAiProviderSecret(input.apiKey, secretContext);
      const inserted = await tx.insert(workspaceAiProviderProfiles).values({
        ...data,
        secretContext,
        apiKeyCiphertext,
        createdByAdminId: actorAdminId,
        updatedByAdminId: actorAdminId,
      });
      const id = Number(inserted[0]?.insertId ?? inserted.insertId);
      await tx.insert(workspaceAiProviderAuditLogs).values({
        actorAdminId,
        action: "create_profile",
        profileId: id,
        safeMetadataJson: safeAuditMetadata({ providerType: data.providerType, status: data.status }),
      });
      const rows = await tx.select().from(workspaceAiProviderProfiles).where(eq(workspaceAiProviderProfiles.id, id)).limit(1);
      return safeProfile(rows[0], maskWorkspaceAiProviderSecret(input.apiKey));
    }

    if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision ?? 0) <= 0) throw new WorkspaceAiProviderConfigError("BAD_REQUEST", "expectedRevision is required when updating a provider profile.");
    const expectedRevision = input.expectedRevision as number;
    const activeState = (await tx.select({ activeProfileId: workspaceAiProviderState.activeProfileId }).from(workspaceAiProviderState)
      .where(eq(workspaceAiProviderState.id, STATE_ID)).limit(1).for("update"))[0];
    const rows = await tx.select().from(workspaceAiProviderProfiles).where(eq(workspaceAiProviderProfiles.id, input.id)).limit(1).for("update");
    const current = rows[0];
    if (!current) throw new WorkspaceAiProviderConfigError("NOT_FOUND", "Provider profile not found.");
    if (current.revision !== expectedRevision) throw new WorkspaceAiProviderConfigError("CONFLICT", "Provider profile changed; reload before saving again.");
    if (activeState?.activeProfileId === input.id && data.status === "disabled") throw new WorkspaceAiProviderConfigError("BAD_REQUEST", "Clear the active provider before disabling this profile.");
    const apiKeyCiphertext = input.apiKey?.trim()
      ? encryptWorkspaceAiProviderSecret(input.apiKey, current.secretContext)
      : current.apiKeyCiphertext;
    const result = await tx.update(workspaceAiProviderProfiles).set({
      ...data,
      apiKeyCiphertext,
      updatedByAdminId: actorAdminId,
      revision: sql`${workspaceAiProviderProfiles.revision} + 1`,
    }).where(and(eq(workspaceAiProviderProfiles.id, input.id), eq(workspaceAiProviderProfiles.revision, expectedRevision)));
    if ((result[0]?.affectedRows ?? result.affectedRows ?? 0) !== 1) throw new WorkspaceAiProviderConfigError("CONFLICT", "Provider profile changed; reload before saving again.");
    await tx.insert(workspaceAiProviderAuditLogs).values({
      actorAdminId,
      action: "update_profile",
      profileId: input.id,
      safeMetadataJson: safeAuditMetadata({ providerType: data.providerType, status: data.status, apiKeyRotated: Boolean(input.apiKey?.trim()) }),
    });
    const updated = (await tx.select().from(workspaceAiProviderProfiles).where(eq(workspaceAiProviderProfiles.id, input.id)).limit(1))[0];
    const masked = maskWorkspaceAiProviderSecret(input.apiKey?.trim() || decryptWorkspaceAiProviderSecret(updated.apiKeyCiphertext, updated.secretContext));
    return safeProfile(updated, masked);
  });
}

export async function setActiveWorkspaceAiProvider(actorAdminId: number, profileId: number | null, expectedStateRevision: number) {
  if (!Number.isSafeInteger(expectedStateRevision) || expectedStateRevision < 0) throw new WorkspaceAiProviderConfigError("BAD_REQUEST", "expectedStateRevision is invalid.");
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async (tx: any) => {
    await assertActorIsAdmin(tx, actorAdminId);
    const stateRows = await tx.select().from(workspaceAiProviderState).where(eq(workspaceAiProviderState.id, STATE_ID)).limit(1).for("update");
    const current = stateRows[0];
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== expectedStateRevision) throw new WorkspaceAiProviderConfigError("CONFLICT", "Active provider selection changed; reload before saving again.");
    if (profileId !== null) {
      const profile = (await tx.select({ id: workspaceAiProviderProfiles.id, status: workspaceAiProviderProfiles.status }).from(workspaceAiProviderProfiles).where(eq(workspaceAiProviderProfiles.id, profileId)).limit(1).for("update"))[0];
      if (!profile) throw new WorkspaceAiProviderConfigError("NOT_FOUND", "Provider profile not found.");
      if (profile.status !== "enabled") throw new WorkspaceAiProviderConfigError("BAD_REQUEST", "A disabled provider profile cannot be activated.");
    }
    const nextRevision = currentRevision + 1;
    if (current) {
      await tx.update(workspaceAiProviderState).set({ activeProfileId: profileId, updatedByAdminId: actorAdminId, revision: nextRevision }).where(eq(workspaceAiProviderState.id, STATE_ID));
    } else {
      await tx.insert(workspaceAiProviderState).values({ id: STATE_ID, activeProfileId: profileId, updatedByAdminId: actorAdminId, revision: nextRevision });
    }
    await tx.insert(workspaceAiProviderAuditLogs).values({
      actorAdminId,
      action: profileId === null ? "clear_active_profile" : "set_active_profile",
      profileId,
      safeMetadataJson: safeAuditMetadata({ stateRevision: nextRevision }),
    });
    return { activeProfileId: profileId, stateRevision: nextRevision };
  });
}

export async function listWorkspaceAiProviderAuditLogsForAdmin(limit = 50) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 200);
  return db.select({
    id: workspaceAiProviderAuditLogs.id,
    actorAdminId: workspaceAiProviderAuditLogs.actorAdminId,
    action: workspaceAiProviderAuditLogs.action,
    profileId: workspaceAiProviderAuditLogs.profileId,
    safeMetadataJson: workspaceAiProviderAuditLogs.safeMetadataJson,
    createdAt: workspaceAiProviderAuditLogs.createdAt,
  }).from(workspaceAiProviderAuditLogs).orderBy(desc(workspaceAiProviderAuditLogs.id)).limit(bounded);
}

export async function resolveManagedWorkspaceAiProviderRuntimeConfig() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select({ profile: workspaceAiProviderProfiles }).from(workspaceAiProviderState)
    .innerJoin(workspaceAiProviderProfiles, eq(workspaceAiProviderState.activeProfileId, workspaceAiProviderProfiles.id))
    .where(eq(workspaceAiProviderState.id, STATE_ID)).limit(1);
  const row = rows[0]?.profile;
  if (!row) return null;
  if (row.status !== "enabled") throw new WorkspaceAiProviderConfigError("CONFIG_INVALID", "Active AI provider profile is disabled.");
  const apiKey = decryptWorkspaceAiProviderSecret(row.apiKeyCiphertext, row.secretContext);
  return {
    profileId: row.id,
    profileRevision: row.revision,
    providerType: row.providerType,
    enabled: true as const,
    apiUrl: row.apiUrl,
    apiKey,
    model: row.model,
    providerName: row.providerName,
    timeoutMs: row.timeoutMs,
    maxInputChars: row.maxInputChars,
    reconcileUrlTemplate: row.reconcileUrlTemplate,
  };
}
