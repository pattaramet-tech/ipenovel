import { eq } from "drizzle-orm";
import { users, type User } from "../../drizzle/schema";
import * as db from "../db";
import { isDuplicateKeyError } from "../helpers/databaseErrorClassifier";
import { normalizeProviderName } from "../_core/providerName";

// Google OpenID Connect account-linking policy (AUTH_PROVIDER=google). Kept
// as its own service, separate from server/_core/googleOAuth.ts's route
// handlers, so the linking decision itself (identity found / link by email
// / fail closed on ambiguity / create new) is independently testable
// without any Express req/res or real HTTP.
//
// Each resolution attempt runs inside ONE database transaction (see
// resolveGoogleIdentityAttempt below) so a crash partway through can never
// leave an authIdentities row without its user, a user without its
// identity, or two authIdentities rows pointing at the same (provider,
// providerSubject) - the transaction's own unique constraints are the
// final backstop even if application logic above them has a bug.

export type GoogleIdentityInput = {
  /** Google's `sub` claim - required, must already be a non-empty string (see server/_core/googleOidc.ts's verifyGoogleIdToken, which enforces this before this function is ever called). */
  sub: string;
  /** Google's `email` claim - required, must already be a non-empty, `email_verified: true` value. */
  email: string;
  /** Always `true` when this function is called from the real callback route - verifyGoogleIdToken never returns a claims object otherwise. Accepted as an explicit parameter (rather than assumed) so this function's own fail-closed behavior is directly testable without going through ID-token verification first. */
  emailVerified: boolean;
  name: string | null;
};

export type GoogleIdentityResolution =
  | { outcome: "linked_existing_identity"; user: User }
  | { outcome: "linked_by_email"; user: User }
  | { outcome: "created"; user: User }
  | { outcome: "ambiguous_email" };

type AttemptInput = {
  sub: string;
  email: string;
  normalizedEmail: string;
  name: string | null;
};

/**
 * Updates an existing user's lastSignedIn (always), name (only when Google
 * sent a usable one - never overwrites a real name with nothing), and
 * loginMethod (only when explicitly asked to - see the "linked_by_email"
 * call site below, which sets it; the "identity already existed" call site
 * does not, since it was already set to "google" the first time this
 * account was linked).
 */
async function touchExistingUser(
  tx: any,
  user: User,
  name: string | null,
  opts: { setLoginMethodGoogle?: boolean } = {}
): Promise<void> {
  const updateSet: Record<string, unknown> = { lastSignedIn: new Date() };
  if (name) updateSet.name = name;
  if (opts.setLoginMethodGoogle) updateSet.loginMethod = "google";

  await tx.update(users).set(updateSet).where(eq(users.id, user.id));
}

/**
 * ONE resolution attempt, entirely inside its own fresh `database.transaction(...)`
 * call (a brand-new transaction/connection every time this is invoked - see
 * resolveGoogleIdentity below, which may call this up to twice). Exported
 * for direct testing of a single attempt's logic in isolation from the
 * outer retry loop.
 *
 * Deliberately does NOT catch a duplicate-key error from
 * linkGoogleIdentity/createGoogleUserWithIdentity and re-read inside this
 * same transaction - that used to be this file's approach, but it is
 * unsafe under MariaDB/MySQL's default REPEATABLE READ isolation: a plain
 * SELECT re-run on the SAME transaction after the write failed can still
 * be served from that transaction's original snapshot (taken before the
 * concurrent transaction committed), so it can miss the very row the
 * duplicate-key error proves now exists. Instead, any duplicate-key error
 * is left to propagate out of this function so `database.transaction(...)`
 * itself rolls back cleanly - the caller is responsible for retrying with
 * a brand-new transaction (a brand-new snapshot) if it wants to recover.
 */
export async function resolveGoogleIdentityAttempt(
  database: any,
  input: AttemptInput
): Promise<GoogleIdentityResolution> {
  return await database.transaction(async (tx: any) => {
    // 1. Already linked - use it, never re-derive from email.
    const existingIdentity = await db.getAuthIdentity("google", input.sub, tx);
    if (existingIdentity) {
      const user = await db.getUserById(existingIdentity.userId, tx);
      if (!user) {
        throw new Error("[GoogleIdentity] authIdentities row references a userId that no longer exists");
      }
      await touchExistingUser(tx, user, input.name);
      const refreshed = await db.getUserById(user.id, tx);
      return { outcome: "linked_existing_identity", user: refreshed ?? user };
    }

    // 2/3. No identity yet - resolve by email. Exactly one match links;
    // more than one match fails closed. Neither branch below catches a
    // duplicate-key error - see this function's docstring.
    const candidates = await db.findUsersByNormalizedEmail(input.normalizedEmail, tx);

    if (candidates.length > 1) {
      return { outcome: "ambiguous_email" };
    }

    if (candidates.length === 1) {
      const existingUser = candidates[0];
      // A duplicate-key error here means either (a) a concurrent request
      // for the SAME sub already linked this exact (provider,
      // providerSubject) pair - recoverable by a fresh-snapshot retry
      // finding that committed row - or (b) this user already has a
      // DIFFERENT Google identity linked (authIdentities_userId_provider_unique)
      // - a genuine, persistent conflict that a retry will hit again and
      // must fail closed on. This function does not need to (and must
      // not try to) tell the two apart - it just lets the error propagate
      // either way; resolveGoogleIdentity's retry loop, by re-running this
      // ENTIRE attempt from scratch on a new transaction, naturally
      // resolves (a) and naturally re-fails (b), because (b)'s conflicting
      // row is still there on the second attempt too.
      await db.linkGoogleIdentity({ userId: existingUser.id, providerSubject: input.sub, email: input.email }, tx);
      await touchExistingUser(tx, existingUser, input.name, { setLoginMethodGoogle: true });
      const linkedUser = await db.getUserById(existingUser.id, tx);
      if (!linkedUser) {
        throw new Error("[GoogleIdentity] Linked user disappeared inside its own transaction");
      }
      return { outcome: "linked_by_email", user: linkedUser };
    }

    // 4. No identity, no matching user - create a new account. A
    // duplicate-key error here (either on users.openId - two concurrent
    // creates for the SAME sub race on the same computeGoogleOpenId hash -
    // or, astronomically unlikely, a genuine SHA-256 collision between two
    // DIFFERENT subs) is likewise left to propagate, for the same reason
    // as above.
    const user = await db.createGoogleUserWithIdentity(
      { providerSubject: input.sub, email: input.email, name: input.name },
      tx
    );
    return { outcome: "created", user };
  });
}

const MAX_RESOLUTION_ATTEMPTS = 2;

/**
 * Resolves a verified Google identity to exactly one ipenovel `users` row,
 * per this policy:
 *
 *  1. An authIdentities row already exists for (google, sub) -> use its
 *     user as-is. Never re-checked against email at this point - the
 *     identity link, once made, is authoritative.
 *  2. No identity yet, and exactly one existing user's email
 *     (case-insensitively) matches -> link this Google identity to that
 *     user. users.id and users.openId are never changed.
 *  3. No identity yet, and MORE THAN ONE existing user shares this email
 *     -> FAIL CLOSED. Never auto-links, never picks a row, never creates a
 *     new account (a third option that would make the ambiguity worse).
 *  4. No identity, no existing user by email -> create a new user (openId
 *     derived from the sub via db.ts's computeGoogleOpenId - never the
 *     raw sub directly, which can be up to 255 chars against a 64-char
 *     openId column) and its identity row, atomically.
 *
 * Concurrent logins (two tabs, a double click, a network retry) are
 * handled by retrying the WHOLE attempt above - never a re-read inside
 * the failed transaction - on a brand-new transaction/snapshot, up to
 * MAX_RESOLUTION_ATTEMPTS (2) times total. If a duplicate-key error is
 * still hit on the final attempt, this function throws - never returns a
 * "logged in" outcome for it, no unbounded retry loop. See
 * resolveGoogleIdentityAttempt's docstring for why a same-transaction
 * re-read is unsafe under REPEATABLE READ and was removed.
 *
 * Also throws if: sub/email/emailVerified fail validation, the database
 * is unavailable, or any unexpected (non-duplicate-key) database error
 * occurs. Callers (googleOAuth.ts) must never mint a session unless this
 * function returns one of the three successful outcomes above.
 */
export async function resolveGoogleIdentity(input: GoogleIdentityInput): Promise<GoogleIdentityResolution> {
  if (!input.sub || input.sub.trim().length === 0) {
    throw new Error("[GoogleIdentity] Google sub claim is required to resolve an identity");
  }
  if (!input.emailVerified) {
    throw new Error("[GoogleIdentity] Google email is not verified - refusing to log in, link, or create an account");
  }
  const trimmedEmail = input.email.trim();
  if (!trimmedEmail) {
    throw new Error("[GoogleIdentity] Google email claim is required to resolve an identity");
  }
  const normalizedEmail = trimmedEmail.toLowerCase();
  const name = normalizeProviderName(input.name);

  await db.assertDatabaseAvailable();
  const database = await db.getDb();
  if (!database) {
    // assertDatabaseAvailable() above should already have thrown - this is
    // an unreachable-in-practice defensive check, not a real second path.
    throw new Error("[GoogleIdentity] Database is not available");
  }

  const attemptInput: AttemptInput = { sub: input.sub, email: trimmedEmail, normalizedEmail, name };

  for (let attempt = 1; attempt <= MAX_RESOLUTION_ATTEMPTS; attempt++) {
    try {
      // Every call starts a genuinely NEW transaction (a new snapshot, a
      // new underlying connection/tx object) - see
      // resolveGoogleIdentityAttempt above. Nothing about attempt 1's
      // failed transaction is reused here.
      return await resolveGoogleIdentityAttempt(database, attemptInput);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      if (attempt >= MAX_RESOLUTION_ATTEMPTS) {
        // Fail closed: still a duplicate on a fresh snapshot after a full
        // retry - either a persistent conflict (e.g. this user already
        // has a different Google identity linked) or a genuinely
        // pathological race that outlasted one retry. Never treated as a
        // successful login; never mints a session; never creates a
        // duplicate user/identity, since the failing INSERT's own
        // transaction was rolled back.
        throw error;
      }
      // Fall through to the next loop iteration - attempt 1's transaction
      // has already been rolled back by database.transaction() itself
      // (it only rejects after issuing ROLLBACK), so there is nothing
      // left to clean up before trying again.
    }
  }

  // Unreachable (the loop above always either returns or throws), kept
  // only so this function's return type is provably total to the
  // compiler without a non-null assertion.
  throw new Error("[GoogleIdentity] Exhausted resolution attempts without a result");
}
