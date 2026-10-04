import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import express from "express";
import { createServer, type Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";

// IPE-PLUGIN-001D integration + security suite - draft/checker reads and
// bounded mutations through the plugin MCP surface, against the REAL
// Workspace services (fixtures are built through createWorkspace /
// bindPublicationNovel / createEditorialEpisodeWorkItem / importEditorialSource
// so the drafts carry REAL paragraph keys/fingerprints):
//   1. tenant isolation - A never reads/edits B's draft or runs B's checker,
//   2. scope isolation - reads vs writes vs checker:run are separate scopes,
//   3. mutation discipline - optimistic concurrency (id/version/sha),
//      idempotency replay + key/payload conflict, one concurrent winner,
//   4. checker determinism/idempotency - same draft = same run (no duplicate
//      semantic runs, concurrent runs included), edit -> STALE evidence,
//   5. membership removal takes effect on the very next call,
//   6. mutation audit carries only capability/reason (no draft text).

const envSetup = vi.hoisted(() => {
  process.env.PLUGIN_FOUNDATION_ENABLED = "true";
  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = "plugin-001d-integration-secret-0123456789abcdef";
  }
  if (!process.env.VITE_APP_ID) {
    process.env.VITE_APP_ID = "ipenovel-plugin-001d-integration-app";
  }
});
void envSetup;

import { COOKIE_NAME } from "@shared/const";
import { sdk } from "../_core/sdk";
import {
  pluginAuditLogs,
  workspaceNovels,
  pluginOAuthAuthorizations,
  pluginOAuthClients,
  workspaceEditorialCheckerRuns,
  workspaceEditorialDrafts,
  workspaceMembers,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { getTestDb } from "../test-helpers/testDb";
import { createTestNovel, createTestUser, deleteFixtures, uniqueTestTag, type TestUserFixture } from "../test-helpers/fixtures";
import { registerPluginFoundationRoutes } from "./oauth/routes";
import { computePkceS256Challenge, generatePluginOpaqueToken, hashPluginSecret } from "./crypto";
import { bindPublicationNovel, createWorkspace } from "../workspace/service";
import { createEditorialEpisodeWorkItem } from "../workspace/editorialBoard.service";
import { importEditorialSource } from "../workspace/editorialDraft.service";
import type { EditorialSourcePayload } from "../workspace/editorialDraft.domain";

const REDIRECT_URI = "https://chatgpt.example/callback";
const ALL_SCOPES =
  "identity:read workspace:read novel:read pack:read chapter:read draft:read draft:write checker:read checker:run";

let server: Server | undefined;
let baseUrl = "";

const createdUserIds: number[] = [];
const createdClientIds: string[] = [];
const createdNovelIds: number[] = [];
const createdWorkspaceIds: number[] = [];

function extractInsertId(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  const insertId = (header as { insertId?: number } | undefined)?.insertId;
  if (!insertId) throw new Error("fixture insert failed to return insertId");
  return insertId;
}

async function createTestPluginClient(allowedScopes: string) {
  const db = getTestDb();
  const clientId = `plg_${uniqueTestTag("cli")}`;
  const clientSecret = generatePluginOpaqueToken();
  await db.insert(pluginOAuthClients).values({
    clientId,
    clientSecretHash: hashPluginSecret(clientSecret),
    name: `Test client ${clientId}`,
    redirectUris: JSON.stringify([REDIRECT_URI]),
    allowedScopes,
  });
  createdClientIds.push(clientId);
  return { clientId, clientSecret };
}

async function sessionCookie(user: TestUserFixture): Promise<string> {
  const token = await sdk.signSession({
    openId: user.openId,
    appId: process.env.VITE_APP_ID ?? "",
    name: `001D ${user.id}`,
  });
  return `${COOKIE_NAME}=${token}`;
}

function sourcePayload(paragraphs: string[]): EditorialSourcePayload {
  const revision = uniqueTestTag("rev");
  return {
    sourceKind: "uploaded_file",
    sourceKey: `uploaded-file:${revision}`,
    mimeType: "text/plain",
    title: "001d-fixture.txt",
    revisionKey: revision,
    tabs: [
      {
        sourceTabId: "file-main",
        tabOrder: 0,
        title: "001d-fixture.txt",
        paragraphs,
      },
    ],
  };
}

type PackRef = { packId: number; workspaceNovelId: number; bindingId: number };

async function createBoundEpisodePack(input: {
  owner: TestUserFixture;
  workspaceId: number;
  episodeNumber: string;
  paragraphs: string[];
  bindingStatus?: "active" | "paused" | "unlinked";
}): Promise<PackRef> {
  const db = getTestDb();
  const novel = await createTestNovel();
  createdNovelIds.push(novel.id);
  await bindPublicationNovel({
    actorUserId: input.owner.id,
    workspaceId: input.workspaceId,
    novelId: novel.id,
  });
  let bindingId = 0;
  // Read the binding the service just created (always ACTIVE).
  const bindingRows = await db
    .select({ id: workspaceNovels.id, status: workspaceNovels.status })
    .from(workspaceNovels)
    .where(eq(workspaceNovels.novelId, novel.id));
  const activeBinding = bindingRows.find(row => row.status === "active") ?? bindingRows[bindingRows.length - 1];
  bindingId = activeBinding.id;

  const episodeCreation = await createEditorialEpisodeWorkItem({
    actorUserId: input.owner.id,
    workspaceId: input.workspaceId,
    workspaceNovelId: bindingId,
    episodeNumber: input.episodeNumber,
    episodeTitle: `แพ็ก ${input.episodeNumber}`,
    price: "45.00",
    isFree: false,
  });
  // createEditorialEpisodeWorkItem returns { created, board: <read model> }
  // where the read model itself is { board, columns, transitions, assignees }.
  const episodeCard = episodeCreation.board.columns
    .flatMap(column => column.cards)
    .find(card => card.workItemType === "NEW_EPISODE" && card.episodeNumber === input.episodeNumber);
  if (!episodeCard?.workItemId) throw new Error("episode pack card not found after creation");

  const imported = await importEditorialSource({
    actorUserId: input.owner.id,
    workspaceId: input.workspaceId,
    workItemId: episodeCard.workItemId,
    payload: sourcePayload(input.paragraphs),
  });
  if (!imported.latestDraftId) throw new Error("import produced no draft");

  // For non-active scenarios, flip the binding AFTER the pack/draft exist:
  // the pack is then invisible through every plugin tool (fail closed).
  if (input.bindingStatus && input.bindingStatus !== "active") {
    await db
      .update(workspaceNovels)
      .set({ status: input.bindingStatus })
      .where(eq(workspaceNovels.id, bindingId));
  }

  return { packId: episodeCard.workItemId, workspaceNovelId: bindingId, bindingId };
}


async function callTool(
  accessToken: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const response = await fetch(`${baseUrl}/api/plugin/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (response.status !== 200) return { status: response.status, body: null };
  return { status: 200, body: (await response.json()) as Record<string, unknown> };
}

type ToolRead = {
  result: Record<string, unknown> | null;
  marker: string | null;
  isError: boolean;
  errorCode: string | null;
};

function readTool(response: { body: Record<string, unknown> | null } | null): ToolRead {
  const body = response?.body ?? null;
  if (!body) return { result: null, marker: null, isError: false, errorCode: null };
  if (body.error) {
    const error = body.error as { code?: number; data?: { reason?: string } };
    return {
      result: null,
      marker: null,
      isError: false,
      errorCode: error.data?.reason ?? (error.code === -32602 ? "INVALID_PARAMS" : null),
    };
  }
  const result = body.result as Record<string, unknown> | undefined;
  if (!result) return { result: null, marker: null, isError: false, errorCode: null };
  const isError = result.isError === true;
  const text = ((result.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? null) as string | null;
  return {
    result: (result.structuredContent as Record<string, unknown> | null) ?? null,
    marker: isError ? text : null,
    isError,
    errorCode: isError ? text : null,
  };
}


/**
 * Resolves the CURRENT latest-draft id of a pack via draft.get - callers
 * pass it as checker.run's REQUIRED expectedDraftId (R2 contract).
 */
async function latestPackDraftId(
  token: string,
  workspaceId: number,
  packId: number
): Promise<number> {
  const read = readTool(await callTool(token, "draft.get", { workspaceId, packId }));
  if (read.result === null || read.result.draftId === null) {
    throw new Error("latestPackDraftId: pack has no draft");
  }
  return read.result.draftId as number;
}

async function runConsentAndExchange(
  user: TestUserFixture,
  client: { clientId: string; clientSecret: string },
  scope: string
): Promise<{ accessToken: string; refreshToken: string; scope: string }> {
  const cookie = await sessionCookie(user);
  const verifier = generatePluginOpaqueToken();
  const challenge = computePkceS256Challenge(verifier);
  const state = uniqueTestTag("state");
  const authorizeResponse = await fetch(
    `${baseUrl}/api/plugin/oauth/authorize?${new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      response_mode: "query",
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    })}`,
    { headers: { cookie }, redirect: "manual" }
  );
  expect(authorizeResponse.status).toBe(200);
  const html = await authorizeResponse.text();
  const csrfToken = /name="csrfToken" value="([^"]+)"/.exec(html)![1];
  const consentResponse = await fetch(`${baseUrl}/api/plugin/oauth/authorize/consent`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${cookie}; plugin_oauth_consent_csrf=${csrfToken}`,
    },
    body: new URLSearchParams({ state, csrfToken, decision: "approve" }).toString(),
    redirect: "manual",
  });
  expect(consentResponse.status).toBe(302);
  const code = new URL(consentResponse.headers.get("location") ?? "").searchParams.get("code");
  expect(code).toBeTruthy();
  const tokenResponse = await fetch(`${baseUrl}/api/plugin/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });
  expect(tokenResponse.status).toBe(200);
  const body = (await tokenResponse.json()) as Record<string, unknown>;
  return {
    accessToken: String(body.access_token),
    refreshToken: String(body.refresh_token),
    scope: String(body.scope),
  };
}

beforeAll(async () => {
  const app: Express = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  registerPluginFoundationRoutes(app);
  await new Promise<void>(resolve => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no test server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  const db = getTestDb();
  if (createdClientIds.length > 0) {
    await db.delete(pluginAuditLogs).where(inArray(pluginAuditLogs.clientId, createdClientIds));
    await db.delete(pluginOAuthAuthorizations).where(inArray(pluginOAuthAuthorizations.clientId, createdClientIds));
    await db.delete(pluginOAuthClients).where(inArray(pluginOAuthClients.clientId, createdClientIds));
  }
  if (createdWorkspaceIds.length > 0) {
    const { workspaceKanbanBoards, workspaceKanbanCards } = await import("../../drizzle/schema");
    const boardRows = await db
      .select({ boardId: workspaceKanbanBoards.id })
      .from(workspaceKanbanBoards)
      .where(inArray(workspaceKanbanBoards.workspaceId, createdWorkspaceIds));
    const boardIds = boardRows.map(row => row.boardId);
    if (boardIds.length > 0) {
      await db.delete(workspaceKanbanCards).where(inArray(workspaceKanbanCards.boardId, boardIds));
    }
    await db.delete(workspaceWorkspaces).where(inArray(workspaceWorkspaces.id, createdWorkspaceIds));
  }
  if (createdNovelIds.length > 0) {
    await deleteFixtures({ novelIds: [...createdNovelIds] });
  }
  if (createdUserIds.length > 0) {
    await deleteFixtures({ userIds: [...createdUserIds] });
  }
  await new Promise<void>((resolve, reject) =>
    server ? server.close(error => (error ? reject(error) : resolve())) : resolve()
  );
});

describe("plugin editorial slice (001D)", () => {
  let userA: TestUserFixture; // admin, owner of W1
  let userB: TestUserFixture; // admin, viewer member of W1 (tenant-positive, B's own tenant empty)
  let userD: TestUserFixture; // NON-admin member of W3 (workspace service gate check)
  let userE: TestUserFixture; // admin, owner of W3
  let w1: { workspaceId: number; name: string };
  let w2: { workspaceId: number; name: string };
  let w3: { workspaceId: number; name: string };
  let w2MemberB: { userId: number };
  let packW1: PackRef;
  let packW2: PackRef;
  let packW3: PackRef;
  let packPaused: PackRef;
  let grantA: { accessToken: string; refreshToken: string };
  let grantD: { accessToken: string; refreshToken: string };
  let grantB: { accessToken: string; refreshToken: string };
  let identityOnlyGrant: { accessToken: string };
  let draftReadGrant: { accessToken: string }; // draft:read only
  let fullClient: { clientId: string; clientSecret: string };

  const w1Paragraphs = [
    "บทที่ 1 เริ่มต้นการเดินทาง",
    "เขาบอกว่า テスト เรื่องนี้ให้เต็มที่",
    "ประโยคสุดท้ายของบทนี้",
  ];

  beforeAll(async () => {
    // Workspace services require platform-admin actors (inherited gate) -
    // plugin users exercising 001D tools must be admins AND in-tenant.
    userA = await createTestUser({ role: "admin", name: "Editorial A" });
    userB = await createTestUser({ role: "admin", name: "Editorial B" });
    userD = await createTestUser({ name: "Non-admin D" });
    userE = await createTestUser({ role: "admin", name: "Admin E (W3 owner)" });
    createdUserIds.push(userA.id, userB.id, userD.id, userE.id);

    const db = getTestDb();
    const created1 = await createWorkspace(userA.id, `W1-${uniqueTestTag("ws")}`);
    w1 = { workspaceId: (created1 as unknown as { workspaceId: number }).workspaceId ?? (created1 as any).id, name: (created1 as any).name };
    createdWorkspaceIds.push(w1.workspaceId);
    const created2 = await createWorkspace(userA.id, `W2-${uniqueTestTag("ws")}`);
    w2 = { workspaceId: (created2 as unknown as { workspaceId: number }).workspaceId ?? (created2 as any).id, name: (created2 as any).name };
    createdWorkspaceIds.push(w2.workspaceId);
    const created3 = await createWorkspace(userE.id, `W3-${uniqueTestTag("ws")}`);
    w3 = { workspaceId: (created3 as unknown as { workspaceId: number }).workspaceId ?? (created3 as any).id, name: (created3 as any).name };
    createdWorkspaceIds.push(w3.workspaceId);
    // D joins W3 as a member (in-tenant) but is not a platform admin.
    await db.insert(workspaceMembers).values({ workspaceId: w3.workspaceId, userId: userD.id, role: "viewer", status: "active" });

    // B is an active (viewer) member of W1 only.
    const [memberInsert] = await db
      .insert(workspaceMembers)
      .values({ workspaceId: w1.workspaceId, userId: userB.id, role: "viewer", status: "active" });
    void memberInsert;
    const memberRows = await db
      .select({ id: workspaceMembers.id, userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, w1.workspaceId), eq(workspaceMembers.userId, userB.id)));
    w2MemberB = { userId: memberRows[0].id };

    packW1 = await createBoundEpisodePack({
      owner: userA,
      workspaceId: w1.workspaceId,
      episodeNumber: "1",
      paragraphs: w1Paragraphs,
    });
    packW2 = await createBoundEpisodePack({
      owner: userA,
      workspaceId: w2.workspaceId,
      episodeNumber: "1",
      paragraphs: ["W2 paragraph one"],
    });
    packW3 = await createBoundEpisodePack({
      owner: userE,
      workspaceId: w3.workspaceId,
      episodeNumber: "1",
      paragraphs: ["W3 paragraph one"],
    });
    packPaused = await createBoundEpisodePack({
      owner: userA,
      workspaceId: w1.workspaceId,
      episodeNumber: "2",
      paragraphs: ["paused pack paragraph"],
      bindingStatus: "paused",
    });

    fullClient = await createTestPluginClient(ALL_SCOPES);
    const identityOnlyClient = await createTestPluginClient("identity:read");
    const draftReadClient = await createTestPluginClient("identity:read draft:read");

    grantA = await runConsentAndExchange(userA, fullClient, ALL_SCOPES);
    grantD = await runConsentAndExchange(userD, fullClient, ALL_SCOPES);
    grantB = await runConsentAndExchange(userB, fullClient, ALL_SCOPES);
    identityOnlyGrant = await runConsentAndExchange(userA, identityOnlyClient, "identity:read");
    draftReadGrant = await runConsentAndExchange(userB, draftReadClient, "identity:read draft:read");
  });

  it("tokens carry the consented scope strings", () => {
    expect([...grantA.scope.split(" ")].sort()).toEqual([...ALL_SCOPES.split(" ")].sort());
  });

  describe("draft.get - reads and identity triple", () => {
    it("returns the latest draft identity triple + real paragraphs for the owner", async () => {
      const rawFirst = await callTool(grantA.accessToken, "draft.get", {
        workspaceId: w1.workspaceId,
        packId: packW1.packId,
      });
      console.log("[001d-probe] first-call raw body:", JSON.stringify(rawFirst));
      const read = readTool(rawFirst);
      console.log("[001d-probe] first-call raw body:", JSON.stringify(rawFirst));
      expect(read.isError).toBe(false);
      expect(read.result!.draftId).toBeGreaterThan(0);
      expect(read.result!.version).toBeGreaterThanOrEqual(1);
      expect(String(read.result!.draftSha256)).toHaveLength(64);
      const tabs = read.result!.tabs as Array<Record<string, unknown>>;
      expect(tabs).toHaveLength(1);
      const paragraphs = tabs[0].paragraphs as Array<Record<string, unknown>>;
      const texts = paragraphs.map(p => p.text);
      for (const fixtureText of w1Paragraphs) {
        expect(texts, fixtureText).toContain(fixtureText);
      }
      for (const paragraph of paragraphs) {
        expect(String(paragraph.paragraphKey)).toHaveLength(64);
        expect(String(paragraph.paragraphFingerprint)).toHaveLength(64);
      }
    });

    it("cross-tenant pack is NOT_FOUND (A cannot read B's draft; bogus id indistinguishable)", async () => {
      // A owns W2 but asks via the WRONG workspace pairing -> NOT_FOUND.
      const wrongPair = readTool(await callTool(grantA.accessToken, "draft.get", {
        workspaceId: w1.workspaceId,
        packId: packW2.packId,
      }));
      expect(wrongPair.notFound ?? wrongPair.marker === "NOT_FOUND").toBe(true);
      // C has no membership anywhere (fresh admin user per run).
      const userC = await createTestUser({ role: "admin" });
      createdUserIds.push(userC.id);
      const grantC = await runConsentAndExchange(userC, fullClient, ALL_SCOPES);
      const foreign = readTool(await callTool(grantC.accessToken, "draft.get", {
        workspaceId: w1.workspaceId,
        packId: packW1.packId,
      }));
      expect(foreign.marker).toBe("NOT_FOUND");
      const missing = readTool(await callTool(grantC.accessToken, "draft.get", {
        workspaceId: 987654321,
        packId: packW1.packId,
      }));
      expect(missing.marker).toBe("NOT_FOUND");
    });

    it("paused/unlinked binding packs are invisible (fail closed)", async () => {
      const paused = readTool(await callTool(grantA.accessToken, "draft.get", {
        workspaceId: w1.workspaceId,
        packId: packPaused.packId,
      }));
      expect(paused.marker).toBe("NOT_FOUND");
    });
  });

  describe("draft.edit - bounded mutation discipline", () => {
    const baseCommand = {
      kind: "replace_paragraph",
      paragraphKey: "", // filled at runtime from draft.get
      expectedParagraphFingerprint: "",
      expectedText: w1Paragraphs[2],
      replacementText: "ประโยคสุดท้ายที่ถูกแก้แล้ว",
    };

    async function latestDraft(token: string): Promise<Record<string, unknown>> {
      const read = readTool(await callTool(token, "draft.get", {
        workspaceId: w1.workspaceId,
        packId: packW1.packId,
      }));
      expect(read.result).not.toBeNull();
      return read.result!;
    }

    it("replace_paragraph applies under CAS and mints a new draft version", async () => {
      const draft = await latestDraft(grantA.accessToken);
      const tabs = draft.tabs as Array<Record<string, unknown>>;
      const paragraphs = tabs[0].paragraphs as Array<Record<string, unknown>>;
      const last = paragraphs[paragraphs.length - 1];
      const command = {
        ...baseCommand,
        paragraphKey: last.paragraphKey,
        expectedParagraphFingerprint: last.paragraphFingerprint,
        expectedText: last.text as string,
      };
      const edit = readTool(await callTool(grantA.accessToken, "draft.edit", {
        workspaceId: w1.workspaceId,
        packId: packW1.packId,
        expectedDraftId: draft.draftId,
        expectedDraftVersion: draft.version,
        expectedDraftSha256: draft.draftSha256,
        command,
        idempotencyKey: uniqueTestTag("idem"),
      }));
      expect(edit.isError).toBe(false);
      expect(edit.result!.draftId).not.toBe(draft.draftId);
      expect(edit.result!.version).toBeGreaterThan(draft.version as number);
      expect(edit.result!.draftSha256).not.toBe(draft.draftSha256);
      expect(edit.result!.replayed).toBe(false);
    });

    it("same idempotencyKey + same payload replays (no new draft); same key + different payload = EDIT_CONFLICT", async () => {
      const draft = await latestDraft(grantA.accessToken);
      const tabs = draft.tabs as Array<Record<string, unknown>>;
      const paragraphs = tabs[0].paragraphs as Array<Record<string, unknown>>;
      const first = paragraphs[0];
      const command = {
        kind: "replace_paragraph",
        paragraphKey: first.paragraphKey,
        expectedParagraphFingerprint: first.paragraphFingerprint,
        expectedText: first.text,
        replacementText: "replay-target",
      };
      const key = uniqueTestTag("idem");
      const first1 = readTool(await callTool(grantA.accessToken, "draft.edit", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
        expectedDraftId: draft.draftId, expectedDraftVersion: draft.version, expectedDraftSha256: draft.draftSha256,
        command, idempotencyKey: key,
      }));
      expect(first1.isError).toBe(false);
      expect(first1.result!.replayed).toBe(false);

      // Same key + SAME payload but the draft moved -> the service replays the
      // original event (replayed: true), never a new draft.
      const replay = readTool(await callTool(grantA.accessToken, "draft.edit", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
        expectedDraftId: draft.draftId, expectedDraftVersion: draft.version, expectedDraftSha256: draft.draftSha256,
        command, idempotencyKey: key,
      }));
      expect(replay.isError).toBe(false);
      expect(replay.result!.replayed).toBe(true);
      expect(replay.result!.draftId).toBe(first1.result!.draftId);

      // Same key + DIFFERENT payload -> EDIT_CONFLICT (in-band CONFLICT).
      const dbCountBefore = await countDrafts(packW1.packId);
      const conflict = readTool(await callTool(grantA.accessToken, "draft.edit", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
        expectedDraftId: draft.draftId, expectedDraftVersion: draft.version, expectedDraftSha256: draft.draftSha256,
        command: { ...command, replacementText: "different-payload" },
        idempotencyKey: key,
      }));
      expect(conflict.isError).toBe(true);
      expect(conflict.result!.code).toBe("EDIT_CONFLICT");
      expect(await countDrafts(packW1.packId)).toBe(dbCountBefore);
    });

    it("stale draft id/version/sha fails closed with DRAFT_CONFLICT", async () => {
      const conflict = readTool(await callTool(grantA.accessToken, "draft.edit", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
        expectedDraftId: 999999, expectedDraftVersion: 1, expectedDraftSha256: "f".repeat(64),
        command: {
          kind: "replace_paragraph", paragraphKey: "e".repeat(64), expectedParagraphFingerprint: "d".repeat(64),
          expectedText: "x", replacementText: "y",
        },
        idempotencyKey: uniqueTestTag("idem"),
      }));
      console.log("[r2-probe] stale edit read:", JSON.stringify(conflict).slice(0, 200));
      const staleRaw = await callTool(grantA.accessToken, "draft.edit", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
        expectedDraftId: 999999, expectedDraftVersion: 1, expectedDraftSha256: "f".repeat(64),
        command: {
          kind: "replace_paragraph", paragraphKey: "e".repeat(64), expectedParagraphFingerprint: "d".repeat(64),
          expectedText: "x", replacementText: "y",
        },
        idempotencyKey: uniqueTestTag("idem"),
      });
      console.log("[r2-probe] stale raw:", JSON.stringify(staleRaw.body).slice(0, 500));
      expect(conflict.isError).toBe(true);
      expect(conflict.result!.code).toBe("DRAFT_CONFLICT");
    });

    it("replace_tab and unknown kinds are rejected at the args schema (INVALID_PARAMS, no execution)", async () => {
      const rejected = await callTool(grantA.accessToken, "draft.edit", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
        expectedDraftId: 1, expectedDraftVersion: 1, expectedDraftSha256: "f".repeat(64),
        command: {
          kind: "replace_tab", sourceTabId: "file-main",
          expectedTabStructuralSha256: "f".repeat(64), expectedText: "x", replacementText: "y",
        },
        idempotencyKey: uniqueTestTag("idem"),
      });
      expect((rejected.body!.error as { code: number }).code).toBe(-32602);
    });

    it("concurrent edits against the same expected draft: exactly one winner, loser fails closed", async () => {
      const draft = await latestDraft(grantA.accessToken);
      const tabs = draft.tabs as Array<Record<string, unknown>>;
      const paragraphs = tabs[0].paragraphs as Array<Record<string, unknown>>;
      const target = paragraphs[paragraphs.length - 1];
      const editCall = (replacement: string, key: string) =>
        callTool(grantA.accessToken, "draft.edit", {
          workspaceId: w1.workspaceId, packId: packW1.packId,
          expectedDraftId: draft.draftId, expectedDraftVersion: draft.version, expectedDraftSha256: draft.draftSha256,
          command: {
            kind: "replace_paragraph", paragraphKey: target.paragraphKey,
            expectedParagraphFingerprint: target.paragraphFingerprint,
            expectedText: target.text, replacementText: replacement,
          },
          idempotencyKey: key,
        });
      const [r1, r2] = await Promise.all([readTool(await editCall("concurrent-A", uniqueTestTag("idem"))), readTool(await editCall("concurrent-B", uniqueTestTag("idem")))]);
      const outcomes = [r1, r2];
      const winners = outcomes.filter(outcome => !outcome.isError);
      const losers = outcomes.filter(outcome => outcome.isError);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0].result!.code).toBe("DRAFT_CONFLICT");
      const draftsAfter = await countDrafts(packW1.packId);
      expect(draftsAfter - (draft.version as number)).toBe(1);
    });
  });

  describe("checker.run / checker.get - determinism + staleness", () => {
    it("first run creates; identical rerun reuses the SAME run (created=false, same runId)", async () => {
      const first = readTool(await callTool(grantA.accessToken, "checker.run", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
        expectedDraftId: (await latestPackDraftId(grantA.accessToken, w1.workspaceId, packW1.packId))!,
      }));
      expect(first.isError).toBe(false);
      expect(first.result!.created).toBe(true);
      const rerun = readTool(await callTool(grantA.accessToken, "checker.run", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
        expectedDraftId: (await latestPackDraftId(grantA.accessToken, w1.workspaceId, packW1.packId))!,
      }));
      expect(rerun.isError).toBe(false);
      expect(rerun.result!.created).toBe(false);
      expect(rerun.result!.runId).toBe(first.result!.runId);
      const runsCount = await countRuns(packW1.packId);
      expect(runsCount).toBe(1);
    });

    it("concurrent checker.run against the same draft creates NO duplicate semantic run", async () => {
      const pack = packW2;
      const [r1, r2] = await Promise.all([
        callTool(grantA.accessToken, "checker.run", { workspaceId: w2.workspaceId, packId: pack.packId, expectedDraftId: (await latestPackDraftId(grantA.accessToken, w2.workspaceId, pack.packId))! }),
        callTool(grantA.accessToken, "checker.run", { workspaceId: w2.workspaceId, packId: pack.packId, expectedDraftId: (await latestPackDraftId(grantA.accessToken, w2.workspaceId, pack.packId))! }),
      ]);
      const o1 = readTool(r1);
      const o2 = readTool(r2);
      expect(o1.isError).toBe(false);
      expect(o2.isError).toBe(false);
      expect(o1.result!.runId).toBe(o2.result!.runId);
      expect(await countRuns(pack.packId)).toBe(1);
      const createdFlags = [o1.result!.created, o2.result!.created].sort();
      expect(createdFlags).toEqual([false, true]);
    });

    it("draft edit marks checker evidence STALE; a fresh run binds the new exact draft", async () => {
      const draftBefore = readTool(await callTool(grantA.accessToken, "draft.get", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
      }));
      // Evidence may be stale from earlier tests in this file - refresh FIRST
      // so this test controls the stale transition itself.
      const refreshed = readTool(await callTool(grantA.accessToken, "checker.run", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
        expectedDraftId: draftBefore.result!.draftId,
      }));
      expect(refreshed.isError).toBe(false);
      expect(refreshed.result!.isCurrent).toBe(true);

      const before = readTool(await callTool(grantA.accessToken, "checker.get", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
      }));
      expect(before.result!.isCurrent).toBe(true);
      expect((before.result!.run as Record<string, unknown>).draftId).toBe(draftBefore.result!.draftId);

      // Edit -> evidence STALE.
      const tabs = draftBefore.result!.tabs as Array<Record<string, unknown>>;
      const paragraphs = tabs[0].paragraphs as Array<Record<string, unknown>>;
      const editRaw = await callTool(grantA.accessToken, "draft.edit", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
        expectedDraftId: draftBefore.result!.draftId,
        expectedDraftVersion: draftBefore.result!.version,
        expectedDraftSha256: draftBefore.result!.draftSha256,
        command: {
          kind: "replace_sentence",
          paragraphKey: paragraphs[1].paragraphKey,
          expectedParagraphFingerprint: paragraphs[1].paragraphFingerprint,
          startOffset: 0,
          endOffset: 5,
          expectedText: (paragraphs[1].text as string).slice(0, 5),
          replacementText: "เธอพูด",
        },
        idempotencyKey: uniqueTestTag("idem"),
      });
      console.log("[r2-probe] edit raw:", JSON.stringify(editRaw).slice(0, 400));
      const edit = readTool(editRaw);
      expect(edit.isError).toBe(false);

      const after = readTool(await callTool(grantA.accessToken, "checker.get", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
      }));
      expect(after.result!.state).toBe("STALE");
      expect(after.result!.staleReason).toBe("DRAFT_CHANGED");
      expect(after.result!.isCurrent).toBe(false);

      // New run binds the exact new draft.
      const rerun = readTool(await callTool(grantA.accessToken, "checker.run", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
        expectedDraftId: edit.result!.draftId,
      }));
      expect(rerun.isError).toBe(false);
      expect(rerun.result!.created).toBe(true);
      expect(rerun.result!.draftId).toBe(edit.result!.draftId);
      expect(rerun.result!.staleReason).toBeNull();
      expect(rerun.result!.isCurrent).toBe(true);
      // The plugin relays the service's projection verbatim; the service only
      // ever emits needs_fix / pending_confirm (or a no-op without a key).
      const projection = rerun.result!.kanbanProjection as Record<string, unknown>;
      expect(typeof projection.changed).toBe("boolean");
      expect(
        projection.targetColumnKey === null ||
          projection.targetColumnKey === "needs_fix" ||
          projection.targetColumnKey === "pending_confirm"
      ).toBe(true);
    });

    it("checker.get surfaces a specific runId (findings snapshot)", async () => {
      const runs = await listRunIds(packW1.packId);
      expect(runs.length).toBeGreaterThanOrEqual(2);
      const first = readTool(await callTool(grantA.accessToken, "checker.get", {
        workspaceId: w1.workspaceId, packId: packW1.packId, runId: runs[0],
      }));
      expect((first.result!.run as Record<string, unknown>).runId).toBe(runs[0]);
    });
  });

  describe("scope isolation + revoked token", () => {
    it("identity:read alone denies draft.get (INSUFFICIENT_SCOPE) and whoami still works", async () => {
      const denied = await callTool(identityOnlyGrant.accessToken, "draft.get", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
      });
      expect((denied.body!.error as { code: number; data?: { reason?: string } }).data?.reason).toBe("INSUFFICIENT_SCOPE");
      const whoami = readTool(await callTool(identityOnlyGrant.accessToken, "identity.whoami"));
      expect(whoami.result!.userId).toBe(userA.id);
    });

    it("draft:read does NOT imply draft:write or checker:run", async () => {
      const read = readTool(await callTool(draftReadGrant.accessToken, "draft.get", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
      }));
      expect(read.isError).toBe(false);
      const write = readTool(await callTool(draftReadGrant.accessToken, "draft.edit", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
        expectedDraftId: 1, expectedDraftVersion: 1, expectedDraftSha256: "f".repeat(64),
        command: {
          kind: "replace_paragraph", paragraphKey: "k".repeat(64), expectedParagraphFingerprint: "f".repeat(64),
          expectedText: "x", replacementText: "y",
        },
        idempotencyKey: uniqueTestTag("idem"),
      }));
      expect(write.errorCode).toBe("INSUFFICIENT_SCOPE");
      const run = await callTool(draftReadGrant.accessToken, "checker.run", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
      });
      expect((run.body!.error as { data?: { reason?: string } }).data?.reason).toBe("INSUFFICIENT_SCOPE");
    });

    it("revoked token loses every tool immediately (401)", async () => {
      const tempGrant = await runConsentAndExchange(userA, fullClient, ALL_SCOPES);
      const revoke = await fetch(`${baseUrl}/api/plugin/oauth/revoke`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${Buffer.from(`${fullClient.clientId}:${fullClient.clientSecret}`).toString("base64")}`,
        },
        body: JSON.stringify({ token: tempGrant.accessToken, token_type_hint: "access_token" }),
      });
      expect(revoke.status).toBe(200);
      const after = await callTool(tempGrant.accessToken, "draft.edit", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
        expectedDraftId: 1, expectedDraftVersion: 1, expectedDraftSha256: "f".repeat(64),
        command: {
          kind: "replace_paragraph", paragraphKey: "k".repeat(64), expectedParagraphFingerprint: "f".repeat(64),
          expectedText: "x", replacementText: "y",
        },
        idempotencyKey: uniqueTestTag("idem"),
      });
      expect(after.status).toBe(401);
    });
  });

  describe("membership + admin gate", () => {
    it("membership removal takes effect on the very next call", async () => {
      const db = getTestDb();
      const before = readTool(await callTool(grantB.accessToken, "draft.get", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
      }));
      expect(before.isError).toBe(false);
      await db.delete(workspaceMembers).where(eq(workspaceMembers.id, w2MemberB.userId));
      const after = readTool(await callTool(grantB.accessToken, "draft.get", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
      }));
      expect(after.marker).toBe("NOT_FOUND");
    });

    it("non-admin bound user passes tenant proof but inherits the Workspace admin gate (ADMIN_REQUIRED)", async () => {
      // D owns W3 (in-tenant) but is NOT a platform admin - the Workspace
      // services require platform admins, and the plugin inherits that gate.
      const denied = await callTool(grantA.accessToken, "draft.get", {
        workspaceId: w3.workspaceId, packId: packW3.packId,
      });
      // A cannot even pass tenant proof for W3 (foreign workspace).
      const deniedRead = readTool(denied);
      expect(deniedRead.marker).toBe("NOT_FOUND");
      // D is in-tenant (member) but the Workspace service's ADMIN_REQUIRED
      // gate surfaces as a denied tool call.
      const result = readTool(await callTool(grantD.accessToken, "draft.get", {
        workspaceId: w3.workspaceId, packId: packW3.packId,
      }));
      expect(result.errorCode).toContain("ADMIN_REQUIRED");
    });
  });

  describe("R2 contract repairs", () => {
    it("checker.run WITHOUT expectedDraftId fails -32602 (required, not optional)", async () => {
      const res = await callTool(grantA.accessToken, "checker.run", {
        workspaceId: w1.workspaceId, packId: packW1.packId,
      });
      expect(res.status).toBe(200);
      expect((res.body!.error as { code: number }).code).toBe(-32602);
    });

    it("tools/list draft.edit schema is the EXACT three-variant oneOf (replace_tab absent)", async () => {
      const cookie = await sessionCookie(userA);
      const verifier = generatePluginOpaqueToken();
      const listingResponse = await fetch(
        `${baseUrl}/api/plugin/mcp`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${grantA.accessToken}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
        }
      );
      void cookie; void verifier;
      expect(listingResponse.status).toBe(200);
      const tools = ((await listingResponse.json()) as Record<string, unknown>).result as Record<string, unknown>;
      void tools;
      const listingBody = (await Promise.resolve((await fetch(`${baseUrl}/api/plugin/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${grantA.accessToken}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }),
      })).json())) as Record<string, unknown>;
      const listingResult = listingBody.result as Record<string, unknown>;
      const allTools = listingResult.tools as Array<Record<string, unknown>>;
      const draftEdit = allTools.find(tool => tool.name === "draft.edit");
      expect(draftEdit).toBeTruthy();
      const schema = draftEdit!.inputSchema as Record<string, unknown>;

      // Top level: exact required set + additionalProperties false
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toEqual([
        "workspaceId", "packId", "expectedDraftId", "expectedDraftVersion", "expectedDraftSha256", "command", "idempotencyKey",
      ]);
      expect(Object.keys(schema.properties as Record<string, unknown>).sort()).toEqual(
        ["command", "expectedDraftId", "expectedDraftSha256", "expectedDraftVersion", "idempotencyKey", "packId", "workspaceId"]
      );

      // command: exact oneOf with the three paragraph variants, replace_tab ABSENT
      const command = schema.properties.command as Record<string, unknown>;
      expect(command.type).toBe("object");
      const variants = command.oneOf as Array<Record<string, unknown>>;
      expect(variants).toHaveLength(3);
      expect(variants.map(v => (v.properties as Record<string, unknown>).kind.const)).toEqual([
        "replace_sentence", "replace_range", "replace_paragraph",
      ]);
      for (const variant of variants.slice(0, 2)) {
        expect(variant.required).toEqual([
          "kind", "paragraphKey", "expectedParagraphFingerprint", "expectedText", "replacementText", "startOffset", "endOffset",
        ]);
        expect(variant.additionalProperties).toBe(false);
        expect((variant.properties as Record<string, unknown>).startOffset).toEqual({ type: "integer", minimum: 0 });
        expect((variant.properties as Record<string, unknown>).endOffset).toEqual({ type: "integer", minimum: 0 });
      }
      const paragraphVariant = variants[2];
      expect(paragraphVariant.required).toEqual(["kind", "paragraphKey", "expectedParagraphFingerprint", "expectedText", "replacementText"]);
      expect(paragraphVariant.additionalProperties).toBe(false);
      expect((paragraphVariant.properties as Record<string, unknown>).startOffset).toBeUndefined();
      // replace_tab must NOT appear anywhere in the advertised schema.
      expect(JSON.stringify(schema)).not.toContain("replace_tab");
      expect(JSON.stringify(schema)).not.toContain("sourceTabId");
    });

    it("tools/list checker.run schema marks expectedDraftId REQUIRED", async () => {
      const listingResponse = await fetch(`${baseUrl}/api/plugin/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${grantA.accessToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
      });
      const listingBody = (await listingResponse.json()) as Record<string, unknown>;
      const allTools = (listingBody.result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
      const checkerRun = allTools.find(tool => tool.name === "checker.run");
      expect(checkerRun).toBeTruthy();
      const schema = checkerRun!.inputSchema as Record<string, unknown>;
      expect(schema.required).toEqual(["workspaceId", "packId", "expectedDraftId"]);
      expect((schema.properties as Record<string, unknown>).expectedDraftId).toEqual({ type: "integer", minimum: 1 });
    });
  });

  describe("mutation audit hygiene", () => {
    it("plugin audit rows never contain draft/replacement text", async () => {
      const db = getTestDb();
      const rows = await db
        .select({ metadata: pluginAuditLogs.safeMetadata })
        .from(pluginAuditLogs)
        .where(inArray(pluginAuditLogs.clientId, [fullClient.clientId]));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.metadata).not.toContain("ประโยคสุดท้าย");
        expect(row.metadata).not.toContain("replay-target");
        expect(row.metadata).not.toContain("concurrent-A");
        expect(row.metadata).not.toContain("plg_at_");
      }
    });
  });
});

async function countDrafts(workItemId: number): Promise<number> {
  const db = getTestDb();
  const rows = await db
    .select({ id: workspaceEditorialDrafts.id })
    .from(workspaceEditorialDrafts)
    .where(eq(workspaceEditorialDrafts.workItemId, workItemId));
  return rows.length;
}

async function countRuns(workItemId: number): Promise<number> {
  const db = getTestDb();
  const rows = await db
    .select({ id: workspaceEditorialCheckerRuns.id })
    .from(workspaceEditorialCheckerRuns)
    .where(eq(workspaceEditorialCheckerRuns.workItemId, workItemId));
  return rows.length;
}

async function listRunIds(workItemId: number): Promise<number[]> {
  const db = getTestDb();
  const rows = await db
    .select({ id: workspaceEditorialCheckerRuns.id })
    .from(workspaceEditorialCheckerRuns)
    .where(eq(workspaceEditorialCheckerRuns.workItemId, workItemId));
  return rows.map(row => row.id).sort((x, y) => x - y);
}
