import { createHmac, timingSafeEqual } from "node:crypto";

/** Cursor is signed, NOT encrypted; never include private content or tokens. */
export type InboxCategoryFilter = "all" | "finance" | "novel" | "engagement";

interface CursorBody {
  v: 1;
  u: number;
  c: InboxCategoryFilter;
  r: boolean;
  s: string;
  i: number;
  e: number;
}
export interface InboxCursorPosition {
  /** Server obtains actorUserId from ctx.user.id, never a user-supplied input. */
  actorUserId: number;
  category: InboxCategoryFilter;
  unreadOnly: boolean;
  beforeSequence: bigint;
}

const CURSOR_TTL_MS = 10 * 60_000;
const MAX_CURSOR_BYTES = 450;
const BAD_CURSOR = "Invalid or expired notification cursor";

function validActor(id: number): boolean {
  return Number.isSafeInteger(id) && id > 0;
}
function validCategory(value: unknown): value is InboxCategoryFilter {
  return value === "all" || value === "finance" || value === "novel" || value === "engagement";
}
function safeKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.byteLength < 32) {
    throw new Error("Notification cursor key must contain at least 32 random bytes");
  }
}
function sign(encodedPayload: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(encodedPayload).digest();
}

/**
 * Sign a descending-sequence position for a single authenticated actor and
 * category and unread-only filter. A next-page link always uses a new server-generated token.
 */
export function encodeInboxCursor(
  position: InboxCursorPosition,
  key: Buffer,
  now: Date,
): string {
  safeKey(key);
  if (!validActor(position.actorUserId) || !validCategory(position.category) ||
      typeof position.unreadOnly !== "boolean" ||
      position.beforeSequence < BigInt(1) || Number.isNaN(now.getTime())) {
    throw new Error("Invalid notification cursor position");
  }
  const issued = Math.floor(now.getTime() / 1000);
  const payload: CursorBody = {
    v: 1,
    u: position.actorUserId,
    c: position.category,
    r: position.unreadOnly,
    s: String(position.beforeSequence),
    i: issued,
    e: issued + Math.floor(CURSOR_TTL_MS / 1000),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded, key).toString("base64url")}`;
}

/**
 * Verify before decoding payload. Comparison is timing-safe, actor-scoped and
 * category/unread-only scoped. Invalid cursor errors never echo user input or secrets.
 */
export function decodeInboxCursor(
  raw: string,
  actorUserId: number,
  category: InboxCategoryFilter,
  unreadOnly: boolean,
  key: Buffer,
  now: Date,
): InboxCursorPosition {
  safeKey(key);
  if (!validActor(actorUserId) || !validCategory(category) ||
      typeof unreadOnly !== "boolean" || typeof raw !== "string" || raw.length < 20 || raw.length > MAX_CURSOR_BYTES ||
      Number.isNaN(now.getTime())) {
    throw new Error(BAD_CURSOR);
  }
  const parts = raw.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
      !/^[A-Za-z0-9_-]+$/.test(parts[1])) {
    throw new Error(BAD_CURSOR);
  }
  const expected = sign(parts[0], key);
  const actual = Buffer.from(parts[1], "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) {
    throw new Error(BAD_CURSOR);
  }
  let payload: CursorBody;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as CursorBody;
  } catch {
    throw new Error(BAD_CURSOR);
  }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (payload.v !== 1 || payload.u !== actorUserId || payload.c !== category ||
      typeof payload.r !== "boolean" || payload.r !== unreadOnly ||
      !Number.isSafeInteger(payload.i) || !Number.isSafeInteger(payload.e) ||
      payload.i > nowSeconds + 5 || nowSeconds > payload.e ||
      payload.e - payload.i !== Math.floor(CURSOR_TTL_MS / 1000) ||
      typeof payload.s !== "string" || !/^[1-9][0-9]{0,38}$/.test(payload.s)) {
    throw new Error(BAD_CURSOR);
  }
  const beforeSequence = BigInt(payload.s);
  // The DB column is unsigned 64-bit; do not allow arbitrarily large values.
  if (beforeSequence > BigInt("18446744073709551615")) throw new Error(BAD_CURSOR);
  return { actorUserId, category, unreadOnly, beforeSequence };
}
