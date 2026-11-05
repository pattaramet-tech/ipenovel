/**
 * P2R3B-A support ticket service (R1 hardened).
 *
 * Authorization and lifecycle state transitions come exclusively from the
 * P0 policies (`canReadTicket`, `nextTicketStatus`) - owner isolation uses
 * NOT_FOUND so ticket existence never leaks across accounts, staff replies
 * are admin-only, and re-resolving a resolved ticket conflicts.
 *
 * R1 reply-idempotency contract:
 *  - The reply idempotency fingerprint binds ticketId + action + validated
 *    message, so reusing a key on ANOTHER ticket conflicts instead of
 *    replaying a foreign message id.
 *  - Ownership/authorization is verified BEFORE any replay decision: a
 *    safe retry of an already-delivered reply still replays (no duplicate
 *    message, no repeated state transition), while a fresh reply on a
 *    ticket that has meanwhile moved to a final state conflicts via the
 *    P0 state machine.
 *
 * Every successful transition writes an append-only status event; message
 * redaction is contract-only (an append-only redaction record - the message
 * row itself is never modified). Rate limiting for ticket create/reply is
 * PENDING CONFIGURATION and intentionally NOT enforced here.
 */
import { ticketCreateInput, ticketReplyInput, positiveEntityId } from "../../shared/engagement/contracts";
import {
  canReadTicket,
  isEngagementModerator,
  nextTicketStatus,
  EngagementPolicyError,
  type EngagementActor,
  type TicketAction,
} from "./policies";
import { assertServerActor, runIdempotentMutation } from "./mutationPipeline";
import type {
  EngagementRepository,
  TicketMessageRecord,
  TicketRecord,
  TicketStatusEventRecord,
} from "./engagementRepository";

export interface CreateTicketInput {
  subject: string;
  message: string;
  category: string;
  clientRequestKey?: string;
}

export interface CreateTicketResult {
  ticketId: number;
  status: TicketRecord["status"];
}

export async function createTicket(deps: {
  repo: EngagementRepository;
  actor: EngagementActor;
  input: CreateTicketInput;
  now: number;
}): Promise<CreateTicketResult> {
  const { repo, actor, input, now } = deps;
  assertServerActor(actor);
  // R1: P0 contract validation before any mutation decision
  const parsed = ticketCreateInput.parse(input);
  const { result } = await runIdempotentMutation<CreateTicketResult>({
    repo,
    actorUserId: actor.userId,
    entity: "ticket",
    clientRequestKey: parsed.clientRequestKey,
    canonicalSource: parsed,
    // NOTE: ticket rate limiting is PENDING CONFIGURATION - intentionally
    // no approved limit is enforced here.
    now,
    execute: async (tx) => {
      const ticketId = await tx.tickets.insert({
        ownerUserId: actor.userId,
        subject: parsed.subject,
        category: parsed.category,
        status: "open",
        assignedAdminId: null,
        clientRequestKey: parsed.clientRequestKey ?? null,
      });
      await tx.tickets.insertMessage({
        ticketId,
        actorUserId: actor.userId,
        actorKind: "customer",
        body: parsed.message,
        clientRequestKey: null, // the creation key already covers the first message
      });
      return { ticketId, status: "open" as const };
    },
  });
  return result;
}

export type TicketUserAction = Extract<TicketAction, "customer_reply" | "reopen" | "close">;
export type TicketAdminAction = Extract<TicketAction, "staff_reply" | "resolve" | "reopen" | "close">;

interface TicketMutationCommon {
  repo: EngagementRepository;
  actor: EngagementActor;
  ticketId: number;
  now: number;
}

/**
 * R2: the AUTHORITATIVE ticket authorization gate. It runs INSIDE the
 * mutation transaction before the idempotency lookup, so a non-reader can
 * never receive a stored replay result. It checks READ access only - an
 * owner's safe retry still replays after the ticket has moved on, while a
 * FRESH (non-replay) action still has to pass the P0 state machine below.
 */
async function authorizeTicketReadable(
  tx: Parameters<Parameters<EngagementRepository["withTransaction"]>[0]>[0],
  actor: EngagementActor,
  ticketId: number
): Promise<void> {
  const ticket = await tx.tickets.getById(ticketId);
  const policyTicket = ticket ? { userId: ticket.ownerUserId, status: ticket.status } : null;
  if (!ticket || !policyTicket || !canReadTicket(actor, policyTicket)) {
    throw new EngagementPolicyError("NOT_FOUND");
  }
}

async function transitionTicket<T>(
  deps: TicketMutationCommon & {
    action: TicketAction;
    message?: string;
    clientRequestKey?: string;
    entity: "ticket" | "ticketMessage";
    execute: (
      tx: Parameters<Parameters<EngagementRepository["withTransaction"]>[0]>[0],
      ticket: TicketRecord
    ) => Promise<T>;
  }
): Promise<T> {
  const { repo, actor, ticketId, action, message, clientRequestKey, entity, now, execute } = deps;
  assertServerActor(actor);
  positiveEntityId.parse(ticketId); // R1 runtime id validation
  const { result } = await runIdempotentMutation<T>({
    repo,
    actorUserId: actor.userId,
    entity,
    clientRequestKey,
    // R2: same-transaction authorization before the idempotency lookup
    authorize: (tx) => authorizeTicketReadable(tx, actor, ticketId),
    // R1: fingerprint binds ticketId + action (+ validated message) so a
    // reused key on another ticket conflicts instead of cross-replaying.
    canonicalSource: message !== undefined ? { ticketId, action, message } : { ticketId, action },
    // NOTE: reply rate limiting is PENDING CONFIGURATION - not enforced.
    now,
    execute: async (tx) => {
      const ticket = await tx.tickets.getById(ticketId);
      const policyTicket = ticket ? { userId: ticket.ownerUserId, status: ticket.status } : null;
      if (!ticket || !policyTicket || !canReadTicket(actor, policyTicket)) {
        throw new EngagementPolicyError("NOT_FOUND");
      }
      const fromStatus = ticket.status;
      const toStatus = nextTicketStatus(actor, policyTicket, action);
      const admin = isEngagementModerator(actor);
      await tx.tickets.updateStatus(ticketId, toStatus);
      // a customer reply while already waiting_staff does not change the
      // status - only real transitions get an append-only event
      if (toStatus !== fromStatus) {
        await tx.tickets.insertStatusEvent({
          ticketId,
          fromStatus,
          toStatus,
          actorUserId: actor.userId,
          actorKind: admin ? "staff" : "customer",
        });
      }
      // first staff action claims assignment
      if (admin && ticket.assignedAdminId === null) {
        await tx.tickets.assignAdmin(ticketId, actor.userId);
      }
      return execute(tx, ticket);
    },
  });
  return result;
}

export async function replyTicket(deps: TicketMutationCommon & {
  message: string;
  clientRequestKey?: string;
}): Promise<{ messageId: number; status: TicketRecord["status"] }> {
  const { repo, actor, ticketId, message, clientRequestKey, now } = deps;
  assertServerActor(actor);
  // R1: P0 contract validation (bounded message, positive ticket id, key shape)
  const parsed = ticketReplyInput.parse({ ticketId, message, clientRequestKey });
  const action: TicketAction = isEngagementModerator(actor) ? "staff_reply" : "customer_reply";
  return transitionTicket({
    repo,
    actor,
    ticketId: parsed.ticketId,
    action,
    message: parsed.message,
    clientRequestKey: parsed.clientRequestKey,
    entity: "ticketMessage",
    now,
    execute: async (tx) => {
      const messageId = await tx.tickets.insertMessage({
        ticketId: parsed.ticketId,
        actorUserId: actor.userId,
        actorKind: isEngagementModerator(actor) ? "staff" : "customer",
        body: parsed.message,
        clientRequestKey: parsed.clientRequestKey ?? null,
      });
      const fresh = await tx.tickets.getById(parsed.ticketId);
      return { messageId, status: fresh ? fresh.status : "open" as const };
    },
  });
}

const TICKET_STATUS_ACTIONS: ReadonlySet<string> = new Set(["reopen", "close", "resolve"]);

export async function transitionTicketStatus(deps: TicketMutationCommon & {
  action: "reopen" | "close" | "resolve";
}): Promise<{ ticketId: number; status: TicketRecord["status"] }> {
  const { repo, actor, ticketId, action, now } = deps;
  assertServerActor(actor);
  // R2: strict runtime action validation before any state mutation
  if (!TICKET_STATUS_ACTIONS.has(action)) throw new EngagementPolicyError("FORBIDDEN");
  return transitionTicket({
    repo,
    actor,
    ticketId,
    action,
    entity: "ticket",
    now,
    execute: async (tx) => {
      const fresh = await tx.tickets.getById(ticketId);
      return { ticketId, status: fresh ? fresh.status : "open" as const };
    },
  });
}

export async function getMyTicket(deps: {
  repo: EngagementRepository;
  actor: EngagementActor;
  ticketId: number;
}): Promise<{
  ticket: TicketRecord;
  messages: Array<TicketMessageRecord & { redacted: boolean }>;
  statusEvents: TicketStatusEventRecord[];
}> {
  const { repo, actor, ticketId } = deps;
  assertServerActor(actor);
  positiveEntityId.parse(ticketId);
  return repo.withTransaction(async (tx) => {
    const ticket = await tx.tickets.getById(ticketId);
    const policyTicket = ticket ? { userId: ticket.ownerUserId, status: ticket.status } : null;
    if (!ticket || !policyTicket || !canReadTicket(actor, policyTicket)) {
      throw new EngagementPolicyError("NOT_FOUND");
    }
    const messages = await tx.tickets.listMessages(ticketId);
    const messagesWithRedaction = [];
    for (const message of messages) {
      const redactions = await tx.tickets.listMessageRedactions(message.id);
      messagesWithRedaction.push(
        redactions.length > 0
          ? // redaction record exists -> the body is replaced by a placeholder;
            // the stored row itself is never modified (append-only contract)
            { ...message, body: "[ข้อความถูกลบโดยทีมงาน]", redacted: true }
          : { ...message, redacted: false }
      );
    }
    const statusEvents = await tx.tickets.listStatusEvents(ticketId);
    return { ticket, messages: messagesWithRedaction, statusEvents };
  });
}

export async function listMyTickets(deps: {
  repo: EngagementRepository;
  actor: EngagementActor;
}): Promise<TicketRecord[]> {
  const { repo, actor } = deps;
  assertServerActor(actor);
  return repo.withTransaction((tx) => tx.tickets.listByOwner(actor.userId));
}

export async function redactTicketMessage(deps: {
  repo: EngagementRepository;
  actor: EngagementActor;
  ticketId: number;
  messageId: number;
  reasonCode: string;
  now: number;
}): Promise<void> {
  const { repo, actor, ticketId, messageId, reasonCode, now } = deps;
  assertServerActor(actor);
  positiveEntityId.parse(ticketId);
  positiveEntityId.parse(messageId);
  await repo.withTransaction(async (tx) => {
    if (!isEngagementModerator(actor)) throw new EngagementPolicyError("FORBIDDEN");
    const ticket = await tx.tickets.getById(ticketId);
    if (!ticket) throw new EngagementPolicyError("NOT_FOUND");
    const message = await tx.tickets.getMessage(messageId);
    if (!message || message.ticketId !== ticketId) {
      throw new EngagementPolicyError("NOT_FOUND");
    }
    await tx.tickets.insertMessageRedaction({
      messageId,
      redactedByAdminUserId: actor.userId,
      reasonCode,
    });
  });
}
