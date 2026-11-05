import { describe, expect, it } from "vitest";
import { InMemoryEngagementRepository } from "./engagementRepository.mock";
import {
  createTicket,
  replyTicket,
  transitionTicketStatus,
  getMyTicket,
  listMyTickets,
  redactTicketMessage,
} from "./supportService";
import { EngagementPolicyError } from "./policies";

const owner = { userId: 7, role: "user" as const };
const stranger = { userId: 8, role: "user" as const };
const author = { userId: 9, role: "author" as const };
const admin = { userId: 1, role: "admin" as const };
const createInput = {
  subject: "Payment could not complete",
  category: "payment",
  message: "Transaction failed twice",
};

describe("supportService", () => {
  it("R2: role downgrade revokes replay - a demoted staff retrying their reply gets NOT_FOUND, never the stored result", async () => {
    const repo = new InMemoryEngagementRepository();
    const t1 = await createTicket({ repo, actor: owner, input: createInput, now: 1_000 });
    const staff = { userId: 1, role: "admin" as const };
    const key = "staff_reply_key_0001";
    await replyTicket({ repo, actor: staff, ticketId: t1.ticketId, message: "staff answer", clientRequestKey: key, now: 2_000 });

    // the staff account is demoted to a plain user before the retry
    const demoted = { userId: 1, role: "user" as const };
    await expect(
      replyTicket({ repo, actor: demoted, ticketId: t1.ticketId, message: "staff answer", clientRequestKey: key, now: 3_000 })
    ).rejects.toThrowError(new EngagementPolicyError("NOT_FOUND"));
    // no new message was written for the demoted account
    const view = await getMyTicket({ repo, actor: owner, ticketId: t1.ticketId });
    expect(view.messages.filter((m) => m.body === "staff answer")).toHaveLength(1); // only the original
    expect(view.messages.every((m) => m.actorUserId !== demoted.userId || m.actorKind === "staff")).toBe(true);
  });

  it("R2: unknown ticket status action is rejected with NO state change", async () => {
    const repo = new InMemoryEngagementRepository();
    const created = await createTicket({ repo, actor: owner, input: createInput, now: 1_000 });
    await expect(
      transitionTicketStatus({
        repo,
        actor: admin,
        ticketId: created.ticketId,
        action: "banana" as unknown as "reopen" | "close" | "resolve",
        now: 2_000,
      })
    ).rejects.toThrowError(new EngagementPolicyError("FORBIDDEN"));
    const view = await getMyTicket({ repo, actor: owner, ticketId: created.ticketId });
    expect(view.ticket.status).toBe("open"); // unchanged
    expect(view.statusEvents).toHaveLength(0); // no event
  });

  it("R1: same reply key reused on ANOTHER ticket -> CONFLICT (never replays the other ticket's message id)", async () => {
    const repo = new InMemoryEngagementRepository();
    const t1 = await createTicket({ repo, actor: owner, input: createInput, now: 1_000 });
    const t2 = await createTicket({ repo, actor: owner, input: { ...createInput, subject: "Second issue" }, now: 1_500 });
    const key = "reply_key_shared_0001";
    const first = await replyTicket({ repo, actor: owner, ticketId: t1.ticketId, message: "on ticket one", clientRequestKey: key, now: 2_000 });
    await expect(
      replyTicket({ repo, actor: owner, ticketId: t2.ticketId, message: "on ticket one", clientRequestKey: key, now: 2_500 })
    ).rejects.toThrowError(new EngagementPolicyError("CONFLICT"));
    // ticket 2 must NOT contain ticket 1's message
    const t2view = await getMyTicket({ repo, actor: owner, ticketId: t2.ticketId });
    expect(t2view.messages.every((m) => m.body !== "on ticket one")).toBe(true);
    expect(first.messageId).not.toBe(t2view.messages.at(-1)?.id);
  });

  it("R1: authorization runs BEFORE replay - a stranger retrying with a stolen key is NOT_FOUND, not a replay", async () => {
    const repo = new InMemoryEngagementRepository();
    const t1 = await createTicket({ repo, actor: owner, input: createInput, now: 1_000 });
    const key = "reply_key_stolen_01";
    const delivered = await replyTicket({ repo, actor: owner, ticketId: t1.ticketId, message: "secret reply", clientRequestKey: key, now: 2_000 });
    await expect(
      replyTicket({ repo, actor: stranger, ticketId: t1.ticketId, message: "secret reply", clientRequestKey: key, now: 3_000 })
    ).rejects.toThrowError(new EngagementPolicyError("NOT_FOUND"));
    // and the ticket has no new message from the stranger
    const view = await getMyTicket({ repo, actor: owner, ticketId: t1.ticketId });
    expect(view.messages.filter((m) => m.actorUserId === stranger.userId)).toHaveLength(0);
    expect(delivered.messageId).toBeGreaterThan(0);
  });

  it("R1: safe retry after the ticket moved on replays the delivered message (no duplicate message, no repeated transition)", async () => {
    const repo = new InMemoryEngagementRepository();
    const t1 = await createTicket({ repo, actor: owner, input: createInput, now: 1_000 });
    const key = "reply_retry_safe_001";
    const first = await replyTicket({ repo, actor: owner, ticketId: t1.ticketId, message: "details", clientRequestKey: key, now: 2_000 });
    expect(first.status).toBe("waiting_staff");
    // staff responds; ticket is now waiting_user
    await replyTicket({ repo, actor: admin, ticketId: t1.ticketId, message: "answered", now: 3_000 });
    // the client retries the SAME delivered reply (network flake): must replay
    const retry = await replyTicket({ repo, actor: owner, ticketId: t1.ticketId, message: "details", clientRequestKey: key, now: 4_000 });
    expect(retry).toEqual(first);
    const view = await getMyTicket({ repo, actor: owner, ticketId: t1.ticketId });
    expect(view.messages.filter((m) => m.body === "details")).toHaveLength(1); // no duplicate
    const replyEvents = view.statusEvents.filter((e) => e.toStatus === "waiting_staff");
    expect(replyEvents).toHaveLength(1); // transition not repeated
    // but a FRESH reply (new key) on the waiting_user ticket still works via the state machine
    const fresh = await replyTicket({ repo, actor: owner, ticketId: t1.ticketId, message: "one more thing", now: 5_000 });
    expect(fresh.status).toBe("waiting_staff");
  });

  it("R1: runtime validation rejects malformed ids/messages/keys before storage (TypeScript cannot guard these)", async () => {
    const repo = new InMemoryEngagementRepository();
    const created = await createTicket({ repo, actor: owner, input: createInput, now: 1_000 });
    for (const badTicketId of [0, -1, 1.5, Number.NaN]) {
      await expect(
        replyTicket({ repo, actor: owner, ticketId: badTicketId, message: "x".repeat(10), now: 2_000 })
      ).rejects.toThrow();
    }
    for (const bad of [
      { message: "  " },
      { message: "injected\u0000char" },
      { message: "a".repeat(10001) },
      { message: "ok", clientRequestKey: "short" },
    ]) {
      await expect(
        replyTicket({ repo, actor: owner, ticketId: created.ticketId, ...bad, now: 2_000 })
      ).rejects.toThrow();
    }
    await expect(
      createTicket({ repo, actor: owner, input: { ...createInput, category: "moderation" }, now: 2_000 })
    ).rejects.toThrow();
    // nothing was written
    expect(await listMyTickets({ repo, actor: owner })).toHaveLength(1);
  });

  it("happy path: create opens a ticket with the first customer message", async () => {
    const repo = new InMemoryEngagementRepository();
    const created = await createTicket({ repo, actor: owner, input: createInput, now: 1_000 });
    expect(created.status).toBe("open");
    const mine = await listMyTickets({ repo, actor: owner });
    expect(mine).toHaveLength(1);
    const view = await getMyTicket({ repo, actor: owner, ticketId: created.ticketId });
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0].actorKind).toBe("customer");
    expect(view.statusEvents).toHaveLength(0); // creation is not a transition
  });

  it("owner isolation: a stranger's ticket is NOT_FOUND for read and reply", async () => {
    const repo = new InMemoryEngagementRepository();
    const created = await createTicket({ repo, actor: owner, input: createInput, now: 1_000 });
    await expect(getMyTicket({ repo, actor: stranger, ticketId: created.ticketId })).rejects.toThrowError(
      new EngagementPolicyError("NOT_FOUND")
    );
    await expect(
      replyTicket({ repo, actor: stranger, ticketId: created.ticketId, message: "hijack", now: 2_000 })
    ).rejects.toThrowError(new EngagementPolicyError("NOT_FOUND"));
  });

  it("customer reply -> waiting_staff with an append-only status event", async () => {
    const repo = new InMemoryEngagementRepository();
    const created = await createTicket({ repo, actor: owner, input: createInput, now: 1_000 });
    const reply = await replyTicket({
      repo, actor: owner, ticketId: created.ticketId, message: "more detail", now: 2_000,
    });
    expect(reply.status).toBe("waiting_staff");
    const view = await getMyTicket({ repo, actor: owner, ticketId: created.ticketId });
    expect(view.messages).toHaveLength(2);
    expect(view.statusEvents).toEqual([
      expect.objectContaining({ fromStatus: "open", toStatus: "waiting_staff", actorUserId: 7, actorKind: "customer" }),
    ]);
  });

  it("staff reply is admin-only (author cannot impersonate staff) and claims assignment", async () => {
    const repo = new InMemoryEngagementRepository();
    const created = await createTicket({ repo, actor: owner, input: createInput, now: 1_000 });
    await replyTicket({ repo, actor: owner, ticketId: created.ticketId, message: "detail", now: 2_000 });

    // author reads the ticket? NO - author is a stranger to it: NOT_FOUND first
    await expect(
      replyTicket({ repo, actor: author, ticketId: created.ticketId, message: "staff here", now: 3_000 })
    ).rejects.toThrowError(new EngagementPolicyError("NOT_FOUND"));

    const staffReply = await replyTicket({
      repo, actor: admin, ticketId: created.ticketId, message: "we are on it", now: 3_000,
    });
    expect(staffReply.status).toBe("waiting_user");
    const view = await getMyTicket({ repo, actor: admin, ticketId: created.ticketId });
    expect(view.ticket.assignedAdminId).toBe(admin.userId);
    expect(view.statusEvents.at(-1)).toEqual(
      expect.objectContaining({ toStatus: "waiting_user", actorKind: "staff" })
    );
  });

  it("full lifecycle: resolve -> closed; re-resolve CONFLICT; reopen/close guards; customer replies blocked after final states", async () => {
    const repo = new InMemoryEngagementRepository();
    const created = await createTicket({ repo, actor: owner, input: createInput, now: 1_000 });
    await replyTicket({ repo, actor: owner, ticketId: created.ticketId, message: "detail", now: 2_000 });
    await replyTicket({ repo, actor: admin, ticketId: created.ticketId, message: "on it", now: 2_500 });

    const resolved = await transitionTicketStatus({
      repo, actor: admin, ticketId: created.ticketId, action: "resolve", now: 3_000,
    });
    expect(resolved.status).toBe("resolved");

    // duplicate resolution -> CONFLICT (no duplicate resolution event)
    await expect(
      transitionTicketStatus({ repo, actor: admin, ticketId: created.ticketId, action: "resolve", now: 4_000 })
    ).rejects.toThrowError(new EngagementPolicyError("CONFLICT"));

    await expect(
      replyTicket({ repo, actor: owner, ticketId: created.ticketId, message: "late reply", now: 4_000 })
    ).rejects.toThrowError(new EngagementPolicyError("CONFLICT"));

    const closed = await transitionTicketStatus({
      repo, actor: owner, ticketId: created.ticketId, action: "close", now: 5_000,
    });
    expect(closed.status).toBe("closed");

    // reopen from closed -> open (owner may reopen)
    const reopened = await transitionTicketStatus({
      repo, actor: owner, ticketId: created.ticketId, action: "reopen", now: 6_000,
    });
    expect(reopened.status).toBe("open");
    await expect(
      transitionTicketStatus({ repo, actor: owner, ticketId: created.ticketId, action: "close", now: 7_000 })
    ).rejects.toThrowError(new EngagementPolicyError("CONFLICT")); // close only from resolved

    const events = (await getMyTicket({ repo, actor: admin, ticketId: created.ticketId })).statusEvents;
    expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
      ["open", "waiting_staff"],
      ["waiting_staff", "waiting_user"],
      ["waiting_user", "resolved"],
      ["resolved", "closed"],
      ["closed", "open"],
    ]);
  });

  it("reply idempotency: same key+payload replays without a duplicate message", async () => {
    const repo = new InMemoryEngagementRepository();
    const created = await createTicket({ repo, actor: owner, input: createInput, now: 1_000 });
    const key = "reply_token_0000001";
    const first = await replyTicket({
      repo, actor: owner, ticketId: created.ticketId, message: "details", clientRequestKey: key, now: 2_000,
    });
    const second = await replyTicket({
      repo, actor: owner, ticketId: created.ticketId, message: "details", clientRequestKey: key, now: 3_000,
    });
    expect(second).toEqual(first);
    const view = await getMyTicket({ repo, actor: owner, ticketId: created.ticketId });
    expect(view.messages).toHaveLength(2); // creation message + ONE replayed reply
  });

  it("redaction contract: admin redaction adds an append-only record; message row untouched; display shows placeholder; non-admin FORBIDDEN", async () => {
    const repo = new InMemoryEngagementRepository();
    const created = await createTicket({ repo, actor: owner, input: createInput, now: 1_000 });
    const viewBefore = await getMyTicket({ repo, actor: owner, ticketId: created.ticketId });
    const messageId = viewBefore.messages[0].id;

    await expect(
      redactTicketMessage({ repo, actor: owner, ticketId: created.ticketId, messageId, reasonCode: "pii", now: 2_000 })
    ).rejects.toThrowError(new EngagementPolicyError("FORBIDDEN"));

    await redactTicketMessage({ repo, actor: admin, ticketId: created.ticketId, messageId, reasonCode: "pii", now: 2_000 });

    const viewAfter = await getMyTicket({ repo, actor: owner, ticketId: created.ticketId });
    expect(viewAfter.messages[0].body).toBe("[ข้อความถูกลบโดยทีมงาน]");
    expect(viewAfter.messages[0].redacted).toBe(true);
    // raw row untouched (append-only redaction contract)
    const raw = await repo.tickets.getMessage(messageId);
    expect(raw?.body).toBe(createInput.message);
    expect((await repo.tickets.listMessageRedactions(messageId)).length).toBe(1);
  });

  it("ticket create/reply rate limiting is PENDING CONFIGURATION: many mutations are not blocked", async () => {
    const repo = new InMemoryEngagementRepository();
    for (let i = 0; i < 6; i++) {
      await createTicket({ repo, actor: owner, input: { ...createInput, subject: `ticket ${i}` }, now: 1_000 });
    }
    expect(await listMyTickets({ repo, actor: owner })).toHaveLength(6);
  });
});
