import { describe, expect, it } from "vitest";
import {
  assertWorkspaceAiProviderVaultReady,
  decryptWorkspaceAiProviderSecret,
  encryptWorkspaceAiProviderSecret,
  maskWorkspaceAiProviderSecret,
  WorkspaceAiProviderSecretVaultError,
} from "./aiProviderSecretVault";

const KEY_A = "11".repeat(32);
const KEY_B = "22".repeat(32);
const CONTEXT = "provider-profile-test-context";

describe("IPE-054-D0 Workspace AI provider secret vault", () => {
  it("encrypts with AES-GCM and decrypts only with the same key and context", () => {
    const secret = "gemini-test-secret-1234";
    const encrypted = encryptWorkspaceAiProviderSecret(secret, CONTEXT, KEY_A);
    expect(encrypted).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encrypted).not.toContain(secret);
    expect(decryptWorkspaceAiProviderSecret(encrypted, CONTEXT, KEY_A)).toBe(secret);
    expect(() => decryptWorkspaceAiProviderSecret(encrypted, "other-context", KEY_A))
      .toThrow(WorkspaceAiProviderSecretVaultError);
    expect(() => decryptWorkspaceAiProviderSecret(encrypted, CONTEXT, KEY_B))
      .toThrow(WorkspaceAiProviderSecretVaultError);
  });

  it("accepts an exact 32-byte hex or base64 master key and rejects malformed keys", () => {
    expect(() => assertWorkspaceAiProviderVaultReady(KEY_A)).not.toThrow();
    expect(() => assertWorkspaceAiProviderVaultReady(Buffer.alloc(32, 7).toString("base64"))).not.toThrow();
    for (const invalid of ["", "abcd", "33".repeat(31), "33".repeat(33)]) {
      let error: unknown;
      try { assertWorkspaceAiProviderVaultReady(invalid); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(WorkspaceAiProviderSecretVaultError);
      expect(String((error as Error)?.message ?? "")).not.toContain(KEY_A);
    }
  });

  it("fails closed for malformed or tampered ciphertext without leaking its contents", () => {
    const encrypted = encryptWorkspaceAiProviderSecret("provider-secret-9876", CONTEXT, KEY_A);
    const parts = encrypted.split(".");
    const tag = Buffer.from(parts[2], "base64url");
    tag[0] ^= 0xff;
    parts[2] = tag.toString("base64url");
    const tampered = parts.join(".");
    expect(() => decryptWorkspaceAiProviderSecret("not-a-vault-payload", CONTEXT, KEY_A))
      .toThrow(/ciphertext is invalid/i);
    expect(() => decryptWorkspaceAiProviderSecret(tampered, CONTEXT, KEY_A))
      .toThrow(WorkspaceAiProviderSecretVaultError);
  });

  it("masks secrets without revealing more than the final four characters", () => {
    expect(maskWorkspaceAiProviderSecret("abcdefgh1234")).toBe("••••••••1234");
    expect(maskWorkspaceAiProviderSecret("xy")).toBe("••••••••xy");
    expect(maskWorkspaceAiProviderSecret("   ")).toBe("");
  });

  it("rejects empty secrets and invalid secret contexts", () => {
    expect(() => encryptWorkspaceAiProviderSecret("", CONTEXT, KEY_A))
      .toThrow(/API key must be non-empty/i);
    expect(() => encryptWorkspaceAiProviderSecret("secret", "", KEY_A))
      .toThrow(/context is invalid/i);
  });
});
