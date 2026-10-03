import type { WhoamiResult } from "../contracts";

// IPE-PLUGIN-001B MCP tool handlers - the ONLY business logic reachable
// through the MCP transport skeleton. The read-only identity slice exposes
// exactly one tool; every other tool name is rejected upstream by the
// capability registry (UNKNOWN_CAPABILITY / CAPABILITY_DISABLED).

export type WhoamiToolDeps = {
  /**
   * Loads the display name/role for a bound user id. Injected rather than
   * imported so this handler stays a pure unit-testable function; the real
   * implementation (see mcp/protocol.ts wiring) reads via the same db
   * override-aware singleton every other server feature uses.
   */
  loadUserDisplay: (userId: number) => Promise<{ name: string | null; role: "user" | "admin" } | null>;
};

export async function handleIdentityWhoami(
  principal: { userId: number; clientId: string; scopes: readonly string[] },
  deps: WhoamiToolDeps
): Promise<WhoamiResult> {
  const user = await deps.loadUserDisplay(principal.userId);
  // The bearer validation joins users already, so a missing row here is a
  // vanishing race (user deleted between validation and tool call) - fail
  // closed with an empty identity rather than fabricating one.
  const name = user?.name ?? null;
  const role = user?.role ?? "user";
  return {
    userId: principal.userId,
    name,
    role,
    scope: Array.from(principal.scopes).sort().join(" "),
    clientId: principal.clientId,
  };
}
