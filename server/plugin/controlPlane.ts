// IPE-PLUGIN-001B control plane - the fail-closed capability surface for
// external plugin (ChatGPT / MCP) access, deliberately mirroring the NQA
// control-plane pattern (server/nqa/controlPlane.ts): a frozen capability
// registry, an allowlist of what is enabled, a pure authorization function,
// and an audit-sink interface - no HTTP, no database, no framework here.
//
// READ-ONLY SLICE: exactly one capability exists ("identity.whoami") and
// every definition is effect: "READ_ONLY". Anything else - workspace, novel,
// pack, chapter, draft, checker, stage, publish, or any production mutation
// - is structurally absent from this registry, and the static surface tests
// (server/plugin/*.static.test.ts) fail if that ever changes without an
// explicit milestone authorization.

export const PLUGIN_PERMISSION_SCOPES = ["identity:read"] as const;

export type PluginPermissionScope = (typeof PLUGIN_PERMISSION_SCOPES)[number];

export type PluginCapabilityDefinition = {
  /** The OAuth scope a token must carry for this capability. */
  requiredScope: PluginPermissionScope;
  /** Frozen to READ_ONLY for the whole 001B surface. */
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
} as const satisfies Record<string, PluginCapabilityDefinition>;

export type PluginCapability = keyof typeof PLUGIN_CAPABILITIES;

/**
 * Fail-closed enablement allowlist - only capabilities listed here are ever
 * callable, even if they exist in the registry. Mirrors
 * NQA_V1_ENABLED_PERMISSION_TIERS.
 */
export const PLUGIN_V1_ENABLED_CAPABILITIES = [
  "identity.whoami",
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
