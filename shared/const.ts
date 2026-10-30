export const COOKIE_NAME = "app_session_id";
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';

// Single source of truth for how long a session lasts - both the JWT `exp`
// claim (jose/JWT convention: seconds since epoch) and the session cookie's
// `maxAge` (Express/`cookie` convention: milliseconds) must be derived from
// this, never hard-coded independently, so signing and cookie issuance can
// never silently drift apart. See server/_core/sdk.ts (signing) and
// server/_core/oauth.ts / server/routers.ts (cookie maxAge).
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;

// Fixed, server-controlled JWT issuer. Must never be derived from the
// request Host or any client-controlled header - that would let a client
// mint its own "valid" issuer simply by changing what it sends.
export const SESSION_JWT_ISSUER = "ipenovel-session";

// ============ READER SESSION CONTROLS (R2) ============
// Defaults to evaluate; the Owner may tune via these constants only.
// Heartbeat: client renews the paid-reading lease every 30s.
export const READER_LEASE_HEARTBEAT_SECONDS = 30;
// Lease TTL: a lease lapses 90s after its last successful renew (DB time).
export const READING_LEASE_TTL_SECONDS = 90;
// A third-login chooser window (pending_choice) expires after 30 minutes.
export const SESSION_PENDING_CHOICE_TTL_SECONDS = 30 * 60;
// lastSeenAt/visibility writes are throttled to at most one per 60s per session.
export const SESSION_LASTSEEN_THROTTLE_SECONDS = 60;
// Rotation grace: an incoming cookie may drive same-account rotation up to
// this long after its signature expiry (handles clock-edge re-logins).
export const SESSION_ROTATION_EXPIRY_GRACE_SECONDS = 300;

// Registry lookup / revocation floor: ALWAYS on (never feature-flagged).
// READER_SESSION_CONTROLS toggles ONLY the 2-slot / pending_choice / lease
// enforcement. Default OFF until the Owner enables it.
export const READER_SESSION_CONTROLS_FLAG_ENV = "READER_SESSION_CONTROLS";

// Client-safe session-gate codes (allowlisted in server/_core/trpc.ts).
export const SESSION_REVOKED_CODE = "SESSION_REVOKED";
export const SESSION_SLOT_PENDING_CODE = "SESSION_SLOT_PENDING";
export const SESSION_LEGACY_UNSLOTTED_CODE = "SESSION_LEGACY_UNSLOTTED";
export const LEASE_REQUIRED_CODE = "LEASE_REQUIRED";
export const LEASE_HELD_CODE = "LEASE_HELD";
export const LEASE_LOST_CODE = "LEASE_LOST";
export const SESSION_SLOT_LIMIT = 2;
