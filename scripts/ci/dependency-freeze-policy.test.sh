#!/usr/bin/env bash
# Local qualification for scripts/ci/dependency-freeze-policy.sh (R40R69).
#
# Runs the REAL policy script (the exact file the workflow executes) inside
# disposable git fixtures built from the repository's REAL approved blobs:
#   - package.json @ origin/main          (approved M29.3 baseline, 69f7972e)
#   - package.json @ 6810540 (scheduler)  (approved scheduler blob, 461d1592)
#   - pnpm-lock.yaml @ origin/main        (approved lock blob,   b4a01df0)
#
# Coverage:
#   T0  generic PR without dependency changes (pre-merge main)      -> allow
#   T1  scheduler PR, exact reviewed head commit                    -> allow
#   T2  scheduler shape but amended head SHA (not the reviewed one) -> deny
#   T3  scheduler BRANCH NAME but a different head commit           -> deny
#   T4  unrelated PR introducing an unauthorized package delta      -> deny
#   T5  scheduler shape with a CHANGED lockfile                     -> deny
#   T6  scheduler shape whose BASE is not the approved baseline     -> deny
#   T7  post-scheduler-merge PR without dependency changes          -> allow
#       (baseline re-based onto the scheduler blob)
#   T8  post-scheduler-merge PR with an unauthorized package delta  -> deny
#   T9  Reader Session Controls exception preserved                 -> allow
#   T10 post-merge main dispatch with scheduler blob                 -> allow
#
# Usage: bash scripts/ci/dependency-freeze-policy.test.sh
# Exit 0 only if every case passes.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/../.." rev-parse --show-toplevel)"
POLICY="$SCRIPT_DIR/dependency-freeze-policy.sh"
WF="$REPO_ROOT/.github/workflows/m29-3-7-chapter-editor-release-gate.yml"

# The workflow's approved policy blob is the single source of truth; the
# harness reads it from the workflow and asserts the REAL script matches
# (R40R69R1: pin freshness - a stale pin would silently break CI).
APPROVED_POLICY_BLOB_WF="$(grep -oE 'APPROVED_POLICY_BLOB="[0-9a-f]{40}"' "$WF" | head -1 | cut -d'"' -f2)"

SCHED_COMMIT_REAL="6810540ebcad1bb38d59d393dc204dca4f4b50e9"
APPROVED_PKG_BLOB="69f7972e1d3f7eaa6052310318134c8bbc0fe785"
SCHED_PKG_BLOB="461d1592cf54c86910095af62497e6ccfb444906"
APPROVED_LOCK_BLOB="b4a01df0852a348833da7408db65370d4889db46"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git -C "$REPO_ROOT" show origin/main:package.json > "$WORK/pkg_main.json"
git -C "$REPO_ROOT" show origin/main:pnpm-lock.yaml > "$WORK/lock_main.yaml"
git -C "$REPO_ROOT" show "$SCHED_COMMIT_REAL:package.json" > "$WORK/pkg_sched.json"
# unauthorized delta: an added dependency on top of the baseline content
sed 's/^  "dependencies": {$/  "dependencies": {\n    "some-unapproved-dep": "^1.0.0",/' \
  "$WORK/pkg_main.json" > "$WORK/pkg_third.json"
# tampered lockfile: blob must differ from the approved one
{ printf '# tampered\n'; cat "$WORK/lock_main.yaml"; } > "$WORK/lock_changed.yaml"

blob_of() { git hash-object "$1"; }

preflight_ok=1
[ "$(blob_of "$WORK/pkg_main.json")" = "$APPROVED_PKG_BLOB" ] || { echo "preflight FAIL: pkg_main blob"; preflight_ok=0; }
[ "$(blob_of "$WORK/pkg_sched.json")" = "$SCHED_PKG_BLOB" ] || { echo "preflight FAIL: pkg_sched blob"; preflight_ok=0; }
[ "$(blob_of "$WORK/lock_main.yaml")" = "$APPROVED_LOCK_BLOB" ] || { echo "preflight FAIL: lock_main blob"; preflight_ok=0; }
[ "$(blob_of "$WORK/pkg_third.json")" != "$APPROVED_PKG_BLOB" ] || { echo "preflight FAIL: pkg_third must differ"; preflight_ok=0; }
[ "$(blob_of "$WORK/lock_changed.yaml")" != "$APPROVED_LOCK_BLOB" ] || { echo "preflight FAIL: lock_changed must differ"; preflight_ok=0; }
# R40R69R1 pin freshness: the workflow pin must match the REAL policy script.
[ -n "$APPROVED_POLICY_BLOB_WF" ] || { echo "preflight FAIL: no APPROVED_POLICY_BLOB pin found in workflow"; preflight_ok=0; }
[ "$(blob_of "$POLICY")" = "$APPROVED_POLICY_BLOB_WF" ] || { echo "preflight FAIL: policy script blob $(blob_of "$POLICY") != workflow pin $APPROVED_POLICY_BLOB_WF (update the workflow pin after any policy edit)"; preflight_ok=0; }
if [ "$preflight_ok" != "1" ]; then exit 1; fi

# tampered policy script: any byte difference must be denied by the pin
cp "$POLICY" "$WORK/policy_tampered.sh"
printf '# tampered by a hypothetical PR\n' >> "$WORK/policy_tampered.sh"
[ "$(blob_of "$WORK/policy_tampered.sh")" != "$APPROVED_POLICY_BLOB_WF" ] || { echo "preflight FAIL: tampered policy blob must differ"; exit 1; }

# Extract the workflow's integrity segment (between the do-not-edit markers)
# so the tests execute EXACTLY the shipped check, never a replica.
integrity_snippet() {
  awk '/>>> DEP-FREEZE-POLICY-INTEGRITY/{f=1;next} /<<< DEP-FREEZE-POLICY-INTEGRITY/{f=0} f' "$WF" > "$WORK/integrity.sh"
  bash "$WORK/integrity.sh"
}

FX=""
init_fixture() {
  FX="$(mktemp -d "$WORK/fx.XXXXXX")"
  cd "$FX"
  git init -q .
  git config user.email fixture@local.test
  git config user.name fixture
  cp "$WORK/pkg_main.json" package.json
  cp "$WORK/lock_main.yaml" pnpm-lock.yaml
  echo fixture > README.md
  git add -A >/dev/null
  git commit -qm "baseline"
  git commit -qm "r5-tip" --allow-empty
}

commit_pkg() { # $1=package.json source file
  cp "$1" package.json
  git add -A >/dev/null
  git commit -qm "pkg change"
}

# synthetic PR checkout: HEAD must be a merge commit with parents (base, head)
checkout_pr_merge() { # $1=base_sha $2=head_sha
  git checkout -q -B pr-integ "$1"
  git merge -q --no-ff --no-edit "$2" >/dev/null
}

write_event() { # $1=base_sha $2=head_sha
  printf '{"pull_request":{"head":{"sha":"%s","repo":{"full_name":"pattaramet-tech/ipenovel"}},"base":{"sha":"%s"}}}' \
    "$2" "$1" > "$WORK/event.json"
}

pass=0
fail=0
check() { # $1=name $2=expected_code $3=message-substring
  local name="$1" expect="$2" want="$3"
  local out code
  # fixture override mode: CI never sets this flag (production path uses
  # the baked constants only)
  out="$(DEP_FREEZE_POLICY_ALLOW_ENV_OVERRIDES=1 bash "$POLICY" 2>&1)"
  code=$?
  if [ "$code" = "$expect" ] && printf '%s' "$out" | grep -qF "$want"; then
    pass=$((pass + 1))
    printf 'PASS %-44s exit=%s\n' "$name" "$code"
  else
    fail=$((fail + 1))
    printf 'FAIL %-44s exit=%s (want %s)\n--- output ---\n%s\n--------------\n' "$name" "$code" "$expect" "$out"
  fi
}

# --- T0: generic PR, no dependency changes, pre-merge main ------------------
init_fixture
BASE0="$(git rev-parse HEAD)"
git checkout -q -b feature-t0
echo doc > doc.txt
git add -A >/dev/null
git commit -qm "docs only"
HEAD0="$(git rev-parse HEAD)"
checkout_pr_merge "$BASE0" "$HEAD0"
write_event "$BASE0" "$HEAD0"
GITHUB_REPOSITORY=pattaramet-tech/ipenovel \
GITHUB_EVENT_NAME=pull_request \
GITHUB_BASE_REF=main \
GITHUB_HEAD_REF=feature-t0 \
GITHUB_EVENT_PATH="$WORK/event.json" \
R5_COMMIT="$BASE0" \
SCHED_COMMIT="$SCHED_COMMIT_REAL" \
  check T0_generic_pr_no_dep_changes 0 "Post-merge compatibility verified"

# --- T1: scheduler PR, exact reviewed head commit ---------------------------
init_fixture
BASE1="$(git rev-parse HEAD)"
git checkout -q -b feat/ipe-notifications-scheduler
commit_pkg "$WORK/pkg_sched.json"
SCHED1="$(git rev-parse HEAD)"
checkout_pr_merge "$BASE1" "$SCHED1"
write_event "$BASE1" "$SCHED1"
GITHUB_REPOSITORY=pattaramet-tech/ipenovel \
GITHUB_EVENT_NAME=pull_request \
GITHUB_BASE_REF=main \
GITHUB_HEAD_REF=feat/ipe-notifications-scheduler \
GITHUB_EVENT_PATH="$WORK/event.json" \
R5_COMMIT="$BASE1" \
SCHED_COMMIT="$SCHED1" \
  check T1_scheduler_positive 0 "Scheduler build-script exception verified"

# --- T2: scheduler shape but AMENDED head SHA (not the reviewed commit) -----
init_fixture
BASE2="$(git rev-parse HEAD)"
git checkout -q -b feat/ipe-notifications-scheduler
commit_pkg "$WORK/pkg_sched.json"
git commit -q --amend -m "amended: different commit, same tree"
AMENDED2="$(git rev-parse HEAD)"
checkout_pr_merge "$BASE2" "$AMENDED2"
write_event "$BASE2" "$AMENDED2"
GITHUB_REPOSITORY=pattaramet-tech/ipenovel \
GITHUB_EVENT_NAME=pull_request \
GITHUB_BASE_REF=main \
GITHUB_HEAD_REF=feat/ipe-notifications-scheduler \
GITHUB_EVENT_PATH="$WORK/event.json" \
R5_COMMIT="$BASE2" \
SCHED_COMMIT="$SCHED_COMMIT_REAL" \
  check T2_scheduler_amended_head_sha 1 "dependency blob changed after the approved Reader Session Controls merge"

# --- T3: scheduler BRANCH NAME but head commit from elsewhere ---------------
init_fixture
BASE3="$(git rev-parse HEAD)"
git checkout -q -b other-work
commit_pkg "$WORK/pkg_third.json"
OTHER3="$(git rev-parse HEAD)"
checkout_pr_merge "$BASE3" "$OTHER3"
write_event "$BASE3" "$OTHER3"
GITHUB_REPOSITORY=pattaramet-tech/ipenovel \
GITHUB_EVENT_NAME=pull_request \
GITHUB_BASE_REF=main \
GITHUB_HEAD_REF=feat/ipe-notifications-scheduler \
GITHUB_EVENT_PATH="$WORK/event.json" \
R5_COMMIT="$BASE3" \
SCHED_COMMIT="$SCHED_COMMIT_REAL" \
  check T3_scheduler_branch_wrong_head_sha 1 "dependency blob changed after the approved Reader Session Controls merge"

# --- T4: unrelated PR with an unauthorized package delta --------------------
init_fixture
BASE4="$(git rev-parse HEAD)"
git checkout -q -b feature-deps
commit_pkg "$WORK/pkg_third.json"
HEAD4="$(git rev-parse HEAD)"
checkout_pr_merge "$BASE4" "$HEAD4"
write_event "$BASE4" "$HEAD4"
GITHUB_REPOSITORY=pattaramet-tech/ipenovel \
GITHUB_EVENT_NAME=pull_request \
GITHUB_BASE_REF=main \
GITHUB_HEAD_REF=feature-deps \
GITHUB_EVENT_PATH="$WORK/event.json" \
R5_COMMIT="$BASE4" \
SCHED_COMMIT="$SCHED_COMMIT_REAL" \
  check T4_unauthorized_package_delta 1 "dependency blob changed after the approved Reader Session Controls merge"

# --- T5: scheduler shape with a CHANGED lockfile ----------------------------
init_fixture
BASE5="$(git rev-parse HEAD)"
git checkout -q -b feat/ipe-notifications-scheduler
cp "$WORK/pkg_sched.json" package.json
cp "$WORK/lock_changed.yaml" pnpm-lock.yaml
git add -A >/dev/null
git commit -qm "scheduler pkg + tampered lock"
SCHED5="$(git rev-parse HEAD)"
checkout_pr_merge "$BASE5" "$SCHED5"
write_event "$BASE5" "$SCHED5"
GITHUB_REPOSITORY=pattaramet-tech/ipenovel \
GITHUB_EVENT_NAME=pull_request \
GITHUB_BASE_REF=main \
GITHUB_HEAD_REF=feat/ipe-notifications-scheduler \
GITHUB_EVENT_PATH="$WORK/event.json" \
R5_COMMIT="$BASE5" \
SCHED_COMMIT="$SCHED5" \
  check T5_scheduler_lockfile_changed 1 "lockfile is frozen"

# --- T6: scheduler shape whose BASE is not the approved baseline ------------
init_fixture
git checkout -q -b dirty-main
commit_pkg "$WORK/pkg_third.json"
BASE6="$(git rev-parse HEAD)"
git checkout -q -b feat/ipe-notifications-scheduler
commit_pkg "$WORK/pkg_sched.json"
SCHED6="$(git rev-parse HEAD)"
checkout_pr_merge "$BASE6" "$SCHED6"
write_event "$BASE6" "$SCHED6"
GITHUB_REPOSITORY=pattaramet-tech/ipenovel \
GITHUB_EVENT_NAME=pull_request \
GITHUB_BASE_REF=main \
GITHUB_HEAD_REF=feat/ipe-notifications-scheduler \
GITHUB_EVENT_PATH="$WORK/event.json" \
R5_COMMIT="$BASE6" \
SCHED_COMMIT="$SCHED6" \
  check T6_scheduler_base_not_baseline 1 "base package.json is not the approved M29.3 baseline"

# --- T7: post-scheduler-merge PR without dependency changes -----------------
init_fixture
BASE7_MAIN="$(git rev-parse HEAD)"
git checkout -q -b sched-line
commit_pkg "$WORK/pkg_sched.json"
SCHED7="$(git rev-parse HEAD)"
git checkout -q "$BASE7_MAIN"
git merge -q --no-ff --no-edit "$SCHED7" >/dev/null   # scheduler merged into main
MERGED7="$(git rev-parse HEAD)"
git checkout -q -b feature-post
echo post > post.txt
git add -A >/dev/null
git commit -qm "docs after scheduler"
HEAD7="$(git rev-parse HEAD)"
checkout_pr_merge "$MERGED7" "$HEAD7"
write_event "$MERGED7" "$HEAD7"
GITHUB_REPOSITORY=pattaramet-tech/ipenovel \
GITHUB_EVENT_NAME=pull_request \
GITHUB_BASE_REF=main \
GITHUB_HEAD_REF=feature-post \
GITHUB_EVENT_PATH="$WORK/event.json" \
R5_COMMIT="$MERGED7" \
SCHED_COMMIT="$SCHED7" \
  check T7_post_merge_baseline_positive 0 "Post-merge compatibility verified"

# --- T8: post-scheduler-merge PR with an unauthorized package delta ---------
init_fixture
BASE8_MAIN="$(git rev-parse HEAD)"
git checkout -q -b sched-line-8
commit_pkg "$WORK/pkg_sched.json"
SCHED8="$(git rev-parse HEAD)"
git checkout -q "$BASE8_MAIN"
git merge -q --no-ff --no-edit "$SCHED8" >/dev/null
MERGED8="$(git rev-parse HEAD)"
git checkout -q -b feature-deps-8
commit_pkg "$WORK/pkg_third.json"
HEAD8="$(git rev-parse HEAD)"
checkout_pr_merge "$MERGED8" "$HEAD8"
write_event "$MERGED8" "$HEAD8"
GITHUB_REPOSITORY=pattaramet-tech/ipenovel \
GITHUB_EVENT_NAME=pull_request \
GITHUB_BASE_REF=main \
GITHUB_HEAD_REF=feature-deps-8 \
GITHUB_EVENT_PATH="$WORK/event.json" \
R5_COMMIT="$MERGED8" \
SCHED_COMMIT="$SCHED8" \
  check T8_post_merge_unauthorized_delta 1 "dependency blob changed after the approved Reader Session Controls merge"

# --- T9: Reader Session Controls exception preserved ------------------------
init_fixture
BASE9="$(git rev-parse HEAD)"
git checkout -q -b feat/reader-session-controls
mkdir -p .github/workflows
echo "gate: v1" > .github/workflows/m29-3-7-chapter-editor-release-gate.yml
git add -A >/dev/null
git commit -qm "workflow baseline"
RSC_BASE9="$(git rev-parse HEAD)"
echo "gate: v2" > .github/workflows/m29-3-7-chapter-editor-release-gate.yml
git add -A >/dev/null
git commit -qm "workflow only change"
RSC_HEAD9="$(git rev-parse HEAD)"
checkout_pr_merge "$BASE9" "$RSC_HEAD9"
write_event "$BASE9" "$RSC_HEAD9"
GITHUB_REPOSITORY=pattaramet-tech/ipenovel \
GITHUB_EVENT_NAME=pull_request \
GITHUB_BASE_REF=main \
GITHUB_HEAD_REF=feat/reader-session-controls \
GITHUB_EVENT_PATH="$WORK/event.json" \
RSC_BASE="$RSC_BASE9" \
R5_COMMIT="$BASE9" \
SCHED_COMMIT="$SCHED_COMMIT_REAL" \
  check T9_rsc_exception_preserved 0 "Reader Session Controls exception verified"

# --- T10: post-merge main dispatch with the scheduler blob ------------------
init_fixture
BASE10_MAIN="$(git rev-parse HEAD)"
git checkout -q -b sched-line-10
commit_pkg "$WORK/pkg_sched.json"
SCHED10="$(git rev-parse HEAD)"
git checkout -q "$BASE10_MAIN"
git merge -q --no-ff --no-edit "$SCHED10" >/dev/null
MERGED10="$(git rev-parse HEAD)"
write_event "$MERGED10" "$MERGED10"
GITHUB_REPOSITORY=pattaramet-tech/ipenovel \
GITHUB_EVENT_NAME=workflow_dispatch \
GITHUB_REF=refs/heads/main \
GITHUB_SHA="$MERGED10" \
GITHUB_EVENT_PATH="$WORK/event.json" \
R5_COMMIT="$MERGED10" \
SCHED_COMMIT="$SCHED10" \
  check T10_main_dispatch_post_merge 0 "Post-merge main dispatch verified"

# --- T11: PR that edits ONLY the policy script -> DENY (integrity pin) ------
init_fixture
mkdir -p scripts/ci
cp "$WORK/policy_tampered.sh" scripts/ci/dependency-freeze-policy.sh
git add -A >/dev/null
git commit -qm "tamper policy script only"
integ_out="$(integrity_snippet 2>&1)"; integ_code=$?
if [ "$integ_code" = "1" ] && printf '%s' "$integ_out" | grep -qF "integrity FAILED"; then
  pass=$((pass + 1)); printf 'PASS %-44s exit=1\n' "T11_script_only_tamper_denied"
else
  fail=$((fail + 1)); printf 'FAIL %-44s exit=%s\n--- output ---\n%s\n--------------\n' "T11_script_only_tamper_denied" "$integ_code" "$integ_out"
fi

# --- T12: policy script tamper + package.json change -> DENY ----------------
init_fixture
git checkout -q -b tamper-pr
mkdir -p scripts/ci
cp "$WORK/policy_tampered.sh" scripts/ci/dependency-freeze-policy.sh
commit_pkg "$WORK/pkg_third.json"
integ_out="$(integrity_snippet 2>&1)"; integ_code=$?
if [ "$integ_code" = "1" ] && printf '%s' "$integ_out" | grep -qF "integrity FAILED" \
   && ! printf '%s' "$integ_out" | grep -qF "Dependency exception policy satisfied"; then
  pass=$((pass + 1)); printf 'PASS %-44s exit=1\n' "T12_script_plus_pkg_tamper_denied"
else
  fail=$((fail + 1)); printf 'FAIL %-44s exit=%s\n--- output ---\n%s\n--------------\n' "T12_script_plus_pkg_tamper_denied" "$integ_code" "$integ_out"
fi

# --- T13: approved policy + scheduler exact head -> integrity PASS ---------
init_fixture
BASE13="$(git rev-parse HEAD)"
mkdir -p scripts/ci
cp "$POLICY" scripts/ci/dependency-freeze-policy.sh
git add -A >/dev/null
git commit -qm "approved policy script"
git checkout -q -b feat/ipe-notifications-scheduler
commit_pkg "$WORK/pkg_sched.json"
SCHED13="$(git rev-parse HEAD)"
checkout_pr_merge "$BASE13" "$SCHED13"
write_event "$BASE13" "$SCHED13"
integ_out="$(integrity_snippet 2>&1)"; integ_code=$?
if [ "$integ_code" = "0" ] && printf '%s' "$integ_out" | grep -qF "integrity verified"; then
  pass=$((pass + 1)); printf 'PASS %-44s exit=0\n' "T13_approved_policy_integrity_pass"
else
  fail=$((fail + 1)); printf 'FAIL %-44s exit=%s\n--- output ---\n%s\n--------------\n' "T13_approved_policy_integrity_pass" "$integ_code" "$integ_out"
fi
# ...and the full policy then accepts the exact-head scheduler PR (T1 shape,
# re-validated after the integrity gate)
GITHUB_REPOSITORY=pattaramet-tech/ipenovel \
GITHUB_EVENT_NAME=pull_request \
GITHUB_BASE_REF=main \
GITHUB_HEAD_REF=feat/ipe-notifications-scheduler \
GITHUB_EVENT_PATH="$WORK/event.json" \
R5_COMMIT="$BASE13" \
SCHED_COMMIT="$SCHED13" \
  check T13b_scheduler_after_integrity 0 "Scheduler build-script exception verified"

# --- T14: policy script MISSING -> fail-closed DENY -------------------------
init_fixture
integ_out="$(integrity_snippet 2>&1)"; integ_code=$?
if [ "$integ_code" = "1" ] && printf '%s' "$integ_out" | grep -qF "<missing>"; then
  pass=$((pass + 1)); printf 'PASS %-44s exit=1\n' "T14_script_missing_fail_closed"
else
  fail=$((fail + 1)); printf 'FAIL %-44s exit=%s\n--- output ---\n%s\n--------------\n' "T14_script_missing_fail_closed" "$integ_code" "$integ_out"
fi

# --- T15/T16: production invocation must IGNORE injected override env -------
# The CI invocation is `bash scripts/ci/dependency-freeze-policy.sh
# --production`. Fixture repos cannot contain the real approved commits, so
# the production path deterministically fails at the R5 ancestry check with
# "main base is not a descendant..." - while a BROKEN implementation that
# honored injected env vars would travel further and emit a DIFFERENT
# message. The asserted message therefore behaviorally proves that
# APPROVED_PKG_BLOB, R5_COMMIT, SCHED_COMMIT and SCHED_PKG_BLOB all stayed
# baked despite hostile environment injection.
prod_check() { # $1=name $2=expected_code $3=message-substring
  local name="$1" expect="$2" want="$3"
  local out code
  out="$(bash "$POLICY" --production 2>&1)"
  code=$?
  if [ "$code" = "$expect" ] && printf '%s' "$out" | grep -qF "$want" \
     && ! printf '%s' "$out" | grep -qF "fixture override mode active"; then
    pass=$((pass + 1))
    printf 'PASS %-44s exit=%s\n' "$name" "$code"
  else
    fail=$((fail + 1))
    printf 'FAIL %-44s exit=%s (want %s)\n--- output ---\n%s\n--------------\n' "$name" "$code" "$expect" "$out"
  fi
}

# T15: hostile APPROVED_PKG_BLOB + R5_COMMIT + the override flag, all at once
init_fixture
BASE15="$(git rev-parse HEAD)"
git checkout -q -b feature-inject-15
commit_pkg "$WORK/pkg_third.json"
HEAD15="$(git rev-parse HEAD)"
checkout_pr_merge "$BASE15" "$HEAD15"
write_event "$BASE15" "$HEAD15"
HOSTILE_BLOB="$(blob_of "$WORK/pkg_third.json")"
DEP_FREEZE_POLICY_ALLOW_ENV_OVERRIDES=1 \
APPROVED_PKG_BLOB="$HOSTILE_BLOB" \
SCHED_PKG_BLOB="$HOSTILE_BLOB" \
R5_COMMIT="$BASE15" \
SCHED_COMMIT="$SCHED_COMMIT_REAL" \
GITHUB_REPOSITORY=pattaramet-tech/ipenovel \
GITHUB_EVENT_NAME=pull_request \
GITHUB_BASE_REF=main \
GITHUB_HEAD_REF=feature-inject-15 \
GITHUB_EVENT_PATH="$WORK/event.json" \
  prod_check T15_production_ignores_injected_env 1 "main base is not a descendant of the approved Reader Session Controls merge commit"

# T16: hostile SCHED_COMMIT that MATCHES the PR head (would route into the
# scheduler exception if env were honored) must still be ignored
init_fixture
BASE16="$(git rev-parse HEAD)"
git checkout -q -b feat/ipe-notifications-scheduler
commit_pkg "$WORK/pkg_sched.json"
SCHED16="$(git rev-parse HEAD)"
checkout_pr_merge "$BASE16" "$SCHED16"
write_event "$BASE16" "$SCHED16"
DEP_FREEZE_POLICY_ALLOW_ENV_OVERRIDES=1 \
APPROVED_PKG_BLOB="$HOSTILE_BLOB" \
SCHED_PKG_BLOB="$HOSTILE_BLOB" \
SCHED_COMMIT="$SCHED16" \
R5_COMMIT="$BASE16" \
GITHUB_REPOSITORY=pattaramet-tech/ipenovel \
GITHUB_EVENT_NAME=pull_request \
GITHUB_BASE_REF=main \
GITHUB_HEAD_REF=feat/ipe-notifications-scheduler \
GITHUB_EVENT_PATH="$WORK/event.json" \
  prod_check T16_production_ignores_sched_env 1 "main base is not a descendant of the approved Reader Session Controls merge commit"

echo
echo "results: pass=$pass fail=$fail"
if [ "$fail" != "0" ]; then exit 1; fi
if [ "$pass" != "18" ]; then echo "expected 18 cases"; exit 1; fi
echo "dependency-freeze-policy: ALL 18 CASES PASS"
