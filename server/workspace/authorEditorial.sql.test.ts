import { describe, expect, it } from "vitest";
import { createPool, type Pool, type PoolConnection } from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { __setDbForTests } from "../db";
import { assertAuthorEditorialWrite } from "./authorEditorialGrant";

const fixture = process.env.IPE070_R4B_TEST_DB_URL;
const accepted = fixture && (() => {
  try {
    const url = new URL(fixture);
    return url.protocol === "mysql:" && url.hostname === "127.0.0.1" &&
      url.port === "3337" && url.pathname === "/ipe070_r4b_scratch";
  } catch {
    return false;
  }
})();
if (fixture && !accepted) throw new Error("REFUSED: unsafe integration database target");

const scope = { actorUserId: 101, workspaceId: 1, workItemId: 2001 };

async function seed(pool: Pool) {
  const drops = [
    "workspaceEditorialWorkItems",
    "workspaceNovels",
    "workspaceMembers",
    "novels",
    "workspaceWorkspaces",
    "users",
  ];
  for (const table of drops) await pool.query(`DROP TABLE IF EXISTS ${table}`);
  const ddl = [
    "CREATE TABLE users (id int PRIMARY KEY, role enum('user','author','admin') NOT NULL, name varchar(255) NULL, openId varchar(64) NOT NULL)",
    "CREATE TABLE workspaceWorkspaces (id int PRIMARY KEY, name varchar(160) NOT NULL, ownerUserId int NOT NULL, status enum('active','suspended','archived') NOT NULL, deletedAt datetime NULL)",
    "CREATE TABLE workspaceMembers (id int PRIMARY KEY, workspaceId int NOT NULL, userId int NOT NULL, role enum('owner','editor','reviewer','viewer') NOT NULL, status enum('active','invited','suspended','removed') NOT NULL)",
    "CREATE TABLE novels (id int PRIMARY KEY, authorUserId int NULL, title varchar(500) NOT NULL)",
    "CREATE TABLE workspaceNovels (id int PRIMARY KEY, workspaceId int NOT NULL, novelId int NOT NULL, status enum('active','paused','unlinked') NOT NULL)",
    "CREATE TABLE workspaceEditorialWorkItems (id int PRIMARY KEY, workspaceNovelId int NOT NULL)",
  ];
  for (const sql of ddl) await pool.query(sql);
  const rows = [
    "INSERT INTO users VALUES (101,'author','A','a'),(102,'author','B','b'),(103,'user','R','r'),(104,'admin','Admin','admin')",
    "INSERT INTO workspaceWorkspaces VALUES (1,'Shared',104,'active',NULL),(2,'Archived',104,'archived',NULL)",
    "INSERT INTO workspaceMembers VALUES (1,1,101,'editor','active'),(2,1,102,'editor','active'),(3,2,101,'owner','active')",
    "INSERT INTO novels VALUES (11,101,'A own'),(12,102,'B private')",
    "INSERT INTO workspaceNovels VALUES (1,1,11,'active'),(2,1,12,'active'),(3,2,11,'active')",
    "INSERT INTO workspaceEditorialWorkItems VALUES (2001,1),(2002,2),(2003,3)",
  ];
  for (const sql of rows) await pool.query(sql);
}

describe("IPE-070R4B author editorial SQL grant", () => {
  it.skipIf(!accepted)("allows only the owning editor and fails closed after revocation or transfer", async () => {
    const pool = createPool(fixture!);
    const db = drizzle(pool);
    __setDbForTests(db);
    try {
      await seed(pool);
      await expect(assertAuthorEditorialWrite(db, scope)).resolves.toBeUndefined();
      await expect(assertAuthorEditorialWrite(db, scope)).resolves.toBeUndefined();
      await expect(assertAuthorEditorialWrite(db, { actorUserId: 102, workspaceId: 1, workItemId: 2001 }))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(assertAuthorEditorialWrite(db, { actorUserId: 101, workspaceId: 1, workItemId: 2002 }))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(assertAuthorEditorialWrite(db, { actorUserId: 101, workspaceId: 2, workItemId: 2001 }))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(assertAuthorEditorialWrite(db, { actorUserId: 103, workspaceId: 1, workItemId: 2001 }))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(assertAuthorEditorialWrite(db, { actorUserId: 104, workspaceId: 1, workItemId: 2001 }))
        .rejects.toMatchObject({ code: "NOT_FOUND" });

      await pool.query("UPDATE workspaceMembers SET role='viewer' WHERE id=1");
      await expect(assertAuthorEditorialWrite(db, scope)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await pool.query("UPDATE workspaceMembers SET role='editor' WHERE id=1");

      await pool.query("UPDATE workspaceMembers SET status='removed' WHERE id=1");
      await expect(assertAuthorEditorialWrite(db, scope)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await pool.query("UPDATE workspaceMembers SET status='active' WHERE id=1");

      await pool.query("UPDATE users SET role='user' WHERE id=101");
      await expect(assertAuthorEditorialWrite(db, scope)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await pool.query("UPDATE users SET role='author' WHERE id=101");

      await pool.query("UPDATE workspaceNovels SET status='paused' WHERE id=1");
      await expect(assertAuthorEditorialWrite(db, scope)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await pool.query("UPDATE workspaceNovels SET status='active' WHERE id=1");

      await pool.query("UPDATE workspaceWorkspaces SET status='archived' WHERE id=1");
      await expect(assertAuthorEditorialWrite(db, scope)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await pool.query("UPDATE workspaceWorkspaces SET status='active' WHERE id=1");

      await pool.query("UPDATE novels SET authorUserId=102 WHERE id=11");
      await expect(assertAuthorEditorialWrite(db, scope)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await pool.query("UPDATE novels SET authorUserId=101 WHERE id=11");
      await expect(assertAuthorEditorialWrite(db, scope, { lock: true })).resolves.toBeUndefined();
    } finally {
      __setDbForTests(null);
      await pool.end();
    }
  }, 60000);

  it.skipIf(!accepted)("a transfer that commits under the novel lock rejects the waiting author write", async () => {
    const pool = createPool(fixture!);
    const db = drizzle(pool);
    __setDbForTests(db);
    let holder: PoolConnection | null = null;
    try {
      await seed(pool);
      holder = await pool.getConnection();
      await holder.beginTransaction();
      await holder.query("SELECT id FROM novels WHERE id=11 FOR UPDATE");
      await holder.query("UPDATE novels SET authorUserId=102 WHERE id=11");
      let finished = false;
      const pending = db.transaction(async (tx) => {
        await assertAuthorEditorialWrite(
          tx,
          scope,
          { lock: true },
        );
      }).finally(() => {
        finished = true;
      });
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(finished).toBe(false);
      await holder.commit();
      holder.release();
      holder = null;
      await expect(pending).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      if (holder) {
        await holder.rollback();
        holder.release();
      }
      __setDbForTests(null);
      await pool.end();
    }
  }, 60000);

  it.skipIf(!accepted)("an author write waits on the work item and then locks the user row", async () => {
    const pool = createPool(fixture!);
    const db = drizzle(pool);
    __setDbForTests(db);
    let holder: PoolConnection | null = null;
    try {
      await seed(pool);
      holder = await pool.getConnection();
      await holder.beginTransaction();
      await holder.query("SELECT id FROM workspaceEditorialWorkItems WHERE id=2001 FOR UPDATE");
      let failure: unknown = null;
      const pending = db.transaction(async (tx) => {
        await assertAuthorEditorialWrite(tx, scope, { lock: true });
      }).catch((error) => {
        failure = error;
      });
      const started = Date.now();
      let waiting = false;
      while (Date.now() - started < 5000) {
        const [rows] = await pool.query(
          "SELECT COUNT(*) AS waiting FROM performance_schema.data_lock_waits",
        ) as unknown as [Array<{ waiting: number }>];
        if (Number(rows[0]?.waiting ?? 0) > 0) {
          waiting = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(waiting).toBe(true);
      await holder.query("SELECT id FROM users WHERE id=101 FOR UPDATE");
      await holder.rollback();
      holder.release();
      holder = null;
      await pending;
      expect(failure).toBeNull();
    } finally {
      if (holder) {
        await holder.rollback();
        holder.release();
      }
      __setDbForTests(null);
      await pool.end();
    }
  }, 60000);
});
