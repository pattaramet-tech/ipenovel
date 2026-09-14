import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ENV } from "../_core/env";

const SECRET_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_SECRET_CHARS = 16_384;

export class WorkspaceAiProviderSecretVaultError extends Error {
  constructor(
    readonly code:
      | "VAULT_KEY_MISSING"
      | "VAULT_KEY_INVALID"
      | "SECRET_INVALID"
      | "SECRET_CIPHERTEXT_INVALID"
      | "SECRET_DECRYPT_FAILED",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceAiProviderSecretVaultError";
  }
}

function decodeMasterKey(raw: string): Buffer {
  const value = raw.trim();
  if (!value) {
    throw new WorkspaceAiProviderSecretVaultError("VAULT_KEY_MISSING", "WORKSPACE_SECRET_ENCRYPTION_KEY is required for the provider secret vault.");
  }
  let key: Buffer;
  if (/^[a-f0-9]{64}$/i.test(value)) key = Buffer.from(value, "hex");
  else {
    try { key = Buffer.from(value, "base64"); }
    catch { key = Buffer.alloc(0); }
  }
  if (key.length !== 32) {
    throw new WorkspaceAiProviderSecretVaultError("VAULT_KEY_INVALID", "WORKSPACE_SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  return key;
}

function b64url(value: Buffer) { return value.toString("base64url"); }
function fromB64url(value: string) {
  try { return Buffer.from(value, "base64url"); }
  catch { throw new WorkspaceAiProviderSecretVaultError("SECRET_CIPHERTEXT_INVALID", "Stored provider secret ciphertext is invalid."); }
}
function contextBytes(context: string) {
  const value = context.trim();
  if (!value || value.length > 128) throw new WorkspaceAiProviderSecretVaultError("SECRET_INVALID", "Provider secret context is invalid.");
  return Buffer.from(`workspace-ai-provider:${value}`, "utf8");
}

export function assertWorkspaceAiProviderVaultReady(rawKey: string = ENV.workspaceSecretEncryptionKey): void {
  decodeMasterKey(rawKey);
}

export function encryptWorkspaceAiProviderSecret(secret: string, context: string, rawKey: string = ENV.workspaceSecretEncryptionKey): string {
  const value = secret.trim();
  if (!value || value.length > MAX_SECRET_CHARS) {
    throw new WorkspaceAiProviderSecretVaultError("SECRET_INVALID", `Provider API key must be non-empty and no longer than ${MAX_SECRET_CHARS} characters.`);
  }
  const key = decodeMasterKey(rawKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(contextBytes(context));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SECRET_VERSION, b64url(iv), b64url(tag), b64url(ciphertext)].join(".");
}

export function decryptWorkspaceAiProviderSecret(payload: string, context: string, rawKey: string = ENV.workspaceSecretEncryptionKey): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== SECRET_VERSION) {
    throw new WorkspaceAiProviderSecretVaultError("SECRET_CIPHERTEXT_INVALID", "Stored provider secret ciphertext is invalid.");
  }
  const iv = fromB64url(parts[1]);
  const tag = fromB64url(parts[2]);
  const ciphertext = fromB64url(parts[3]);
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) {
    throw new WorkspaceAiProviderSecretVaultError("SECRET_CIPHERTEXT_INVALID", "Stored provider secret ciphertext is invalid.");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, decodeMasterKey(rawKey), iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(contextBytes(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof WorkspaceAiProviderSecretVaultError) throw error;
    throw new WorkspaceAiProviderSecretVaultError("SECRET_DECRYPT_FAILED", "Stored provider secret could not be decrypted.");
  }
}

export function maskWorkspaceAiProviderSecret(secret: string): string {
  const value = secret.trim();
  if (!value) return "";
  const suffix = value.slice(-4);
  return `${"•".repeat(8)}${suffix}`;
}