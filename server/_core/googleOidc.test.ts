import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { ENV } from "./env";
import { verifyGoogleIdToken } from "./googleOidc";

// Real signature verification against a test-generated RS256 keypair, via
// verifyGoogleIdToken's injectable `getKey` option - no network access, no
// mocking of jose itself, so these tests exercise the ACTUAL
// issuer/audience/expiration/signature logic jwtVerify performs, not a
// stand-in for it. Google's real ID tokens are RS256; the test keypair
// matches that algorithm.

const GOOGLE_CLIENT_ID = "test-google-client-id.apps.googleusercontent.com";
const TEST_KID = "test-kid-1";
const VALID_NONCE = "test-nonce-abc123";

let getKey: JWTVerifyGetKey;
let privateKey: CryptoKey;

async function buildLocalJwks() {
  const { publicKey, privateKey: generatedPrivateKey } = await generateKeyPair("RS256");
  privateKey = generatedPrivateKey;
  const jwk = await exportJWK(publicKey);
  jwk.kid = TEST_KID;
  jwk.alg = "RS256";
  jwk.use = "sig";
  getKey = createLocalJWKSet({ keys: [jwk] });
}

type ClaimOverrides = {
  // `null` means "omit this claim entirely" (for the missing-claim
  // rejection tests) - deliberately NOT `undefined` for this purpose:
  // destructuring defaults (`{ sub = "..." } = overrides`) treat an
  // explicitly-passed `undefined` exactly the same as an omitted property,
  // which would silently defeat every "claim missing" test below by
  // falling back to the default value instead of actually omitting it.
  sub?: string | null;
  email?: string | null;
  email_verified?: unknown;
  nonce?: string | null;
  name?: string;
  picture?: string;
  iss?: string;
  aud?: string;
  expiresInSeconds?: number;
};

async function signTestIdToken(overrides: ClaimOverrides = {}): Promise<string> {
  const sub = "sub" in overrides ? overrides.sub : "1234567890";
  const email = "email" in overrides ? overrides.email : "user@example.com";
  const emailVerified = "email_verified" in overrides ? overrides.email_verified : true;
  const nonce = "nonce" in overrides ? overrides.nonce : VALID_NONCE;
  const { name, picture, iss = "https://accounts.google.com", aud = GOOGLE_CLIENT_ID, expiresInSeconds = 3600 } = overrides;

  const claims: Record<string, unknown> = { email_verified: emailVerified };
  if (sub !== null) claims.sub = sub;
  if (email !== null) claims.email = email;
  if (nonce !== null) claims.nonce = nonce;
  if (name !== undefined) claims.name = name;
  if (picture !== undefined) claims.picture = picture;

  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: TEST_KID })
    .setIssuedAt()
    .setIssuer(iss)
    .setAudience(aud)
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds);

  return jwt.sign(privateKey);
}

describe("verifyGoogleIdToken", () => {
  const originalClientId = ENV.googleClientId;

  beforeEach(async () => {
    await buildLocalJwks();
    ENV.googleClientId = GOOGLE_CLIENT_ID;
  });

  afterEach(() => {
    ENV.googleClientId = originalClientId;
  });

  it("valid token (correct signature, issuer, audience, nonce, sub, email, email_verified) -> resolves claims", async () => {
    const token = await signTestIdToken({ name: "Test User", picture: "https://example.com/pic.jpg" });
    const claims = await verifyGoogleIdToken(token, VALID_NONCE, { getKey });
    expect(claims).toEqual({
      sub: "1234567890",
      email: "user@example.com",
      emailVerified: true,
      name: "Test User",
      picture: "https://example.com/pic.jpg",
    });
  });

  it("accepts the bare 'accounts.google.com' issuer form too", async () => {
    const token = await signTestIdToken({ iss: "accounts.google.com" });
    const claims = await verifyGoogleIdToken(token, VALID_NONCE, { getKey });
    expect(claims.sub).toBe("1234567890");
  });

  it("state match is not this function's concern (handled at the route layer) - only nonce is checked here", async () => {
    const token = await signTestIdToken();
    await expect(verifyGoogleIdToken(token, VALID_NONCE, { getKey })).resolves.toBeTruthy();
  });

  it("nonce mismatch -> rejects", async () => {
    const token = await signTestIdToken({ nonce: "a-different-nonce" });
    await expect(verifyGoogleIdToken(token, VALID_NONCE, { getKey })).rejects.toThrow(/nonce/i);
  });

  it("missing nonce claim entirely -> rejects", async () => {
    const token = await signTestIdToken({ nonce: null });
    await expect(verifyGoogleIdToken(token, VALID_NONCE, { getKey })).rejects.toThrow(/nonce/i);
  });

  it("wrong issuer -> rejects", async () => {
    const token = await signTestIdToken({ iss: "https://evil.example.com" });
    await expect(verifyGoogleIdToken(token, VALID_NONCE, { getKey })).rejects.toThrow();
  });

  it("wrong audience -> rejects", async () => {
    const token = await signTestIdToken({ aud: "a-different-client-id.apps.googleusercontent.com" });
    await expect(verifyGoogleIdToken(token, VALID_NONCE, { getKey })).rejects.toThrow();
  });

  it("expired token -> rejects", async () => {
    const token = await signTestIdToken({ expiresInSeconds: -3600 });
    await expect(verifyGoogleIdToken(token, VALID_NONCE, { getKey })).rejects.toThrow();
  });

  it("email_verified=false -> rejects", async () => {
    const token = await signTestIdToken({ email_verified: false });
    await expect(verifyGoogleIdToken(token, VALID_NONCE, { getKey })).rejects.toThrow(/email.*verif/i);
  });

  it("email_verified as the string \"true\" (not boolean) -> rejects, strict boolean only", async () => {
    const token = await signTestIdToken({ email_verified: "true" as unknown as boolean });
    await expect(verifyGoogleIdToken(token, VALID_NONCE, { getKey })).rejects.toThrow(/email.*verif/i);
  });

  it("email claim missing -> rejects", async () => {
    const token = await signTestIdToken({ email: null });
    await expect(verifyGoogleIdToken(token, VALID_NONCE, { getKey })).rejects.toThrow(/email/i);
  });

  it("sub claim missing -> rejects", async () => {
    const token = await signTestIdToken({ sub: null });
    await expect(verifyGoogleIdToken(token, VALID_NONCE, { getKey })).rejects.toThrow(/sub/i);
  });

  it("a token signed by a DIFFERENT key than the one in the JWKS -> rejects (real signature verification, not a stub)", async () => {
    const { privateKey: otherPrivateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ sub: "1234567890", email: "user@example.com", email_verified: true, nonce: VALID_NONCE })
      .setProtectedHeader({ alg: "RS256", kid: TEST_KID })
      .setIssuedAt()
      .setIssuer("https://accounts.google.com")
      .setAudience(GOOGLE_CLIENT_ID)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(otherPrivateKey);

    await expect(verifyGoogleIdToken(token, VALID_NONCE, { getKey })).rejects.toThrow();
  });

  it("no usable name/picture sent -> resolves with null, never an empty string", async () => {
    const token = await signTestIdToken({});
    const claims = await verifyGoogleIdToken(token, VALID_NONCE, { getKey });
    expect(claims.name).toBeNull();
    expect(claims.picture).toBeNull();
  });

  it("whitespace-only name -> normalized to null", async () => {
    const token = await signTestIdToken({ name: "   " });
    const claims = await verifyGoogleIdToken(token, VALID_NONCE, { getKey });
    expect(claims.name).toBeNull();
  });

  it("reads ENV.googleClientId fresh on every call (not cached at module load)", async () => {
    const tokenForFirstClient = await signTestIdToken({ aud: "first-client-id" });
    ENV.googleClientId = "first-client-id";
    await expect(verifyGoogleIdToken(tokenForFirstClient, VALID_NONCE, { getKey })).resolves.toBeTruthy();

    ENV.googleClientId = "second-client-id";
    await expect(verifyGoogleIdToken(tokenForFirstClient, VALID_NONCE, { getKey })).rejects.toThrow();
  });
});
