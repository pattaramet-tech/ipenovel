import { describe, expect, it } from "vitest";
import { createPool } from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { __setDbForTests } from "../db";
import {
  getAuthorWorkspaceDraftReadModel,
  getAuthorWorkspaceReadModel,
  listAuthorWorkspaceNovels,
  listAuthorWorkspaceReadModels,
  listAuthorWorkspaceWorkItems,
} from "./authorRead.service";

const fixture = process.env.IPE070_R4A_TEST_DB_URL;
const accepted = fixture && (() => {
  try {
    const u = new URL(fixture);
    return u.protocol === "mysql:" && u.hostname === "127.0.0.1" &&
      u.port === "3337" && u.pathname === "/ipe070_r4a_scratch";
  } catch { return false; }
})();
if (fixture && !accepted) throw new Error("REFUSED: unsafe integration database target");

describe("R4A-R2 SQL authorization and pagination", () => {
  it.skipIf(!accepted)("isolates Authors and returns all work items beyond 1000", async () => {
    const pool = createPool(fixture!);
    try {
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
      const seed = [
        "INSERT INTO users VALUES (101,'author'),(102,'author'),(103,'user'),(104,'admin')",
        "INSERT INTO workspaceWorkspaces VALUES (1,'Shared',104,'active',NULL),(2,'Foreign only',104,'active',NULL),(3,'Archived',104,'archived',NULL),(4,'Invited',104,'active',NULL)",
        "INSERT INTO workspaceMembers VALUES (1,1,101,'editor','active'),(2,1,102,'viewer','active'),(3,2,101,'editor','active'),(4,2,102,'editor','active'),(5,3,101,'owner','active'),(6,4,101,'viewer','invited'),(7,4,102,'editor','active')",
        "INSERT INTO novels VALUES (11,101,'A own','published'),(12,102,'B private','archived'),(13,NULL,'Legacy NULL','archived'),(14,101,'Inactive A','archived'),(15,102,'B second','published')",
        "INSERT INTO workspaceNovels VALUES (1,1,11,'active'),(2,1,12,'active'),(3,1,13,'active'),(4,2,15,'active'),(5,3,14,'active'),(6,4,14,'active'),(7,1,14,'paused')",
        "INSERT INTO workspaceEditorialWorkItems VALUES (2001,3001,1,'new_episode','001','A draft'),(2002,3002,2,'new_episode','002','B draft'),(2003,3003,3,'new_episode','003','NULL'),(2004,3004,7,'new_episode','004','paused')",
        "INSERT INTO workspaceEditorialDrafts VALUES (3001,2001,1,'OWNED A','[]',REPEAT('a',64)),(3002,2002,1,'PRIVATE B','[]',REPEAT('b',64)),(3003,2003,1,'NULL PRIVATE','[]',REPEAT('c',64))",
      ];
      for (const sql of seed) await pool.query(sql);
      __setDbForTests(drizzle(pool));
      const a = await listAuthorWorkspaceReadModels(101);
      expect(a.items.map(w => w.workspaceId)).toEqual([1]);
      expect((await listAuthorWorkspaceReadModels(103)).items).toEqual([]);
      expect((await listAuthorWorkspaceReadModels(104)).items).toEqual([]);
      const bPage = await listAuthorWorkspaceReadModels(102, { limit: 1 });
      expect(bPage.items.map(w => w.workspaceId)).toEqual([1]);
      expect(bPage.nextCursor).toBe(1);
      const bNext = await listAuthorWorkspaceReadModels(102, { limit: 1, cursor: bPage.nextCursor! });
      expect(bNext.items.map(w => w.workspaceId)).toEqual([2]);
      expect(bNext.nextCursor).toBeNull();
      expect((await getAuthorWorkspaceReadModel(101, 1)).name).toBe("Shared");
      await expect(getAuthorWorkspaceReadModel(101, 2)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(getAuthorWorkspaceReadModel(101, 3)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(getAuthorWorkspaceReadModel(101, 4)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect((await listAuthorWorkspaceNovels(101, 1)).items.map(n => n.novelId)).toEqual([11]);
      expect((await listAuthorWorkspaceNovels(102, 1)).items.map(n => n.novelId)).toEqual([12]);
      expect((await listAuthorWorkspaceWorkItems(101, 1)).items.map(w => w.workItemId)).toEqual([2001]);
      expect((await getAuthorWorkspaceDraftReadModel(101, 1, 2001))?.presentationJson).toBe("OWNED A");
      for (const workItemId of [2002, 2003, 2004, 9999]) {
        await expect(getAuthorWorkspaceDraftReadModel(101, 1, workItemId))
          .rejects.toMatchObject({ code: "NOT_FOUND" });
      }
      await expect(listAuthorWorkspaceNovels(101, 2)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(listAuthorWorkspaceWorkItems(101, 2)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(listAuthorWorkspaceNovels(101, 1, { limit: 101 }))
        .rejects.toMatchObject({ code: "BAD_REQUEST" });
      for (let begin = 0; begin < 1001; begin += 100) {
        const count = Math.min(100, 1001 - begin);
        const placeholders = Array.from({ length: count }, () => "(?,?,?,?,?,?)").join(",");
        const params: Array<string | number> = [];
        for (let i = begin; i < begin + count; i++) {
          params.push(5000 + i, 9000 + i, 1, "new_episode", String(i), "owned item");
        }
        await pool.query("INSERT INTO workspaceEditorialWorkItems VALUES " + placeholders, params);
      }
      let cursor: number | undefined;
      const all: number[] = [];
      for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        const page = await listAuthorWorkspaceWorkItems(101, 1, { limit: 100, cursor });
        all.push(...page.items.map(item => item.workItemId));
        if (page.nextCursor === null) break;
        expect(page.nextCursor).toBeGreaterThan(cursor ?? 0);
        cursor = page.nextCursor;
      }
      expect(all.length).toBe(1002);
      expect(new Set(all).size).toBe(1002);
      expect(all[0]).toBe(2001);
      expect(all[all.length - 1]).toBe(6000);
      await pool.query("UPDATE users SET role='user' WHERE id=101");
      expect((await listAuthorWorkspaceReadModels(101)).items).toEqual([]);
      await expect(getAuthorWorkspaceReadModel(101, 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(getAuthorWorkspaceDraftReadModel(101, 1, 2001))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
      await pool.query("UPDATE users SET role='author' WHERE id=101");
      await pool.query("UPDATE workspaceMembers SET status='removed' WHERE userId=101 AND workspaceId=1");
      expect((await listAuthorWorkspaceReadModels(101)).items).toEqual([]);
      await pool.query("UPDATE workspaceMembers SET status='active' WHERE userId=101 AND workspaceId=1");
      await pool.query("UPDATE workspaceNovels SET status='paused' WHERE id=1");
      expect((await listAuthorWorkspaceReadModels(101)).items).toEqual([]);
      await pool.query("UPDATE workspaceNovels SET status='active' WHERE id=1");
      await pool.query("UPDATE novels SET authorUserId=102 WHERE id=11");
      expect((await listAuthorWorkspaceReadModels(101)).items).toEqual([]);
    } finally {
      __setDbForTests(null);
      await pool.end();
    }
  }, 60000);
});
