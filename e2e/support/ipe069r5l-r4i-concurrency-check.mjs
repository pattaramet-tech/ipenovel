import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const cli = path.join(repoRoot, "node_modules", "@playwright", "test", "cli.js");
const spec = "e2e/ipe069r5l-r4g-r2-retry-qualification.spec.ts";
const probeName = "ipe069r5l-r4g-r2-retry-probe.json";
const legacyProbe = path.join(os.tmpdir(), "ipe069r5l-r4g-r2-retry-probe-run-ci.json");

function fail(message) {
  console.error("FAIL " + message);
  process.exitCode = 1;
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
  console.log("PASS " + message);
}

function runPlaywright(label, evidenceRoot, extraEnv = {}) {
  const outputDir = path.join(evidenceRoot, "playwright-output");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const env = {
    ...process.env,
    E2E_RETRY_QUALIFICATION: "1",
    E2E_RUN_ID: "ci",
    E2E_NAV_EVIDENCE_DIR: evidenceRoot,
    E2E_BASE_URL: "http://127.0.0.1:9",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ...extraEnv,
  };
  const child = spawn(
    process.execPath,
    [
      cli,
      "test",
      spec,
      "--retries=1",
      "--project=local-fixture",
      "--workers=1",
      "--reporter=line",
      "--output",
      outputDir,
    ],
    {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  let out = "";
  child.on("error", (error) => {
    out += error.code + " " + error.message;
  });
  child.stdout.on("data", (chunk) => {
    out += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    out += chunk.toString();
  });
  const done = new Promise((resolve) => {
    child.on("close", (code) => resolve({ label, code, out, evidenceRoot }));
  });
  return { child, done, label, evidenceRoot };
}

function findProbes(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const entry of fs.readdirSync(root)) {
    const probe = path.join(root, entry, probeName);
    if (fs.existsSync(probe)) found.push(probe);
  }
  return found;
}

function markers(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const entry of fs.readdirSync(root)) {
    const marker = path.join(root, entry, ".run-id");
    if (!fs.existsSync(marker)) continue;
    found.push({
      dir: path.join(root, entry),
      name: entry,
      runId: fs.readFileSync(marker, "utf8"),
    });
  }
  return found;
}

function qualificationPassed(result) {
  const passed =
    result.code === 0 &&
    /retry #1/.test(result.out) &&
    /\bflaky\b/.test(result.out) &&
    !/\d+ failed/.test(result.out);
  if (!passed) console.error(result.out);
  return passed;
}

async function pollUntil(deadlineMs, read) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    const value = read();
    if (value) return value;
    if (fs.existsSync(legacyProbe)) {
      fail("legacy shared temp probe appeared at " + legacyProbe);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return null;
}

function outsideRepo(dir) {
  const resolved = path.resolve(dir);
  return resolved !== repoRoot && !resolved.startsWith(repoRoot + path.sep);
}

function stopProcessTree(child) {
  if (process.platform === "win32") {
    return new Promise((resolve, reject) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      killer.on("error", reject);
      killer.on("close", (code) => {
        if (code === 0 || code === 128 || code === 255) resolve();
        else reject(new Error("taskkill exited " + code));
      });
    });
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  return Promise.resolve();
}

async function assertSpawnErrorIsHandled() {
  const missing = path.join(os.tmpdir(), "ipe069r4i-missing-" + process.pid);
  await new Promise((resolve, reject) => {
    const child = spawn(missing, [], { stdio: "ignore" });
    let settled = false;
    child.on("error", (error) => {
      settled = true;
      if (error.code === "ENOENT") resolve();
      else reject(error);
    });
    child.on("close", () => {
      if (!settled) reject(new Error("missing command exited without an error event"));
    });
  });
  console.log("PASS a missing command reports ENOENT on its error event");
}

async function scenarioA(stamp) {
  fs.rmSync(legacyProbe, { force: true });
  const rootA = path.join(os.tmpdir(), "ipe069r4i-a-" + stamp);
  const rootB = path.join(os.tmpdir(), "ipe069r4i-b-" + stamp);
  const releaseFile = path.join(os.tmpdir(), "ipe069r4i-release-" + stamp);
  fs.rmSync(releaseFile, { force: true });
  console.log("SCENARIO_A roots " + rootA + " | " + rootB);
  const releaseEnv = { E2E_RETRY_RELEASE_FILE: releaseFile };
  const first = runPlaywright("A", rootA, releaseEnv);
  const second = runPlaywright("B", rootB, releaseEnv);
  let seen = null;
  try {
    seen = await pollUntil(20000, () => {
      const probes = [...findProbes(rootA), ...findProbes(rootB)];
      return probes.length >= 2 ? probes : null;
    });
  } finally {
    fs.writeFileSync(releaseFile, "release");
  }
  const [left, right] = await Promise.all([first.done, second.done]);
  fs.rmSync(releaseFile, { force: true });
  assert(seen !== null && seen.length >= 2, "scenario A observed two in-directory probes");
  assert(seen[0] !== seen[1], "scenario A probes are different paths");
  assert(qualificationPassed(left), "scenario A invocation A completed its retry");
  assert(qualificationPassed(right), "scenario A invocation B completed its retry");
  const markerA = markers(rootA).filter((item) => item.runId === "ci");
  const markerB = markers(rootB).filter((item) => item.runId === "ci");
  assert(markerA.length === 1 && markerB.length === 1, "scenario A each root kept its own run marker");
  assert(path.basename(markerA[0].dir) === "run-ci", "scenario A first claim basename is run-ci");
  assert(path.basename(markerB[0].dir) === "run-ci", "scenario A second root also claimed run-ci");
  assert(findProbes(rootA).length === 0 && findProbes(rootB).length === 0, "scenario A cleaned only its probes");
  assert(!fs.existsSync(legacyProbe), "scenario A did not leave the legacy shared probe");
  assert(outsideRepo(rootA) && outsideRepo(rootB), "scenario A evidence stays outside the repository");
  return { rootA, rootB };
}

async function scenarioAInterrupted(stamp) {
  const rootA = path.join(os.tmpdir(), "ipe069r4i-kill-" + stamp);
  const rootB = path.join(os.tmpdir(), "ipe069r4i-survivor-" + stamp);
  console.log("SCENARIO_A_INTERRUPT roots " + rootA + " | " + rootB);
  const killed = runPlaywright("killed", rootA, { E2E_RETRY_HOLD_MS: "1500" });
  const probe = await pollUntil(20000, () => findProbes(rootA)[0] ?? null);
  assert(probe !== null, "scenario A interrupt observed the owned probe before kill");
  await stopProcessTree(killed.child);
  await killed.done;
  assert(fs.existsSync(probe), "scenario A interrupt left the killed run probe in place");
  const killedMarker = markers(rootA).find((item) => item.runId === "ci");
  assert(Boolean(killedMarker), "scenario A interrupt left the killed run marker");
  const survivor = runPlaywright("survivor", rootB);
  const survivorResult = await survivor.done;
  assert(qualificationPassed(survivorResult), "scenario A survivor completed its own retry");
  assert(fs.existsSync(probe), "scenario A survivor did not delete the interrupted probe");
  assert(
    fs.readFileSync(path.join(killedMarker.dir, ".run-id"), "utf8") === "ci",
    "scenario A survivor did not rewrite the interrupted marker",
  );
  const survivorMarker = markers(rootB).filter((item) => item.runId === "ci");
  assert(survivorMarker.length === 1, "scenario A survivor kept its own marker");
  assert(findProbes(rootB).length === 0, "scenario A survivor cleaned only its own probe");
  return { rootA, rootB };
}

async function scenarioB(stamp) {
  fs.rmSync(legacyProbe, { force: true });
  const shared = path.join(os.tmpdir(), "ipe069r4i-shared-" + stamp);
  console.log("SCENARIO_B root " + shared);
  const first = runPlaywright("B1", shared);
  const second = runPlaywright("B2", shared);
  const intruder = path.join(shared, "run-other-invocation");
  const injected = await pollUntil(20000, () => {
    if (findProbes(shared).length === 0) return null;
    fs.mkdirSync(intruder, { recursive: true });
    fs.writeFileSync(path.join(intruder, ".run-id"), "other-invocation", "utf8");
    return true;
  });
  const [left, right] = await Promise.all([first.done, second.done]);
  assert(injected === true, "scenario B created a sibling directory during the retry window");
  assert(qualificationPassed(left), "scenario B invocation 1 completed its retry");
  assert(qualificationPassed(right), "scenario B invocation 2 completed its retry");
  const owned = markers(shared).filter((item) => item.runId === "ci");
  assert(owned.length === 2, "scenario B atomic claim produced two directories");
  assert(new Set(owned.map((item) => item.dir)).size === 2, "scenario B directories are distinct");
  assert(
    fs.readFileSync(path.join(intruder, ".run-id"), "utf8") === "other-invocation",
    "scenario B left the unrelated directory untouched",
  );
  assert(findProbes(shared).length === 0, "scenario B cleaned probes without removing sibling directories");
  assert(!fs.existsSync(legacyProbe), "scenario B did not use the legacy shared probe");
  assert(outsideRepo(shared), "scenario B evidence stays outside the repository");
  return { shared };
}

async function scenarioD(stamp) {
  const evidence = await import(pathToFileURL(path.join(repoRoot, "e2e", "support", "evidence.ts")).href);
  const root = path.join(os.tmpdir(), "ipe069r4i-integrity-" + stamp);
  const roles = ["guest", "user", "admin"];
  const widths = [320, 390, 768, 1024, 1280, 1440, 1920];
  const required = [];
  for (const role of roles) {
    for (const width of widths) required.push(`navbar-${role}-${width}.png`);
  }
  assert(required.length === 21, "scenario D declares 21 role by viewport screenshots");

  const first = evidence.createUniqueRunEvidenceDir(root, "ci");
  evidence.writeRunMarker(first, "ci");
  for (const file of required) fs.writeFileSync(path.join(first, file), "current-run");
  const complete = evidence.evidenceCompletenessForRun(first, "ci", required);
  assert(complete.complete === true && complete.stale === false && complete.missing.length === 0,
    "scenario D accepts 21 screenshots for the current marker");

  fs.rmSync(path.join(first, required[0]));
  const missing = evidence.evidenceCompletenessForRun(first, "ci", required);
  assert(missing.complete === false && missing.missing.includes(required[0]),
    "scenario D rejects a missing current-run screenshot");

  const second = evidence.createUniqueRunEvidenceDir(root, "ci");
  evidence.writeRunMarker(second, "ci");
  assert(second !== first, "scenario D repeated run id claims a new directory");
  assert(!fs.existsSync(path.join(second, required[1])),
    "scenario D new directory does not reuse the prior screenshot");
  const prior = evidence.evidenceCompletenessForRun(second, "ci", required);
  assert(prior.complete === false, "scenario D prior screenshots do not complete the new run");

  evidence.writeRunMarker(second, "stale-run");
  for (const file of required) fs.writeFileSync(path.join(second, file), "old-run");
  const stale = evidence.evidenceCompletenessForRun(second, "ci", required);
  assert(stale.complete === false && stale.stale === true, "scenario D stale marker fails completeness");

  const listRoot = path.join(os.tmpdir(), "ipe069r4i-list-" + stamp);
  fs.mkdirSync(listRoot);
  const listChild = spawn(
    process.execPath,
    [cli, "test", "--list", "--reporter=line"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        E2E_RUN_ID: "ci",
        E2E_NAV_EVIDENCE_DIR: listRoot,
        E2E_BASE_URL: "http://127.0.0.1:9",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const listCode = await new Promise((resolve) => listChild.on("close", resolve));
  assert(listCode === 0, "scenario D playwright --list exits 0");
  assert(fs.readdirSync(listRoot).length === 0, "scenario D playwright --list creates no evidence directory");
  assert(outsideRepo(root) && outsideRepo(listRoot), "scenario D evidence roots stay outside the repository");
  return { root, listRoot };
}

const stamp = Date.now().toString();
const kept = [];
try {
  await assertSpawnErrorIsHandled();
  kept.push(await scenarioA(stamp));
  kept.push(await scenarioAInterrupted(stamp + "k"));
  kept.push(await scenarioB(stamp + "b"));
  kept.push(await scenarioD(stamp + "d"));
  console.log("ALL_SCENARIOS_PASS");
  for (const item of kept) {
    for (const dir of Object.values(item)) fs.rmSync(dir, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
