import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import express from "express";
import { createServer, type Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";

// IPE-PLUGIN-001C integration + security suite - the tenant authorization
// boundary exercised end-to-end over the real (test) MySQL:
//   1. A/B/C multi-account isolation - every tool resolves ONLY the
//      workspaces the bound user owns or is an active member of,
//   2. cross-tenant IDOR - any foreign workspace/novel/pack/chapter id is
//      NOT_FOUND (no existence oracle) and audited,
//   3. scope isolation - identity:read alone grants none of the tenant tools,
//   4. revoke - a revoked token loses every tool immediately,
//   5. concurrency - parallel mixed-account calls never cross identities, and
//      a membership removed mid-flight disappears on the very next call.
//
// Test env values are pinned by vitest.integration.config.ts's env block
// (authoritative - see the config comment for the setupfile import order).

import { COOKIE_NAME } from "@shared/const";
import { sdk } from "../_core/sdk";
import {
  pluginAuditLogs,
  pluginOAuthAuthorizations,
  pluginOAuthClients,
  workspaceEditorialDraftTabs,
  workspaceEditorialDrafts,
  workspaceEditorialSourceSnapshots,
  workspaceEditorialSources,
  workspaceEditorialWorkItems,
  workspaceKanbanBoards,
  workspaceKanbanCards,
  workspaceKanbanColumns,
  workspaceMembers,
  workspaceNovels,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { getTestDb } from "../test-helpers/testDb";
import {
  createTestNovel,
  createTestUser,
  deleteFixtures,
  uniqueTestTag,
  type TestUserFixture,
} from "../test-helpers/fixtures";
import { registerPluginFoundationRoutes } from "./oauth/routes";
import {
  computePkceS256Challenge,
  generatePluginOpaqueToken,
  hashPluginSecret,
} from "./crypto";

const REDIRECT_URI = "https://chatgpt.example/callback";
const ALL_READ_SCOPES = "identity:read workspace:read novel:read pack:read chapter:read";

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

async function createTestPluginClient(
  allowedScopes: string
): Promise<{ clientId: string; clientSecret: string }> {
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
    appId: "ipenovel-integration-test-app",
    name: `Tenant Test ${user.id}`,
  });
  return `${COOKIE_NAME}=${token}`;
}

type WorkspaceRef = { workspaceId: number; name: string };

async function createWorkspaceWithMember(input: {
  owner: TestUserFixture;
  name: string;
  member?: { user: TestUserFixture; role: "editor" | "reviewer" | "viewer" };
}): Promise<WorkspaceRef> {
  const db = getTestDb();
  const workspaceId = extractInsertId(
    await db.insert(workspaceWorkspaces).values({ name: input.name, ownerUserId: input.owner.id })
  );
  createdWorkspaceIds.push(workspaceId);
  // The owner always holds an active owner member row (createWorkspace invariant).
  await db
    .insert(workspaceMembers)
    .values({ workspaceId, userId: input.owner.id, role: "owner", status: "active" });
  if (input.member) {
    await db.insert(workspaceMembers).values({
      workspaceId,
      userId: input.member.user.id,
      role: input.member.role,
      status: "active",
    });
  }
  return { workspaceId, name: input.name };
}

async function bindNovel(
  workspaceId: number,
  novelId: number,
  status: "active" | "paused" = "active"
): Promise<number> {
  const db = getTestDb();
  return extractInsertId(await db.insert(workspaceNovels).values({ workspaceId, novelId, status }));
}

type PackRef = { packId: number; chapterIds: number[] };

async function createEditorialPack(input: {
  workspaceId: number;
  workspaceNovelId: number;
  creator: TestUserFixture;
  episodeNumber: string;
  chapters: Array<{ tabOrder: number; title: string; chapterNumber: string; chapterTitle: string }>;
  draftVersions?: number[];
}): Promise<PackRef> {
  const db = getTestDb();
  const itemKey = `ep-${uniqueTestTag("pack")}`;

  // Editorial board (slug "editorial") + one kanban column, per workspace.
  // Boards are UNIQUE(workspaceId, slug), so multiple packs in one workspace
  // SHARE the board/column - find-or-create instead of blind insert.
  const existingBoards = await db
    .select({ boardId: workspaceKanbanBoards.id })
    .from(workspaceKanbanBoards)
    .where(
      and(
        eq(workspaceKanbanBoards.workspaceId, input.workspaceId),
        eq(workspaceKanbanBoards.slug, "editorial")
      )
    )
    .limit(1);
  let boardId = existingBoards[0]?.boardId ?? 0;
  if (!boardId) {
    boardId = extractInsertId(
      await db
        .insert(workspaceKanbanBoards)
        .values({ workspaceId: input.workspaceId, name: "Editorial", slug: "editorial" })
    );
  }
  const existingColumns = await db
    .select({ columnId: workspaceKanbanColumns.id })
    .from(workspaceKanbanColumns)
    .where(and(eq(workspaceKanbanColumns.boardId, boardId), eq(workspaceKanbanColumns.key, "new")))
    .limit(1);
  let columnId = existingColumns[0]?.columnId ?? 0;
  if (!columnId) {
    columnId = extractInsertId(
      await db.insert(workspaceKanbanColumns).values({ boardId, key: "new", name: "ใหม่เข้า", position: 0 })
    );
  }
  const cardId = extractInsertId(
    await db
      .insert(workspaceKanbanCards)
      .values({ boardId, columnId, logicalItemKey: `episode:${input.workspaceNovelId}:${itemKey}` })
  );
  const packId = extractInsertId(
    await db.insert(workspaceEditorialWorkItems).values({
      cardId,
      workspaceNovelId: input.workspaceNovelId,
      workItemType: "new_episode",
      itemKey,
      episodeNumber: input.episodeNumber,
      episodeTitle: `แพ็ก ${input.episodeNumber}`,
      saleMode: "package",
      price: "45.00",
      isFree: false,
      createdByUserId: input.creator.id,
    })
  );

  // source -> snapshot -> draft per version -> tabs (latest version wins).
  const sourceId = extractInsertId(
    await db.insert(workspaceEditorialSources).values({
      workItemId: packId,
      sourceKind: "uploaded_file",
      sourceKey: uniqueTestTag("src"),
      mimeType: "text/plain",
      title: `แหล่งต้นฉบับ ${input.episodeNumber}`,
      createdByUserId: input.creator.id,
    })
  );
  const snapshotId = extractInsertId(
    await db.insert(workspaceEditorialSourceSnapshots).values({
      sourceId,
      revisionKey: uniqueTestTag("rev"),
      sourceSha256: hashPluginSecret(`${packId}:${itemKey}`),
      rawContentJson: JSON.stringify({ paragraphs: ["แปล", "แปล"] }),
      byteLength: 32,
      createdByUserId: input.creator.id,
    })
  );

  const versions = input.draftVersions ?? [1];
  let chapterIds: number[] = [];
  for (const version of versions) {
    const draftId = extractInsertId(
      await db.insert(workspaceEditorialDrafts).values({
        workItemId: packId,
        sourceSnapshotId: snapshotId,
        version,
        origin: "source_import",
        transformCode: "identity",
        presentationJson: JSON.stringify({ paragraphs: [] }),
        warningsJson: "[]",
        draftSha256: hashPluginSecret(`${packId}:${version}`),
        createdByUserId: input.creator.id,
      })
    );
    const ids: number[] = [];
    for (const chapter of input.chapters) {
      ids.push(
        extractInsertId(
          await db.insert(workspaceEditorialDraftTabs).values({
            draftId,
            sourceTabId: `${chapter.tabOrder}-${version}-${uniqueTestTag("tab")}`,
            tabOrder: chapter.tabOrder,
            title: chapter.title,
            chapterNumber: chapter.chapterNumber,
            chapterTitle: chapter.chapterTitle,
            structuralSha256: hashPluginSecret(`${draftId}:${chapter.tabOrder}`),
            fingerprintSequenceJson: JSON.stringify([]),
            warningsJson: "[]",
          })
        )
      );
    }
    if (version === versions[versions.length - 1]) chapterIds = ids;
  }
  return { packId, chapterIds };
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
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Unwraps a tool result: structuredContent, or the in-band NOT_FOUND marker. */
function toolResult(response: { body: Record<string, unknown> | null } | null): {
  result: Record<string, unknown> | null;
  notFound: boolean;
  isError: boolean;
} {
  const body = response?.body ?? null;
  if (!body || typeof body.result !== "object" || body.result === null) {
    return { result: null, notFound: false, isError: false };
  }
  const result = body.result as Record<string, unknown>;
  const isError = result.isError === true;
  const notFound = isError && (result.structuredContent === null || result.structuredContent === undefined);
  return {
    result: (result.structuredContent as Record<string, unknown> | null) ?? null,
    notFound,
    isError,
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
    // Kanban cards must go before their (RESTRICT-referenced) columns:
    // board->column and board->card are both cascades, but card->column is
    // RESTRICT, so relying on cascade order alone fails the delete.
    const boardRows = await db
      .select({ boardId: workspaceKanbanBoards.id })
      .from(workspaceKanbanBoards)
      .where(inArray(workspaceKanbanBoards.workspaceId, createdWorkspaceIds));
    const boardIds = boardRows.map(row => row.boardId);
    if (boardIds.length > 0) {
      await db.delete(workspaceKanbanCards).where(inArray(workspaceKanbanCards.boardId, boardIds));
    }
    // members/novels/sources/snapshots/drafts/tabs all cascade off the workspace.
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

describe("plugin tenant boundary (001C)", () => {
  let userA: TestUserFixture;
  let userB: TestUserFixture;
  let userC: TestUserFixture;
  let w1: WorkspaceRef;
  let w2: WorkspaceRef;
  let novelW1: { novelId: number };
  let novelW1Paused: { novelId: number };
  let novelW1Unlinked: { novelId: number };
  let novelW2: { novelId: number };
  let w1BindingId = 0;
  let w1PausedBindingId = 0;
  let pack1: PackRef;
  let pack2: PackRef;
  let packPaused: PackRef;
  let packUnlinked: PackRef;
  let grantA: { accessToken: string; refreshToken: string; scope: string };
  let grantB: { accessToken: string; refreshToken: string; scope: string };
  let grantC: { accessToken: string; refreshToken: string; scope: string };
  let fullClient: { clientId: string; clientSecret: string };
  let identityOnlyGrant: { accessToken: string; refreshToken: string; scope: string };
  let workspaceOnlyGrant: { accessToken: string; refreshToken: string; scope: string };

  beforeAll(async () => {
    userA = await createTestUser({ name: "Tenant A" });
    userB = await createTestUser({ name: "Tenant B" });
    userC = await createTestUser({ name: "Tenant C" });
    createdUserIds.push(userA.id, userB.id, userC.id);

    w1 = await createWorkspaceWithMember({
      owner: userA,
      name: `W1-${uniqueTestTag("ws")}`,
      member: { user: userB, role: "viewer" },
    });
    w2 = await createWorkspaceWithMember({ owner: userA, name: `W2-${uniqueTestTag("ws")}` });

    novelW1 = { novelId: (await createTestNovel({ title: "นิยาย W1" })).id };
    createdNovelIds.push(novelW1.novelId);
    novelW1Paused = { novelId: (await createTestNovel({ title: "นิยาย W1 paused" })).id };
    createdNovelIds.push(novelW1Paused.novelId);
    novelW2 = { novelId: (await createTestNovel({ title: "นิยาย W2" })).id };
    createdNovelIds.push(novelW2.novelId);

    w1BindingId = await bindNovel(w1.workspaceId, novelW1.novelId, "active");
    w1PausedBindingId = await bindNovel(w1.workspaceId, novelW1Paused.novelId, "paused");
    const w2BindingId = await bindNovel(w2.workspaceId, novelW2.novelId, "active");
    // A novel bound "active" then flipped to "unlinked" - the row stays, the
    // boundary must still hide everything under it.
    novelW1Unlinked = { novelId: (await createTestNovel({ title: "นิยาย W1 unlinked" })).id };
    createdNovelIds.push(novelW1Unlinked.novelId);
    const w1UnlinkedBindingId = await bindNovel(w1.workspaceId, novelW1Unlinked.novelId, "unlinked");

    pack1 = await createEditorialPack({
      workspaceId: w1.workspaceId,
      workspaceNovelId: w1BindingId,
      creator: userA,
      episodeNumber: "1",
      draftVersions: [1, 2],
      chapters: [
        { tabOrder: 1, title: "แท็บ 1", chapterNumber: "1", chapterTitle: "ตอนที่ 1" },
        { tabOrder: 2, title: "แท็บ 2", chapterNumber: "2", chapterTitle: "ตอนที่ 2" },
      ],
    });
    pack2 = await createEditorialPack({
      workspaceId: w2.workspaceId,
      workspaceNovelId: w2BindingId,
      creator: userA,
      episodeNumber: "1",
      draftVersions: [1],
      chapters: [{ tabOrder: 1, title: "แท็บ W2", chapterNumber: "1", chapterTitle: "W2 ตอนที่ 1" }],
    });
    // Packs UNDER non-active bindings - must be invisible through every tool.
    packPaused = await createEditorialPack({
      workspaceId: w1.workspaceId,
      workspaceNovelId: w1PausedBindingId,
      creator: userA,
      episodeNumber: "1",
      draftVersions: [1],
      chapters: [{ tabOrder: 1, title: "แท็บ paused", chapterNumber: "1", chapterTitle: "paused ตอนที่ 1" }],
    });
    packUnlinked = await createEditorialPack({
      workspaceId: w1.workspaceId,
      workspaceNovelId: w1UnlinkedBindingId,
      creator: userA,
      episodeNumber: "1",
      draftVersions: [1],
      chapters: [{ tabOrder: 1, title: "แท็บ unlinked", chapterNumber: "1", chapterTitle: "unlinked ตอนที่ 1" }],
    });

    fullClient = await createTestPluginClient(ALL_READ_SCOPES);
    const identityOnlyClient = await createTestPluginClient("identity:read");

    grantA = await runConsentAndExchange(userA, fullClient, ALL_READ_SCOPES);
    grantB = await runConsentAndExchange(userB, fullClient, ALL_READ_SCOPES);
    grantC = await runConsentAndExchange(userC, fullClient, ALL_READ_SCOPES);
    identityOnlyGrant = await runConsentAndExchange(userA, identityOnlyClient, "identity:read");
    workspaceOnlyGrant = await runConsentAndExchange(userB, fullClient, "workspace:read");
  });

  it("grants carry exactly the consented scope string", () => {
    expect([...grantA.scope.split(" ")].sort()).toEqual([...ALL_READ_SCOPES.split(" ")].sort());
    expect(identityOnlyGrant.scope).toBe("identity:read");
    expect(workspaceOnlyGrant.scope).toBe("workspace:read");
  });

  describe("workspace.list/get - ownership and membership derived server-side", () => {
    it("A sees exactly its two workspaces as owner; B sees only W1 as viewer; C sees none", async () => {
      const a = toolResult(await callTool(grantA.accessToken, "workspace.list"));
      expect(a.isError).toBe(false);
      expect(a.result!.workspaces).toEqual([
        { workspaceId: w1.workspaceId, name: w1.name, viewerRole: "owner" },
        { workspaceId: w2.workspaceId, name: w2.name, viewerRole: "owner" },
      ]);

      const b = toolResult(await callTool(grantB.accessToken, "workspace.list"));
      expect(b.result!.workspaces).toEqual([
        { workspaceId: w1.workspaceId, name: w1.name, viewerRole: "viewer" },
      ]);

      const c = toolResult(await callTool(grantC.accessToken, "workspace.list"));
      expect(c.result!.workspaces).toEqual([]);
    });

    it("workspace.get resolves in-tenant and NOT_FOUND cross-tenant (no existence oracle)", async () => {
      const a = toolResult(await callTool(grantA.accessToken, "workspace.get", { workspaceId: w1.workspaceId }));
      expect(a.result).toMatchObject({
        workspaceId: w1.workspaceId,
        name: w1.name,
        ownerUserId: userA.id,
        viewerRole: "owner",
      });

      const bW2 = toolResult(await callTool(grantB.accessToken, "workspace.get", { workspaceId: w2.workspaceId }));
      expect(bW2.notFound).toBe(true);

      const cW1 = toolResult(await callTool(grantC.accessToken, "workspace.get", { workspaceId: w1.workspaceId }));
      expect(cW1.notFound).toBe(true);

      const missing = toolResult(await callTool(grantA.accessToken, "workspace.get", { workspaceId: 987654321 }));
      expect(missing.notFound).toBe(true);
      // Same fixed empty failure for foreign and missing ids.
      expect(missing.result).toEqual(bW2.result);
    });
  });

  describe("novel.list/get - workspace binding + paused hidden", () => {
    it("lists only active bindings of a visible workspace", async () => {
      const a = toolResult(await callTool(grantA.accessToken, "novel.list", { workspaceId: w1.workspaceId }));
      expect(a.isError).toBe(false);
      expect(a.result!.novels).toHaveLength(1);
      expect(a.result!.novels[0]).toMatchObject({
        workspaceId: w1.workspaceId,
        workspaceNovelId: w1BindingId,
        novelId: novelW1.novelId,
        title: "นิยาย W1",
        publicationStatus: "published",
      });
    });

    it("resolves in-tenant novel and NOT_FOUND for wrong-workspace/foreign ids", async () => {
      const own = toolResult(
        await callTool(grantA.accessToken, "novel.get", { workspaceId: w1.workspaceId, novelId: novelW1.novelId })
      );
      expect(own.result).toMatchObject({ novelId: novelW1.novelId, title: "นิยาย W1" });

      // N3 is bound to W2 - asking via W1 finds nothing even for A (who CAN
      // see W2): the workspace scoping is part of the lookup itself.
      const wrongWorkspace = toolResult(
        await callTool(grantA.accessToken, "novel.get", { workspaceId: w1.workspaceId, novelId: novelW2.novelId })
      );
      expect(wrongWorkspace.notFound).toBe(true);

      // B cannot see W2 at all.
      const bW2 = toolResult(
        await callTool(grantB.accessToken, "novel.get", { workspaceId: w2.workspaceId, novelId: novelW2.novelId })
      );
      expect(bW2.notFound).toBe(true);

      // A sees W2 through its own grant.
      const aW2 = toolResult(
        await callTool(grantA.accessToken, "novel.get", { workspaceId: w2.workspaceId, novelId: novelW2.novelId })
      );
      expect(aW2.result).toMatchObject({ novelId: novelW2.novelId, title: "นิยาย W2" });
    });
  });

  describe("pack.list/get - editorial board scoping", () => {
    it("lists packs with the kanban stage and supports the novelId filter", async () => {
      const a = toolResult(await callTool(grantA.accessToken, "pack.list", { workspaceId: w1.workspaceId }));
      expect(a.isError).toBe(false);
      expect(a.result!.packs).toHaveLength(1);
      expect(a.result!.packs[0]).toMatchObject({
        packId: pack1.packId,
        workspaceId: w1.workspaceId,
        novelId: novelW1.novelId,
        episodeNumber: "1",
        price: "45.00",
        isFree: false,
        stage: "new",
      });

      const filtered = toolResult(
        await callTool(grantA.accessToken, "pack.list", { workspaceId: w1.workspaceId, novelId: novelW1.novelId })
      );
      expect(filtered.result!.packs).toHaveLength(1);
      const filteredOther = toolResult(
        await callTool(grantA.accessToken, "pack.list", {
          workspaceId: w1.workspaceId,
          novelId: novelW1Paused.novelId,
        })
      );
      expect(filteredOther.result!.packs).toHaveLength(0);
    });

    it("denies cross-tenant packs with NOT_FOUND", async () => {
      const b = toolResult(
        await callTool(grantB.accessToken, "pack.get", { workspaceId: w2.workspaceId, packId: pack2.packId })
      );
      expect(b.notFound).toBe(true);

      const c = toolResult(
        await callTool(grantC.accessToken, "pack.get", { workspaceId: w1.workspaceId, packId: pack1.packId })
      );
      expect(c.notFound).toBe(true);

      const aOwn = toolResult(
        await callTool(grantA.accessToken, "pack.get", { workspaceId: w1.workspaceId, packId: pack1.packId })
      );
      expect(aOwn.result).toMatchObject({ packId: pack1.packId, stage: "new" });
    });
  });

  describe("active workspaceNovel binding boundary (paused/unlinked hidden)", () => {
    it("pack.list exposes only packs under ACTIVE bindings", async () => {
      const a = toolResult(await callTool(grantA.accessToken, "pack.list", { workspaceId: w1.workspaceId }));
      expect(a.isError).toBe(false);
      const packIds = (a.result!.packs as Array<{ packId: number }>).map(pack => pack.packId);
      expect(packIds).toEqual([pack1.packId]);
    });

    it("pack.get under a paused or unlinked binding is NOT_FOUND", async () => {
      const paused = toolResult(await callTool(grantA.accessToken, "pack.get", {
        workspaceId: w1.workspaceId,
        packId: packPaused.packId,
      }));
      expect(paused.notFound).toBe(true);
      const unlinked = toolResult(await callTool(grantA.accessToken, "pack.get", {
        workspaceId: w1.workspaceId,
        packId: packUnlinked.packId,
      }));
      expect(unlinked.notFound).toBe(true);
    });

    it("chapter.list/get under a paused or unlinked binding is NOT_FOUND", async () => {
      const pausedList = toolResult(await callTool(grantA.accessToken, "chapter.list", {
        workspaceId: w1.workspaceId,
        packId: packPaused.packId,
      }));
      expect(pausedList.notFound).toBe(true);
      const unlinkedList = toolResult(await callTool(grantA.accessToken, "chapter.list", {
        workspaceId: w1.workspaceId,
        packId: packUnlinked.packId,
      }));
      expect(unlinkedList.notFound).toBe(true);
      const pausedGet = toolResult(await callTool(grantA.accessToken, "chapter.get", {
        workspaceId: w1.workspaceId,
        chapterId: packPaused.chapterIds[0],
      }));
      expect(pausedGet.notFound).toBe(true);
      const unlinkedGet = toolResult(await callTool(grantA.accessToken, "chapter.get", {
        workspaceId: w1.workspaceId,
        chapterId: packUnlinked.chapterIds[0],
      }));
      expect(unlinkedGet.notFound).toBe(true);
    });

    it("re-activating a binding brings its pack back (live boundary, not stale data)", async () => {
      const db = getTestDb();
      await db
        .update(workspaceNovels)
        .set({ status: "active" })
        .where(eq(workspaceNovels.id, w1PausedBindingId));
      try {
        const a = toolResult(await callTool(grantA.accessToken, "pack.list", { workspaceId: w1.workspaceId }));
        const packIds = (a.result!.packs as Array<{ packId: number }>).map(pack => pack.packId).sort((x, y) => x - y);
        expect(packIds).toEqual([pack1.packId, packPaused.packId].sort((x, y) => x - y));
        const packBack = toolResult(await callTool(grantA.accessToken, "pack.get", {
          workspaceId: w1.workspaceId,
          packId: packPaused.packId,
        }));
        expect(packBack.result).toMatchObject({ packId: packPaused.packId });
      } finally {
        await db
          .update(workspaceNovels)
          .set({ status: "paused" })
          .where(eq(workspaceNovels.id, w1PausedBindingId));
      }
    });
  });

  describe("chapter.list/get - latest draft only, tenancy inside the join", () => {
    it("lists tabs of the LATEST draft version only, ordered", async () => {
      const a = toolResult(
        await callTool(grantA.accessToken, "chapter.list", { workspaceId: w1.workspaceId, packId: pack1.packId })
      );
      expect(a.isError).toBe(false);
      const chapters = a.result!.chapters as Array<Record<string, unknown>>;
      expect(chapters).toHaveLength(2);
      expect(chapters.map(chapter => chapter.tabOrder)).toEqual([1, 2]);
      expect(chapters[0]).toMatchObject({
        workspaceId: w1.workspaceId,
        packId: pack1.packId,
        chapterNumber: "1",
        chapterTitle: "ตอนที่ 1",
      });
      // Only the latest version's tab ids ever surface.
      expect(chapters.map(chapter => Number(chapter.chapterId))).toEqual([...pack1.chapterIds].sort((x, y) => x - y));
    });

    it("denies cross-tenant chapters with NOT_FOUND", async () => {
      const own = toolResult(
        await callTool(grantA.accessToken, "chapter.get", {
          workspaceId: w1.workspaceId,
          chapterId: pack1.chapterIds[0],
        })
      );
      expect(own.result).toMatchObject({ chapterId: pack1.chapterIds[0], packId: pack1.packId });

      const foreign = toolResult(
        await callTool(grantA.accessToken, "chapter.get", {
          workspaceId: w1.workspaceId,
          chapterId: pack2.chapterIds[0],
        })
      );
      expect(foreign.notFound).toBe(true);

      const b = toolResult(
        await callTool(grantB.accessToken, "chapter.get", {
          workspaceId: w2.workspaceId,
          chapterId: pack2.chapterIds[0],
        })
      );
      expect(b.notFound).toBe(true);
    });
  });

  describe("scope isolation", () => {
    it("identity:read alone grants NONE of the tenant tools", async () => {
      const denied = await callTool(identityOnlyGrant.accessToken, "workspace.list");
      expect(denied.status).toBe(200);
      const error = denied.body!.error as { code: number; data?: { reason: string } };
      expect(error.code).toBe(-32000);
      expect(error.data?.reason).toBe("INSUFFICIENT_SCOPE");

      const whoami = toolResult(await callTool(identityOnlyGrant.accessToken, "identity.whoami"));
      expect(whoami.result!.userId).toBe(userA.id);
    });

    it("workspace:read does not leak into novel:read tools", async () => {
      const workspaceOk = toolResult(await callTool(workspaceOnlyGrant.accessToken, "workspace.list"));
      expect(workspaceOk.result!.workspaces).toEqual([
        { workspaceId: w1.workspaceId, name: w1.name, viewerRole: "viewer" },
      ]);

      const novelDenied = await callTool(workspaceOnlyGrant.accessToken, "novel.list", {
        workspaceId: w1.workspaceId,
      });
      expect((novelDenied.body!.error as { data?: { reason?: string } }).data?.reason).toBe("INSUFFICIENT_SCOPE");
    });

    it("rejects malformed tool arguments with INVALID_PARAMS (never executes)", async () => {
      const zero = await callTool(grantA.accessToken, "workspace.get", { workspaceId: 0 });
      expect((zero.body!.error as { code: number }).code).toBe(-32602);
      const asString = await callTool(grantA.accessToken, "workspace.get", { workspaceId: "one" });
      expect((asString.body!.error as { code: number }).code).toBe(-32602);
      const extra = await callTool(grantA.accessToken, "workspace.list", { workspaceId: 1, extra: true });
      expect((extra.body!.error as { code: number }).code).toBe(-32602);
    });
  });

  describe("revocation", () => {
    it("a revoked token loses every tool immediately", async () => {
      const before = toolResult(await callTool(grantC.accessToken, "workspace.list"));
      expect(before.result!.workspaces).toEqual([]);

      const revoke = await fetch(`${baseUrl}/api/plugin/oauth/revoke`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${Buffer.from(`${fullClient.clientId}:${fullClient.clientSecret}`).toString("base64")}`,
        },
        body: JSON.stringify({ token: grantC.accessToken, token_type_hint: "access_token" }),
      });
      expect(revoke.status).toBe(200);

      const after = await callTool(grantC.accessToken, "workspace.list");
      expect(after.status).toBe(401);
      const afterWhoami = await callTool(grantC.accessToken, "identity.whoami");
      expect(afterWhoami.status).toBe(401);
    });
  });

  describe("concurrency isolation", () => {
    it("parallel mixed-account calls never cross identities", async () => {
      const rounds = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          index % 2 === 0
            ? callTool(grantA.accessToken, "workspace.list")
            : callTool(grantB.accessToken, "workspace.list")
        )
      );
      rounds.forEach((round, index) => {
        const { result } = toolResult(round);
        const workspaces = result!.workspaces as Array<{ workspaceId: number }>;
        if (index % 2 === 0) {
          expect(workspaces.map(workspace => workspace.workspaceId).sort((x, y) => x - y)).toEqual(
            [w1.workspaceId, w2.workspaceId].sort((x, y) => x - y)
          );
        } else {
          expect(workspaces.map(workspace => workspace.workspaceId)).toEqual([w1.workspaceId]);
        }
      });
    });

    it("a membership removed mid-flight disappears on the next call, for that account only", async () => {
      const db = getTestDb();
      await db.update(workspaceMembers).set({ status: "removed" }).where(inArray(workspaceMembers.userId, [userB.id]));

      const bAfter = toolResult(await callTool(grantB.accessToken, "workspace.list"));
      expect(bAfter.result!.workspaces).toEqual([]);
      const bPack = toolResult(
        await callTool(grantB.accessToken, "pack.get", { workspaceId: w1.workspaceId, packId: pack1.packId })
      );
      expect(bPack.notFound).toBe(true);

      // A is untouched by B's removal.
      const aAfter = toolResult(await callTool(grantA.accessToken, "workspace.list"));
      expect(aAfter.result!.workspaces).toHaveLength(2);
    });
  });

  describe("audit trail", () => {
    it("records tenant and scope denials with fixed reasons and correlation ids", async () => {
      const db = getTestDb();
      const rows = await db
        .select({
          eventType: pluginAuditLogs.eventType,
          metadata: pluginAuditLogs.safeMetadata,
          correlationId: pluginAuditLogs.correlationId,
        })
        .from(pluginAuditLogs)
        .where(inArray(pluginAuditLogs.clientId, [fullClient.clientId]));
      const denyReasons = new Set(
        rows
          .filter(row => row.eventType === "mcp_tool_denied")
          .map(row => (JSON.parse(row.metadata) as { reason: string }).reason)
      );
      expect(denyReasons.has("TENANT_NOT_FOUND")).toBe(true);
      expect(denyReasons.has("INSUFFICIENT_SCOPE")).toBe(true);
      for (const row of rows) {
        expect(row.correlationId.startsWith("plg-")).toBe(true);
      }
      // Deny metadata carries only the fixed capability + reason - never ids.
      for (const row of rows.filter(item => item.eventType === "mcp_tool_denied")) {
        expect(Object.keys(JSON.parse(row.metadata)).sort()).toEqual(["capability", "reason"]);
      }
    });
  });
});
