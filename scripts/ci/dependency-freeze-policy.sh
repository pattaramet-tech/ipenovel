#!/usr/bin/env bash
# Dependency-freeze exception policy for the M29.3 Chapter Editor Release
# Gate. Extracted verbatim from the workflow's inline block at R40R69 so the
# SAME logic runs in CI and in disposable local git fixtures
# (scripts/ci/dependency-freeze-policy.test.sh).
#
# Contract: the caller (the workflow step) has ALREADY established that
# package.json and/or pnpm-lock.yaml differ from the M29.3 baseline — the
# trigger check stays in the workflow. This script decides whether the
# delta is covered by an approved exception: exit 0 = policy satisfied,
# exit 1 = denied.
#
# Approved exceptions, in evaluation order:
#   1. Reader Session Controls (RSC) pull_request / workflow_dispatch —
#      unchanged from the original inline policy.
#   2. Scheduler build-script (R40R69) — scoped to the EXACT reviewed head
#      commit 6810540: package.json may only change the "build" line (the
#      dist/notifications-tick.js esbuild entry); pnpm-lock.yaml must stay
#      byte-identical to the approved baseline; the synthetic merge result
#      must carry exactly the approved scheduler blobs.
#   3. Generic post-merge compatibility — unchanged, EXCEPT the approved
#      package.json blob is re-based onto the scheduler blob once the
#      scheduler commit is an ancestor of the PR base (post-merge). This
#      keeps future dependency-less PRs green while any OTHER package.json
#      change still requires its own separate approval.
#
# Constants are overridable by environment ONLY so disposable local
# fixtures can substitute their own analog commits; CI never sets them.

set -u

# Baked approved constants — the CI production path uses EXACTLY these
# values. Environment overrides are honored ONLY when the caller sets
# DEP_FREEZE_POLICY_ALLOW_ENV_OVERRIDES=1, which the local fixture test
# harness does and CI never does (R40R69R1 task 5: an env var cannot relax
# the production gate).
POLICY_BAKED_PKG_BLOB="69f7972e1d3f7eaa6052310318134c8bbc0fe785"
POLICY_BAKED_LOCK_BLOB="b4a01df0852a348833da7408db65370d4889db46"
POLICY_BAKED_RSC_BASE="01c9efef680a4f414ea15a9447ed0f1618ba9dba"
POLICY_BAKED_R5_COMMIT="7e7fb0f0be5004f306767fdb55b49a4c4ff44ec9"
POLICY_BAKED_SCHED_COMMIT="6810540ebcad1bb38d59d393dc204dca4f4b50e9"
POLICY_BAKED_SCHED_PKG_BLOB="461d1592cf54c86910095af62497e6ccfb444906"
POLICY_BAKED_REPOSITORY="pattaramet-tech/ipenovel"

# R40R69R2: the CI production invocation carries an explicit --production
# ARGUMENT on the workflow line. Arguments cannot be injected through the
# environment, so an attacker-supplied DEP_FREEZE_POLICY_ALLOW_ENV_OVERRIDES
# or APPROVED_* variable inside CI is inert: the production branch ignores
# the environment entirely and uses the baked constants, including the
# approved repository. Override env vars are honored ONLY without
# --production AND with the explicit fixture flag (local tests only).
POLICY_PRODUCTION=0
for POLICY_ARG in "$@"; do
  if [ "$POLICY_ARG" = "--production" ]; then
    POLICY_PRODUCTION=1
  fi
done

if [ "$POLICY_PRODUCTION" = "1" ]; then
  APPROVED_PKG_BLOB="$POLICY_BAKED_PKG_BLOB"
  APPROVED_LOCK_BLOB="$POLICY_BAKED_LOCK_BLOB"
  RSC_BASE="$POLICY_BAKED_RSC_BASE"
  R5_COMMIT="$POLICY_BAKED_R5_COMMIT"
  SCHED_COMMIT="$POLICY_BAKED_SCHED_COMMIT"
  SCHED_PKG_BLOB="$POLICY_BAKED_SCHED_PKG_BLOB"
  APPROVED_REPOSITORY="$POLICY_BAKED_REPOSITORY"
elif [ "${DEP_FREEZE_POLICY_ALLOW_ENV_OVERRIDES:-0}" = "1" ]; then
  APPROVED_PKG_BLOB="${APPROVED_PKG_BLOB:-$POLICY_BAKED_PKG_BLOB}"
  APPROVED_LOCK_BLOB="${APPROVED_LOCK_BLOB:-$POLICY_BAKED_LOCK_BLOB}"
  RSC_BASE="${RSC_BASE:-$POLICY_BAKED_RSC_BASE}"
  R5_COMMIT="${R5_COMMIT:-$POLICY_BAKED_R5_COMMIT}"
  SCHED_COMMIT="${SCHED_COMMIT:-$POLICY_BAKED_SCHED_COMMIT}"
  SCHED_PKG_BLOB="${SCHED_PKG_BLOB:-$POLICY_BAKED_SCHED_PKG_BLOB}"
  APPROVED_REPOSITORY="${APPROVED_REPOSITORY:-$POLICY_BAKED_REPOSITORY}"
  echo "DEP_FREEZE_POLICY: fixture override mode active (never used in CI production)"
else
  APPROVED_PKG_BLOB="$POLICY_BAKED_PKG_BLOB"
  APPROVED_LOCK_BLOB="$POLICY_BAKED_LOCK_BLOB"
  RSC_BASE="$POLICY_BAKED_RSC_BASE"
  R5_COMMIT="$POLICY_BAKED_R5_COMMIT"
  SCHED_COMMIT="$POLICY_BAKED_SCHED_COMMIT"
  SCHED_PKG_BLOB="$POLICY_BAKED_SCHED_PKG_BLOB"
  APPROVED_REPOSITORY="$POLICY_BAKED_REPOSITORY"
fi

# Read a dotted path out of the GitHub event JSON. jq on CI; a python
# fallback (python3, then the Windows Store-less `python`) so the same
# script is runnable in disposable local fixtures.
event_field() {
  local spec="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -r "${spec} // \"\"" "$GITHUB_EVENT_PATH" 2>/dev/null || printf ''
    return 0
  fi
  local py=""
  local cand
  for cand in python3 python; do
    # A present-but-broken interpreter (e.g. the Windows Store python3
    # alias stub) must be skipped, not selected.
    if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "import sys" >/dev/null 2>&1; then
      py="$cand"
      break
    fi
  done
  if [ -z "$py" ]; then
    printf ''
    return 0
  fi
  EVENT_JSON="$GITHUB_EVENT_PATH" EVENT_SPEC="$spec" "$py" - <<'PYEOF'
import json, os
data = json.load(open(os.environ["EVENT_JSON"], encoding="utf-8"))
cur = data
for part in os.environ["EVENT_SPEC"].lstrip(".").split("."):
    if isinstance(cur, dict) and part in cur:
        cur = cur[part]
    else:
        cur = ""
        break
print("" if cur is None else cur)
PYEOF
}

RSC_EXCEPTION=0

if [ "${GITHUB_REPOSITORY:-}" = "$APPROVED_REPOSITORY" ] && [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ] && [ "${GITHUB_BASE_REF:-}" = "main" ] && [ "${GITHUB_HEAD_REF:-}" = "feat/reader-session-controls" ]; then
  EVENT_HEAD_REPO="$(event_field '.pull_request.head.repo.full_name')"
  EVENT_HEAD_SHA="$(event_field '.pull_request.head.sha')"
  if [ "$EVENT_HEAD_REPO" != "$APPROVED_REPOSITORY" ] || [ -z "$EVENT_HEAD_SHA" ] || ! git merge-base --is-ancestor "$RSC_BASE" "$EVENT_HEAD_SHA" || [ "$(git rev-parse HEAD^2 2>/dev/null || true)" != "$EVENT_HEAD_SHA" ]; then
    echo "Reader Session Controls exception denied: provenance mismatch (head repo/sha or merge parents)"
    exit 1
  fi
  if [ "$(git rev-parse "$EVENT_HEAD_SHA:package.json")" != "$APPROVED_PKG_BLOB" ] || [ "$(git rev-parse "$EVENT_HEAD_SHA:pnpm-lock.yaml")" != "$APPROVED_LOCK_BLOB" ] || [ "$(git rev-parse HEAD:package.json)" != "$APPROVED_PKG_BLOB" ] || [ "$(git rev-parse HEAD:pnpm-lock.yaml)" != "$APPROVED_LOCK_BLOB" ]; then
    echo "Reader Session Controls exception denied: dependency blob SHA mismatch"
    exit 1
  fi
  RSC_DELTA="$(git diff --name-only "$RSC_BASE" "$EVENT_HEAD_SHA" -- . ':(exclude).github/workflows/m29-3-7-chapter-editor-release-gate.yml')"
  if [ -n "$RSC_DELTA" ]; then
    echo "Reader Session Controls exception denied: unapproved changes after the reviewed commit:"
    echo "$RSC_DELTA"
    exit 1
  fi
  RSC_EXCEPTION=1
  echo "Reader Session Controls exception verified: approved dependency blobs (69f7972e/b4a01df0), reviewed commit is ancestor, workflow-only delta."
elif [ "${GITHUB_REPOSITORY:-}" = "$APPROVED_REPOSITORY" ] && [ "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" ] && [ "${GITHUB_REF:-}" = "refs/heads/feat/reader-session-controls" ] && [ "${GITHUB_SHA:-}" = "$(git rev-parse HEAD)" ] && git merge-base --is-ancestor "$RSC_BASE" HEAD; then
  if [ "$(git rev-parse HEAD:package.json)" != "$APPROVED_PKG_BLOB" ] || [ "$(git rev-parse HEAD:pnpm-lock.yaml)" != "$APPROVED_LOCK_BLOB" ]; then
    echo "Reader Session Controls exception denied: dependency blob SHA mismatch"
    exit 1
  fi
  RSC_DELTA="$(git diff --name-only "$RSC_BASE" HEAD -- . ':(exclude).github/workflows/m29-3-7-chapter-editor-release-gate.yml')"
  if [ -n "$RSC_DELTA" ]; then
    echo "Reader Session Controls exception denied: unapproved changes after the reviewed commit:"
    echo "$RSC_DELTA"
    exit 1
  fi
  RSC_EXCEPTION=1
  echo "Reader Session Controls exception verified: approved dependency blobs (69f7972e/b4a01df0), reviewed commit is ancestor, workflow-only delta."
elif [ "${GITHUB_REPOSITORY:-}" = "$APPROVED_REPOSITORY" ] && [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ] && [ "${GITHUB_BASE_REF:-}" = "main" ]; then
  EVENT_HEAD_REPO="$(event_field '.pull_request.head.repo.full_name')"
  EVENT_HEAD_SHA="$(event_field '.pull_request.head.sha')"
  EVENT_BASE_SHA="$(event_field '.pull_request.base.sha')"
  if [ "$EVENT_HEAD_REPO" != "$APPROVED_REPOSITORY" ] || [ -z "$EVENT_HEAD_SHA" ] || [ -z "$EVENT_BASE_SHA" ]; then
    echo "Post-merge compatibility check denied: malformed or missing event provenance"
    exit 1
  fi
  if ! git merge-base --is-ancestor "$R5_COMMIT" "$EVENT_BASE_SHA"; then
    echo "Post-merge compatibility check denied: main base is not a descendant of the approved Reader Session Controls merge commit"
    exit 1
  fi
  if [ "$(git rev-parse HEAD^1 2>/dev/null || true)" != "$EVENT_BASE_SHA" ] || [ "$(git rev-parse HEAD^2 2>/dev/null || true)" != "$EVENT_HEAD_SHA" ]; then
    echo "Post-merge compatibility check denied: synthetic merge parents do not match the event base/head SHAs"
    exit 1
  fi
  if [ "$EVENT_HEAD_SHA" = "$SCHED_COMMIT" ]; then
    # R40R69 scheduler build-script exception: bound to the EXACT reviewed
    # head commit — a force-pushed or amended branch never matches; only the
    # "build" line may differ; the lockfile is frozen at the approved blob.
    if [ "$(git rev-parse "$EVENT_BASE_SHA:package.json")" != "$APPROVED_PKG_BLOB" ]; then
      echo "Scheduler build-script exception denied: base package.json is not the approved M29.3 baseline"
      exit 1
    fi
    if [ "$(git rev-parse "$SCHED_COMMIT:package.json")" != "$SCHED_PKG_BLOB" ]; then
      echo "Scheduler build-script exception denied: head package.json blob is not the approved scheduler blob"
      exit 1
    fi
    if [ "$(git rev-parse "$SCHED_COMMIT:pnpm-lock.yaml")" != "$APPROVED_LOCK_BLOB" ]; then
      echo "Scheduler build-script exception denied: pnpm-lock.yaml changed in the scheduler commit (lockfile is frozen)"
      exit 1
    fi
    if [ "$(git rev-parse HEAD:package.json)" != "$SCHED_PKG_BLOB" ] || [ "$(git rev-parse HEAD:pnpm-lock.yaml)" != "$APPROVED_LOCK_BLOB" ]; then
      echo "Scheduler build-script exception denied: synthetic merge dependency blobs do not match the approved scheduler blobs"
      exit 1
    fi
    POLICY_TMP="$(mktemp -d)"
    git show "$EVENT_BASE_SHA:package.json" > "$POLICY_TMP/base_package.json"
    git show "$SCHED_COMMIT:package.json" > "$POLICY_TMP/scheduler_package.json"
    CHANGED_LINES="$(git diff --unified=0 --no-index "$POLICY_TMP/base_package.json" "$POLICY_TMP/scheduler_package.json" | grep -E '^[+-][^+-]' || true)"
    rm -rf "$POLICY_TMP"
    if [ -z "$CHANGED_LINES" ]; then
      echo "Scheduler build-script exception denied: no package.json delta detected against the approved baseline"
      exit 1
    fi
    NON_BUILD_LINES="$(printf '%s\n' "$CHANGED_LINES" | grep -cvE '^[+-][[:space:]]*"build":' || true)"
    if [ "$NON_BUILD_LINES" != "0" ]; then
      echo "Scheduler build-script exception denied: package.json delta extends beyond the build script line:"
      printf '%s\n' "$CHANGED_LINES" | grep -vE '^[+-][[:space:]]*"build":'
      exit 1
    fi
    RSC_EXCEPTION=1
    echo "Scheduler build-script exception verified: exact reviewed head ${SCHED_COMMIT:0:8}, package.json delta confined to the build script line, pnpm-lock.yaml identical to the approved baseline."
  else
    EFFECTIVE_PKG_BLOB="$APPROVED_PKG_BLOB"
    if git merge-base --is-ancestor "$SCHED_COMMIT" "$EVENT_BASE_SHA" 2>/dev/null; then
      # Post-scheduler-merge baseline: the approved package.json blob becomes
      # the reviewed scheduler blob; every OTHER delta still requires its own
      # separate approval.
      EFFECTIVE_PKG_BLOB="$SCHED_PKG_BLOB"
    fi
    if [ "$(git rev-parse "$EVENT_BASE_SHA:package.json")" != "$EFFECTIVE_PKG_BLOB" ] || [ "$(git rev-parse "$EVENT_BASE_SHA:pnpm-lock.yaml")" != "$APPROVED_LOCK_BLOB" ] || [ "$(git rev-parse "HEAD:package.json")" != "$EFFECTIVE_PKG_BLOB" ] || [ "$(git rev-parse "HEAD:pnpm-lock.yaml")" != "$APPROVED_LOCK_BLOB" ] || [ "$(git rev-parse "$EVENT_HEAD_SHA:package.json")" != "$EFFECTIVE_PKG_BLOB" ] || [ "$(git rev-parse "$EVENT_HEAD_SHA:pnpm-lock.yaml")" != "$APPROVED_LOCK_BLOB" ]; then
      echo "Post-merge compatibility check denied: dependency blob changed after the approved Reader Session Controls merge (pending its own separate approval)"
      exit 1
    fi
    if [ -n "$(git diff --name-only "$EVENT_BASE_SHA" "$EVENT_HEAD_SHA" -- package.json pnpm-lock.yaml)" ]; then
      echo "Post-merge compatibility check denied: this PR introduces dependency changes (pending its own separate approval)"
      exit 1
    fi
    RSC_EXCEPTION=1
    echo "Post-merge compatibility verified: R5 ancestry, approved dependency blobs at base/head/merge, no dependency changes in this PR."
  fi
elif [ "${GITHUB_REPOSITORY:-}" = "$APPROVED_REPOSITORY" ] && [ "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" ] && [ "${GITHUB_REF:-}" = "refs/heads/main" ] && [ "${GITHUB_SHA:-}" = "$(git rev-parse HEAD)" ] && git merge-base --is-ancestor "$R5_COMMIT" HEAD; then
  EFFECTIVE_PKG_BLOB="$APPROVED_PKG_BLOB"
  if git merge-base --is-ancestor "$SCHED_COMMIT" HEAD 2>/dev/null; then
    EFFECTIVE_PKG_BLOB="$SCHED_PKG_BLOB"
  fi
  if [ "$(git rev-parse HEAD:package.json)" != "$EFFECTIVE_PKG_BLOB" ] || [ "$(git rev-parse HEAD:pnpm-lock.yaml)" != "$APPROVED_LOCK_BLOB" ]; then
    echo "Post-merge main dispatch denied: dependency blob changed after the approved Reader Session Controls merge"
    exit 1
  fi
  RSC_EXCEPTION=1
  echo "Post-merge main dispatch verified: R5 ancestry and approved dependency blobs."
fi

if [ "$RSC_EXCEPTION" = "1" ]; then
  echo "Dependency exception policy satisfied."
else
  echo "M29.3 must not add dependencies without separate review."
  exit 1
fi
