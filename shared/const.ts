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
