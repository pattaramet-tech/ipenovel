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
// The whole decision runs inside ONE database transaction (see
// resolveGoogleIdentity below) so a crash partway through can never leave
// an authIdentities row without its user, a user without its identity, or
// two authIdentities rows pointing at the same (provider, providerSubject)
// - the transaction's own unique constraints are the final backstop even
// if application logic above them has a bug.

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
 *     `google:<sub>`) and its identity row, atomically.
 *
 * Concurrent logins for the same Google account (two tabs, a double
 * click, a network retry) are handled by catching a unique-constraint
 * violation on the identity insert and re-reading instead of erroring or
 * creating a duplicate - see isDuplicateKeyError usage below.
 *
 * Throws (never returns a "logged in" outcome) if: sub/email/emailVerified
 * fail validation, the database is unavailable, or any unexpected
 * (non-duplicate-key) database error occurs. Callers (googleOAuth.ts) must
 * never mint a session unless this function returns one of the three
 * successful outcomes above.
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

  return await database.transaction(async (tx: any) => {
    // 1. Already linked - use it, never re-derive from email.
    const existingIdentity = await db.getAuthIdentity("google", input.sub, tx);
    if (existingIdentity) {
      const user = await db.getUserById(existingIdentity.userId, tx);
      if (!user) {
        throw new Error("[GoogleIdentity] authIdentities row references a userId that no longer exists");
      }
      await touchExistingUser(tx, user, name);
      const refreshed = await db.getUserById(user.id, tx);
      return { outcome: "linked_existing_identity", user: refreshed ?? user };
    }

    // 2/3. No identity yet - resolve by email. Exactly one match links;
    // more than one match fails closed.
    const candidates = await db.findUsersByNormalizedEmail(normalizedEmail, tx);

    if (candidates.length > 1) {
      return { outcome: "ambiguous_email" };
    }

    if (candidates.length === 1) {
      const existingUser = candidates[0];
      try {
        await db.linkGoogleIdentity({ userId: existingUser.id, providerSubject: input.sub, email: trimmedEmail }, tx);
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        // A concurrent request already linked this exact (provider,
        // providerSubject) or (userId, provider) pair - re-read instead of
        // erroring or creating a duplicate.
        const raceIdentity = await db.getAuthIdentity("google", input.sub, tx);
        if (!raceIdentity) throw error;
        const user = await db.getUserById(raceIdentity.userId, tx);
        if (!user) throw error;
        await touchExistingUser(tx, user, name);
        const refreshed = await db.getUserById(user.id, tx);
        return { outcome: "linked_by_email", user: refreshed ?? user };
      }
      await touchExistingUser(tx, existingUser, name, { setLoginMethodGoogle: true });
      const linkedUser = await db.getUserById(existingUser.id, tx);
      if (!linkedUser) {
        throw new Error("[GoogleIdentity] Linked user disappeared inside its own transaction");
      }
      return { outcome: "linked_by_email", user: linkedUser };
    }

    // 4. No identity, no matching user - create a new account.
    try {
      const user = await db.createGoogleUserWithIdentity({ providerSubject: input.sub, email: trimmedEmail, name }, tx);
      return { outcome: "created", user };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      // Concurrent duplicate-create race on the SAME sub - someone else's
      // request won; re-read instead of retrying the insert or surfacing
      // an error to this user.
      const raceIdentity = await db.getAuthIdentity("google", input.sub, tx);
      if (!raceIdentity) throw error;
      const user = await db.getUserById(raceIdentity.userId, tx);
      if (!user) throw error;
      return { outcome: "linked_existing_identity", user };
    }
  });
}
