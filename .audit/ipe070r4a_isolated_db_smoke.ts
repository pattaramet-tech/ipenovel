import assert from "node:assert/strict";
import { createPool } from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { __setDbForTests } from "../server/db";
import {
  listAuthorWorkspaceReadModels,
  getAuthorWorkspaceReadModel,
  getAuthorWorkspaceDraftReadModel,
  listAuthorWorkspaceNovels,
  listAuthorWorkspaceWorkItems,
} from "../server/workspace/authorRead.service";

const target = process.env.IPE070_R4A_TEST_DB_URL;
if (!target) throw new Error("IPE070_R4A_TEST_DB_URL required");
const u = new URL(target);
if (u.hostname !== "127.0.0.1" || u.port !== "3337" || u.pathname !== "/ipe070_r4a_scratch") {
  throw new Error("Refusing any database other than the exact disposable R4A localhost fixture");
}

const pool = createPool(target);
let cases = 0;
const check = (condition: unknown, label: string) => {
  assert.ok(condition, label);
  cases++;
  console.log("PASS", label);
};

async function schemaAndSeed() {
  const ddl = [
    "CREATE TABLE users (id int PRIMARY KEY, role enum('user','author','admin') NOT NULL)",
    "CREATE TABLE workspaceWorkspaces (id int PRIMARY KEY, name varchar(160) NOT NULL, ownerUserId int NOT NULL, status enum('active','suspended','archived') NOT NULL, deletedAt datetime NULL)",
    "CREATE TABLE workspaceMembers (id int PRIMARY KEY, workspaceId int NOT NULL, userId int NOT NULL, role enum('owner','editor','reviewer','viewer') NOT NULL, status enum('active','invited','suspended','removed') NOT NULL)",
    "CREATE TABLE novels (id int PRIMARY KEY, authorUserId int NULL, title varchar(500) NOT NULL, publicationStatus enum('published','archived') NOT NULL)",
    "CREATE TABLE workspaceNovels (id int PRIMARY KEY, workspaceId int NOT NULL, novelId int NOT NULL, status enum('active','paused','unlinked') NOT NULL)",
    "CREATE TABLE workspaceEditorialWorkItems (id int PRIMARY KEY, cardId int NOT NULL, workspaceNovelId int NOT NULL, workItemType enum('new_story','new_episode') NOT NULL, episodeNumber varchar(100), episodeTitle varchar(500))",
    "CREATE TABLE workspaceEditorialDrafts (id int PRIMARY KEY, workItemId int NOT NULL, version int NOT NULL, presentationJson text NOT NULL, warningsJson text NOT NULL, draftSha256 varchar(64) NOT NULL)",
  ];
  for (const sql of ddl) await pool.query(sql);
  for (const sql of [
    "INSERT INTO users VALUES (101,'author'),(102,'author'),(103,'user'),(104,'admin')",
    "INSERT INTO workspaceWorkspaces VALUES (1,'Shared Editorial',104,'active',NULL),(2,'Foreign Only',104,'active',NULL),(3,'Archived Workspace',104,'archived',NULL),(4,'Invited Only',104,'active',NULL)",
    "INSERT INTO workspaceMembers VALUES (1,1,101,'editor','active'),(2,1,102,'reviewer','active'),(3,2,101,'editor','active'),(4,2,102,'editor','active'),(5,3,101,'owner','active'),(6,4,101,'viewer','invited'),(7,4,102,'editor','active')",
    "INSERT INTO novels VALUES (11,101,'Author A only','published'),(12,102,'Author B secret','archived'),(13,NULL,'Legacy NULL secret','archived'),(14,101,'Author A archived','archived'),(15,102,'Author B second','published')",
    "INSERT INTO workspaceNovels VALUES (1,1,11,'active'),(2,1,12,'active'),(3,1,13,'active'),(4,2,15,'active'),(5,3,14,'active'),(6,4,14,'active'),(7,1,14,'paused')",
    "INSERT INTO workspaceEditorialWorkItems VALUES (2001,10001,1,'new_episode','001','A draft'),(2002,10002,2,'new_episode','002','B private'),(2003,10003,3,'new_episode','003','legacy'),(2004,10004,4,'new_episode','004','B second'),(2005,10005,7,'new_episode','005','paused'),(2006,10006,5,'new_episode','006','archived')",
    "INSERT INTO workspaceEditorialDrafts VALUES (3001,2001,1,'A OWNED CONTENT','[]',REPEAT('a',64)),(3002,2002,1,'B PRIVATE CONTENT','[]',REPEAT('b',64)),(3003,2003,1,'LEGACY PRIVATE','[]',REPEAT('c',64)),(3004,2005,1,'PAUSED PRIVATE','[]',REPEAT('d',64))",
  ]) await pool.query(sql);
}

async function mustNotFind(p: Promise<unknown>, label: string) {
  try {
    await p;
    throw new Error("unexpected authorization");
  } catch (err: any) {
    assert.equal(err.code, "NOT_FOUND", label);
    cases++;
    console.log("PASS", label);
  }
}

try {
  await schemaAndSeed();
  __setDbForTests(drizzle(pool));
  const aList = await listAuthorWorkspaceReadModels(101);
  check(aList.items.length === 1, "Author A sees only one eligible Workspace");
  const novelsA = await listAuthorWorkspaceNovels(101, 1);
  check(novelsA.items.length === 1 && novelsA.items[0].novelId === 11,
    "Author A sees only owned active novel");
  const bList = await listAuthorWorkspaceReadModels(102);
  check(bList.items.length === 2 && bList.items.some(w => w.workspaceId === 1) && bList.items.some(w => w.workspaceId === 2),
    "Author B sees own membership Workspaces without A novel");
  const novelsB1 = await listAuthorWorkspaceNovels(102, 1);
  const novelsB2 = await listAuthorWorkspaceNovels(102, 2);
  check([...novelsB1.items, ...novelsB2.items].every(n => n.novelId === 12 || n.novelId === 15),
    "Author B novel filter is owner-bound");
  const aDetail = await getAuthorWorkspaceReadModel(101, 1);
  const workItemsA = await listAuthorWorkspaceWorkItems(101, aDetail.workspaceId);
  check(workItemsA.items.length === 1 && workItemsA.items[0].workItemId === 2001,
    "Author A work-item board projection excludes foreign and legacy content");
  await mustNotFind(getAuthorWorkspaceReadModel(101, 2),
    "Foreign-only Workspace returns NOT_FOUND despite active member");
  await mustNotFind(getAuthorWorkspaceReadModel(101, 3),
    "Archived Workspace returns NOT_FOUND despite owned novel and owner member");
  await mustNotFind(getAuthorWorkspaceReadModel(101, 4),
    "Invited membership returns NOT_FOUND despite owned novel");
  const ownDraft = await getAuthorWorkspaceDraftReadModel(101, 1, 2001);
  check(ownDraft?.presentationJson === "A OWNED CONTENT", "Author can read own Draft payload");
  for (const id of [2002, 2003, 2005, 2006, 9999]) {
    await mustNotFind(getAuthorWorkspaceDraftReadModel(101, 1, id),
      "Foreign, NULL-owned, paused, archived or nonexistent draft is NOT_FOUND: "+id);
  }
  check((await listAuthorWorkspaceReadModels(103)).items.length === 0, "Reader has no Author Workspace data");
  check((await listAuthorWorkspaceReadModels(104)).items.length === 0, "Admin not projected through Author-only service");

  await pool.query("UPDATE users SET role='user' WHERE id=101");
  check((await listAuthorWorkspaceReadModels(101)).items.length === 0, "Current DB role downgrade revokes list immediately");
  await mustNotFind(getAuthorWorkspaceDraftReadModel(101, 1, 2001),
    "Current DB role downgrade revokes Draft immediately");
  await pool.query("UPDATE users SET role='author' WHERE id=101");
  await pool.query("UPDATE workspaceMembers SET status='removed' WHERE workspaceId=1 AND userId=101");
  check((await listAuthorWorkspaceReadModels(101)).items.length === 0,
    "Membership revocation prevents subsequent reads");
  await pool.query("UPDATE workspaceMembers SET status='active' WHERE workspaceId=1 AND userId=101");
  await pool.query("UPDATE novels SET authorUserId=102 WHERE id=11");
  check((await listAuthorWorkspaceReadModels(101)).items.length === 0,
    "Novel ownership transfer prevents subsequent reads");

  console.log("ISOLATED_MARIADB_R4A_SMOKE_PASS cases="+cases);
} finally {
  __setDbForTests(null);
  await pool.end();
}
