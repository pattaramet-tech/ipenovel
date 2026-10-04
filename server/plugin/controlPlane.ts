// IPE-PLUGIN-001B/001C/001D control plane - the fail-closed capability
// surface for external plugin (ChatGPT / MCP) access, deliberately mirroring
// the NQA control-plane pattern (server/nqa/controlPlane.ts): a frozen
// capability registry, an allowlist of what is enabled, a pure authorization
// function, and an audit-sink interface - no HTTP, no database, no framework
// here.
//
// SURFACE: 001B identity read; 001C tenant-scoped reads; 001D adds the
// bounded editorial slice - draft/checker READS and exactly TWO mutations
// (draft.edit limited to the three paragraph replace commands,
// checker.run with the service's own deterministic/idempotent semantics and
// its needs_fix/pending_confirm projection only). Everything else - replace_tab,
// full-checker transforms, bulk cleanup, undo, exclude/restore, finding
// disposition, structural confirmation, allow-word mutation, arbitrary
// kanban transitions, Stage, Publish - remains structurally absent from this
// registry, and the static surface tests fail if that ever changes without
// an explicit milestone authorization.

export const PLUGIN_PERMISSION_SCOPES = [
  "identity:read",
  "workspace:read",
  "novel:read",
  "pack:read",
  "chapter:read",
  "draft:read",
  "draft:write",
  "checker:read",
  "checker:run",
] as const;

export type PluginPermissionScope = (typeof PLUGIN_PERMISSION_SCOPES)[number];

export type PluginCapabilityDefinition = {
  /** The OAuth scope a token must carry for this capability. */
  requiredScope: PluginPermissionScope;
  /** READ_ONLY surfaces data; MUTATION changes editorial state (001D bounded slice only). */
  effect: "READ_ONLY" | "MUTATION";
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
  "draft.get": {
    requiredScope: "draft:read",
    effect: "READ_ONLY",
    description:
      "Read the latest draft of one visible editorial episode pack (identity triple draftId/version/sha256, tabs, paragraphs with fingerprints for echo-back edits).",
  },
  "checker.get": {
    requiredScope: "checker:read",
    effect: "READ_ONLY",
    description:
      "Read the foreign-checker evidence of one visible pack (state, staleReason, findings, dispositions) for the latest run or a specific runId.",
  },
  "draft.edit": {
    requiredScope: "draft:write",
    effect: "MUTATION",
    description:
      "Apply ONE bounded paragraph edit (replace_sentence | replace_range | replace_paragraph) to the latest draft of a visible pack under optimistic concurrency (expectedDraftId/Version/Sha256) with idempotency-key replay safety.",
  },
  "checker.run": {
    requiredScope: "checker:run",
    effect: "MUTATION",
    description:
      "Run the deterministic foreign checker against the latest draft of a visible pack (optionally bound to an expectedDraftId); reuses the service's idempotency key so identical drafts never duplicate semantic runs; projects Kanban to needs_fix/pending_confirm only.",
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
  "draft.get",
  "checker.get",
  "draft.edit",
  "checker.run",
] as const satisfies readonly PluginCapability[];

/** The bounded 001D mutation allowlist - the ONLY edit commands a plugin may carry. */
export const PLUGIN_DRAFT_EDIT_COMMAND_KINDS = [
  "replace_sentence",
  "replace_range",
  "replace_paragraph",
] as const;

export type PluginDraftEditCommandKind = (typeof PLUGIN_DRAFT_EDIT_COMMAND_KINDS)[number];

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
