// IPE-PLUGIN-001B/001C control plane - the fail-closed capability surface
// for external plugin (ChatGPT / MCP) access, deliberately mirroring the NQA
// control-plane pattern (server/nqa/controlPlane.ts): a frozen capability
// registry, an allowlist of what is enabled, a pure authorization function,
// and an audit-sink interface - no HTTP, no database, no framework here.
//
// READ-ONLY SURFACE: every definition is effect: "READ_ONLY". 001C adds the
// tenant-scoped read family (workspace/novel/pack/chapter list+get) whose
// visibility is derived server-side from the token's bound users.id via
// workspaceMembers / workspaceWorkspaces.ownerUserId - the client can never
// choose an authority or account. Anything else - draft/checker/stage/
// publish, any mutation - is structurally absent from this registry, and the
// static surface tests (server/plugin/*.static.test.ts) fail if that ever
// changes without an explicit milestone authorization.

export const PLUGIN_PERMISSION_SCOPES = [
  "identity:read",
  "workspace:read",
  "novel:read",
  "pack:read",
  "chapter:read",
] as const;

export type PluginPermissionScope = (typeof PLUGIN_PERMISSION_SCOPES)[number];

export type PluginCapabilityDefinition = {
  /** The OAuth scope a token must carry for this capability. */
  requiredScope: PluginPermissionScope;
  /** Frozen to READ_ONLY for the whole plugin surface (001B + 001C). */
  effect: "READ_ONLY";
  description: string;
};

export const PLUGIN_CAPABILITIES = {
  "identity.whoami": {
    requiredScope: "identity:read",
    effect: "READ_ONLY",
    description:
      "Resolve the IpeNovel user identity this plugin token is bound to (id, name, role, granted scope).",
  },
  "workspace.list": {
    requiredScope: "workspace:read",
    effect: "READ_ONLY",
    description:
      "List workspaces the bound user owns or is an active member of (active, not soft-deleted).",
  },
  "workspace.get": {
    requiredScope: "workspace:read",
    effect: "READ_ONLY",
    description: "Read one workspace's metadata - only if the bound user can see it.",
  },
  "novel.list": {
    requiredScope: "novel:read",
    effect: "READ_ONLY",
    description: "List novels actively bound to one visible workspace.",
  },
  "novel.get": {
    requiredScope: "novel:read",
    effect: "READ_ONLY",
    description: "Read one workspace-bound novel - only if its workspace is visible to the bound user.",
  },
  "pack.list": {
    requiredScope: "pack:read",
    effect: "READ_ONLY",
    description: "List editorial episode packs of one visible workspace (optionally per bound novel).",
  },
  "pack.get": {
    requiredScope: "pack:read",
    effect: "READ_ONLY",
    description: "Read one editorial episode pack - only if its workspace is visible to the bound user.",
  },
  "chapter.list": {
    requiredScope: "chapter:read",
    effect: "READ_ONLY",
    description: "List the latest-draft chapter tabs of one visible editorial episode pack.",
  },
  "chapter.get": {
    requiredScope: "chapter:read",
    effect: "READ_ONLY",
    description: "Read one chapter tab of the latest draft - only if its pack's workspace is visible to the bound user.",
  },
} as const satisfies Record<string, PluginCapabilityDefinition>;

export type PluginCapability = keyof typeof PLUGIN_CAPABILITIES;

/**
 * Fail-closed enablement allowlist - only capabilities listed here are ever
 * callable, even if they exist in the registry. Mirrors
 * NQA_V1_ENABLED_PERMISSION_TIERS.
 */
export const PLUGIN_V1_ENABLED_CAPABILITIES = [
  "identity.whoami",
  "workspace.list",
  "workspace.get",
  "novel.list",
  "novel.get",
  "pack.list",
  "pack.get",
  "chapter.list",
  "chapter.get",
] as const satisfies readonly PluginCapability[];

export type PluginAuthorizationDecision =
  | {
      allowed: true;
      capability: PluginCapability;
      requiredScope: PluginPermissionScope;
      reason: "ALLOW";
    }
  | {
      allowed: false;
      capability: string;
      requiredScope: PluginPermissionScope | null;
      reason: "UNKNOWN_CAPABILITY" | "CAPABILITY_DISABLED" | "INSUFFICIENT_SCOPE";
    };

export function parsePluginScopes(raw: string | null | undefined): PluginPermissionScope[] {
  if (!raw) return [];
  const requested = raw.split(/[\s]+/).filter(Boolean);
  const allowed = new Set<string>(PLUGIN_PERMISSION_SCOPES);
  const granted: PluginPermissionScope[] = [];
  for (const scope of requested) {
    if (allowed.has(scope) && !granted.includes(scope as PluginPermissionScope)) {
      granted.push(scope as PluginPermissionScope);
    }
  }
  return granted;
}

export function isKnownPluginScope(scope: string): scope is PluginPermissionScope {
  return (PLUGIN_PERMISSION_SCOPES as readonly string[]).includes(scope);
}

export function authorizePluginCapability(input: {
  capability: string;
  grantedScopes: readonly PluginPermissionScope[];
  enabledCapabilities?: readonly PluginCapability[];
}): PluginAuthorizationDecision {
  const definition = (
    PLUGIN_CAPABILITIES as Record<string, PluginCapabilityDefinition | undefined>
  )[input.capability];

  if (!definition) {
    return {
      allowed: false,
      capability: input.capability,
      requiredScope: null,
      reason: "UNKNOWN_CAPABILITY",
    };
  }

  const enabled = input.enabledCapabilities ?? PLUGIN_V1_ENABLED_CAPABILITIES;
  if (!enabled.includes(input.capability as PluginCapability)) {
    return {
      allowed: false,
      capability: input.capability,
      requiredScope: definition.requiredScope,
      reason: "CAPABILITY_DISABLED",
    };
  }

  if (!input.grantedScopes.includes(definition.requiredScope)) {
    return {
      allowed: false,
      capability: input.capability,
      requiredScope: definition.requiredScope,
      reason: "INSUFFICIENT_SCOPE",
    };
  }

  return {
    allowed: true,
    capability: input.capability as PluginCapability,
    requiredScope: definition.requiredScope,
    reason: "ALLOW",
  };
}

export type PluginAuditRecord = {
  auditVersion: "plugin-audit-v1";
  eventType: string;
  /** null for events at the unauthenticated edge (e.g. forged bearer rejection). */
  actorUserId: number | null;
  clientId: string | null;
  /** Server-generated per-decision correlation id - NEVER client-supplied. */
  correlationId: string;
  /** Bounded, secret-free JSON string (client ids, scopes, deny reasons). */
  safeMetadata: string;
  createdAt: string;
};

export interface PluginAuditSink {
  append(record: PluginAuditRecord): Promise<void> | void;
}

export class InMemoryPluginAuditSink implements PluginAuditSink {
  readonly records: PluginAuditRecord[] = [];

  append(record: PluginAuditRecord): void {
    this.records.push({ ...record });
  }
}
