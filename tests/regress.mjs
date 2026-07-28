#!/usr/bin/env node
// Regression suite for this plugin's executable surface: the six scripts under
// skills/rebuild-pipeline/scripts, the PreToolUse hook, and the shipped manifests.
//
// Run with `npm test` from the repo root. Requires ajv/ajv-formats/yaml (devDependencies)
// because validate.mjs and parity.mjs import them.
//
// Every test tagged [vX.Y.Z] reproduces a bug the CHANGELOG records as fixed at that
// version. These are the ones worth keeping honest: each was found by running the pipeline
// on a real rebuild, not by review, and each was invisible to the checks that existed at
// the time. A tagged test failing means a shipped fix came undone.
//
// Fixtures are scaffolded into a fresh mkdtemp directory and removed at the end, so this
// never touches the repo tree or any real workbench. `backup.mjs install` is deliberately
// NOT exercised — it writes a launchd/systemd unit and calls launchctl/systemctl, which is
// a change to the machine running the tests rather than to a fixture.

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync, symlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { parse as parseYaml } from "yaml";

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(PLUGIN, "skills/rebuild-pipeline/scripts");
const HOOK = join(PLUGIN, "hooks/scripts/gate-guard.mjs");
const TMP = mkdtempSync(join(tmpdir(), "rebuild-regress-"));

// Fixture repos must commit without depending on the runner's git identity (CI has none).
// These env vars override config for every child process.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "regress", GIT_AUTHOR_EMAIL: "regress@example.invalid",
  GIT_COMMITTER_NAME: "regress", GIT_COMMITTER_EMAIL: "regress@example.invalid",
  GIT_TERMINAL_PROMPT: "0",
});

let pass = 0, fail = 0, skip = 0;
const failures = [];
const t = (name, fn) => {
  try {
    if (fn() === "skip") { skip++; console.log(`SKIP ${name}`); return; }
    pass++; console.log(`ok   ${name}`);
  } catch (e) {
    fail++; failures.push({ name, msg: e.message });
    console.log(`FAIL ${name}\n       ${e.message.split("\n").join("\n       ")}`);
  }
};
const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}\n  expected: ${JSON.stringify(b)}\n  actual:   ${JSON.stringify(a)}`);
};
const has = (hay, needle, what) => {
  if (!String(hay).includes(needle)) throw new Error(`${what}\n  expected to contain: ${JSON.stringify(needle)}\n  actual: ${String(hay).slice(0, 600)}`);
};
const hasNot = (hay, needle, what) => {
  if (String(hay).includes(needle)) throw new Error(`${what}\n  expected NOT to contain: ${JSON.stringify(needle)}\n  actual: ${String(hay).slice(0, 600)}`);
};

// Never throws on a non-zero exit — returns {code, out} with stdout+stderr merged, because
// most of what is under test here IS the non-zero exit and the message that comes with it.
const run = (script, args, opts = {}) => {
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts,
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? -1, out: (e.stdout || "") + (e.stderr || "") };
  }
};
const git = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const gitQuiet = (dir, args) => { try { return git(dir, args); } catch { return null; } };

let fixtureN = 0;
// A freshly scaffolded workbench. `features` also writes and commits a valid feature matrix,
// which gate-1 protects — without it `lock gate-1` has nothing to hash.
const workbench = ({ features = false } = {}) => {
  const name = `p${++fixtureN}`;
  const r = run(join(SCRIPTS, "rebuild-init.mjs"), [name, "--dir", TMP]);
  if (r.code !== 0) throw new Error(`rebuild-init failed: ${r.out}`);
  const root = join(TMP, `${name}-workbench`);
  // Fixtures live outside the repo, so bare imports in validate.mjs/parity.mjs (ajv, yaml)
  // have nothing to resolve against. Link the repo's own install in.
  //
  // This has to be excluded via .git/info/exclude rather than relying on the scaffold's
  // `node_modules/` gitignore rule: that pattern is directory-only, and git sees a symlink
  // as a file, so the link would show up as untracked and break every clean-tree assertion.
  // A real workbench gets a real directory from `npm install`, which the shipped rule does
  // match — this is a fixture artifact, not a gap in the scaffold.
  symlinkSync(join(PLUGIN, "node_modules"), join(root, "node_modules"), "dir");
  appendFileSync(join(root, ".git/info/exclude"), "\nnode_modules\n");
  if (features) {
    writeFileSync(join(root, "matrix/features.yaml"),
      "- id: F-CORE-001\n  name: Login\n  domain: auth\n  confidence: high\n");
    git(root, ["add", "-A"]); git(root, ["commit", "-qm", "matrix"]);
  }
  return root;
};
// A bare repo standing in for a remote, so "pushed off-machine" is reachable offline.
// Kept under TMP/remotes/ rather than beside the repo it serves: `<repo>.git` as a sibling
// shares the repo's path prefix, and a lingering git process from the push would then look
// like a dev server running inside the repo to any unanchored path match.
const giveRemote = (dir, label) => {
  const bare = join(TMP, "remotes", `${label}.git`);
  mkdirSync(join(TMP, "remotes"), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", bare], { stdio: "pipe" });
  git(dir, ["remote", "add", "origin", bare]);
  git(dir, ["push", "-q", "origin", "HEAD"]);
  return bare;
};

console.log("=== gate.mjs ===");

t("gate status lists all five gates and the current phase", () => {
  const w = workbench();
  const r = run(join(w, "scripts/gate.mjs"), ["status"], { cwd: w });
  eq(r.code, 0, "exit code");
  for (const g of ["gate-1", "gate-2", "gate-3", "gate-4", "gate-5"]) has(r.out, g, `${g} listed`);
  has(r.out, "Current phase: G2 feature matrix", "current phase");
});

t("gate.mjs refuses to run outside a workbench", () => {
  const r = run(join(SCRIPTS, "gate.mjs"), ["status"], { cwd: TMP });
  eq(r.code, 1, "exit code");
  has(r.out, "run from the workbench root", "message");
});

t("lock refuses when an earlier gate is still open", () => {
  const w = workbench({ features: true });
  const r = run(join(w, "scripts/gate.mjs"), ["lock", "gate-2"], { cwd: w });
  eq(r.code, 1, "exit code");
  has(r.out, "earlier gate(s) still open: gate-1", "message");
});

t("lock refuses when nothing exists under protects:", () => {
  const w = workbench();
  const r = run(join(w, "scripts/gate.mjs"), ["lock", "gate-1"], { cwd: w });
  eq(r.code, 1, "exit code");
  has(r.out, "Nothing to lock", "message");
});

t("lock happy path: records hashes, commits, tags gate-1/v1", () => {
  const w = workbench({ features: true });
  const r = run(join(w, "scripts/gate.mjs"), ["lock", "gate-1", "--by", "tester"], { cwd: w });
  eq(r.code, 0, `exit code (out: ${r.out})`);
  has(r.out, "tagged gate-1/v1", "tag announced");
  const lock = parseYaml(readFileSync(join(w, "locks/gate-1.yaml"), "utf8"));
  eq(lock.status, "locked", "status");
  eq(lock.locked_by, "tester", "locked_by");
  const hashes = Object.keys(lock.artifact_hashes || {});
  eq(hashes.length, 1, `one hash recorded (got ${JSON.stringify(hashes)})`);
  eq(hashes[0], "matrix/features.yaml", "hashed path");
  eq(/^[0-9a-f]{64}$/.test(lock.artifact_hashes[hashes[0]]), true, "hash shape");
  eq(git(w, ["tag", "-l", "gate-1/v1"]), "gate-1/v1", "tag exists");
});

t("[v0.3.5] lock refuses a dirty tree instead of hashing content the tag won't contain", () => {
  const w = workbench({ features: true });
  writeFileSync(join(w, "matrix/features.yaml"),
    "- id: F-CORE-001\n  name: Login RENAMED\n  domain: auth\n  confidence: high\n");
  const r = run(join(w, "scripts/gate.mjs"), ["lock", "gate-1"], { cwd: w });
  eq(r.code, 1, "must refuse");
  has(r.out, "uncommitted changes outside", "explains why");
  has(r.out, "matrix/features.yaml", "names the dirty file");
  has(r.out, "Commit or stash", "tells the caller what to do");
  eq(gitQuiet(w, ["tag", "-l", "gate-1/v1"]), "", "no tag was created");
  eq(parseYaml(readFileSync(join(w, "locks/gate-1.yaml"), "utf8")).status, "open", "lock untouched");
});

t("[v0.3.5] the recorded hash matches what the gate tag actually points at", () => {
  const w = workbench({ features: true });
  run(join(w, "scripts/gate.mjs"), ["lock", "gate-1"], { cwd: w });
  const recorded = parseYaml(readFileSync(join(w, "locks/gate-1.yaml"), "utf8"))
    .artifact_hashes["matrix/features.yaml"];
  // Hash the blob as it exists INSIDE the tagged commit — the consumer's view, which is
  // what the original bug got wrong — not the working tree the lock happened to hash.
  const blobId = git(w, ["rev-parse", "gate-1/v1:matrix/features.yaml"]);
  const blob = execFileSync("git", ["cat-file", "blob", blobId], { cwd: w, maxBuffer: 1 << 24 });
  eq(createHash("sha256").update(blob).digest("hex"), recorded, "tagged content vs recorded hash");
});

t("[v0.3.5] relocking mints gate-1/v2 and leaves v1 pointing at the old commit", () => {
  const w = workbench({ features: true });
  run(join(w, "scripts/gate.mjs"), ["lock", "gate-1"], { cwd: w });
  const v1Commit = git(w, ["rev-parse", "gate-1/v1^{commit}"]);
  run(join(w, "scripts/gate.mjs"), ["reopen", "gate-1", "--reason", "taxonomy changed"], { cwd: w });
  git(w, ["add", "-A"]); git(w, ["commit", "-qm", "reopen"]);
  const r = run(join(w, "scripts/gate.mjs"), ["lock", "gate-1"], { cwd: w });
  eq(r.code, 0, `second lock (out: ${r.out})`);
  has(r.out, "tagged gate-1/v2", "v2 minted");
  has(r.out, "is a NEW tag", "re-pin warning shown");
  has(r.out, "checkout --detach gate-1/v2", "re-pin command shown");
  eq(git(w, ["rev-parse", "gate-1/v1^{commit}"]), v1Commit, "v1 must NOT have moved");
  if (v1Commit === git(w, ["rev-parse", "gate-1/v2^{commit}"])) throw new Error("v2 points at the same commit as v1");
});

t("[v0.3.1] reopen --reason containing ': ' stays valid YAML and round-trips", () => {
  const w = workbench({ features: true });
  run(join(w, "scripts/gate.mjs"), ["lock", "gate-1"], { cwd: w });
  const reason = "Add ADR-0011: deployment topology changed";
  eq(run(join(w, "scripts/gate.mjs"), ["reopen", "gate-1", "--reason", reason], { cwd: w }).code, 0, "exit code");
  const text = readFileSync(join(w, "locks/gate-1.yaml"), "utf8");
  let doc;
  try { doc = parseYaml(text); }
  catch (e) { throw new Error(`YAML no longer parses: ${e.message}\n---\n${text}`); }
  eq(doc.status, "open", "status flipped to open");
  eq(doc.history.at(-1).reason, reason, "reason round-trips exactly");
  eq(doc.history.at(-1).action, "reopened", "action");
});

t("[v0.3.3] a reason containing a newline stays on one physical line and round-trips", () => {
  const w = workbench({ features: true });
  run(join(w, "scripts/gate.mjs"), ["lock", "gate-1"], { cwd: w });
  const reason = "first line: broke\nsecond line still part of the reason";
  eq(run(join(w, "scripts/gate.mjs"), ["reopen", "gate-1", "--reason", reason], { cwd: w }).code, 0, "exit code");
  const text = readFileSync(join(w, "locks/gate-1.yaml"), "utf8");
  let doc;
  try { doc = parseYaml(text); }
  catch (e) { throw new Error(`YAML no longer parses: ${e.message}\n---\n${text}`); }
  eq(doc.history.at(-1).reason, reason, "newline reason round-trips");
  // A quoted value spanning two physical lines is what broke gate.mjs's own single-line
  // reader: it captured line 1, found no closing quote, and truncated. `lock` already wrote
  // a `reason:` line of its own, so match on this reopen's line specifically.
  const mine = text.split("\n").filter((l) => l.trimStart().startsWith("reason:") && l.includes("first line"));
  eq(mine.length, 1, `the reopen reason occupies exactly one physical line (got ${mine.length})`);
  has(mine[0], "\\n", "newline is escaped, not literal");
  has(mine[0], "second line still part of the reason", "the whole value stays on that line");
  for (const l of text.split("\n")) {
    if (l.trim() === 'second line still part of the reason"') throw new Error("value leaked onto its own line");
  }
  const st = run(join(w, "scripts/gate.mjs"), ["status"], { cwd: w });
  eq(st.code, 0, "status still parses the lock it wrote");
  has(st.out, "Taxonomy lock", "title survives alongside the escaped reason");
});

t("[v0.3.3] a title needing quotes survives a lock/reopen round-trip", () => {
  const w = workbench({ features: true });
  const p = join(w, "locks/gate-1.yaml");
  const title = "Contract lock: v2 revision";
  writeFileSync(p, readFileSync(p, "utf8").replace(/^title: .*$/m, `title: "${title}"`));
  git(w, ["add", "-A"]); git(w, ["commit", "-qm", "retitle"]);
  eq(run(join(w, "scripts/gate.mjs"), ["lock", "gate-1"], { cwd: w }).code, 0, "lock");
  eq(parseYaml(readFileSync(p, "utf8")).title, title, "title after lock");
  run(join(w, "scripts/gate.mjs"), ["reopen", "gate-1", "--reason", "x"], { cwd: w });
  eq(parseYaml(readFileSync(p, "utf8")).title, title, "title after reopen");
  const st = run(join(w, "scripts/gate.mjs"), ["status"], { cwd: w });
  has(st.out, title, "status prints the plain title");
  hasNot(st.out, '\\"', "status must not print escapes");
});

t("reopen without --reason is refused", () => {
  const w = workbench({ features: true });
  const r = run(join(w, "scripts/gate.mjs"), ["reopen", "gate-1"], { cwd: w });
  eq(r.code, 1, "exit code");
  has(r.out, "requires --reason", "message");
});

t("reopen clears locked_at/locked_by/artifact_hashes but keeps history", () => {
  const w = workbench({ features: true });
  run(join(w, "scripts/gate.mjs"), ["lock", "gate-1"], { cwd: w });
  run(join(w, "scripts/gate.mjs"), ["reopen", "gate-1", "--reason", "changed my mind"], { cwd: w });
  const doc = parseYaml(readFileSync(join(w, "locks/gate-1.yaml"), "utf8"));
  eq(doc.locked_at, undefined, "locked_at cleared");
  eq(doc.locked_by, undefined, "locked_by cleared");
  eq(doc.artifact_hashes, undefined, "artifact_hashes cleared");
  eq(doc.history.length, 2, "history keeps both events");
});

t("unknown gate id is rejected", () => {
  const w = workbench();
  const r = run(join(w, "scripts/gate.mjs"), ["lock", "gate-9"], { cwd: w });
  eq(r.code, 1, "exit code");
  has(r.out, "Unknown gate", "message");
});

console.log("\n=== validate.mjs ===");

t("a fresh scaffold validates clean", () => {
  const w = workbench({ features: true });
  const r = run(join(w, "scripts/validate.mjs"), [], { cwd: w });
  eq(r.code, 0, `exit code (out: ${r.out})`);
  has(r.out, "All artifacts valid", "summary");
});

t("[v0.3.1/v0.3.3] gate.mjs output is readable by validate.mjs's real YAML parser", () => {
  const w = workbench({ features: true });
  run(join(w, "scripts/gate.mjs"), ["lock", "gate-1"], { cwd: w });
  run(join(w, "scripts/gate.mjs"), ["reopen", "gate-1", "--reason", "ADR-11: topology\nchanged again"], { cwd: w });
  const r = run(join(w, "scripts/validate.mjs"), [], { cwd: w });
  has(r.out, "ok   locks/gate-1.yaml", "lock file passes schema validation");
  eq(r.code, 0, `exit code (out: ${r.out})`);
});

t("validate detects a modified locked artifact", () => {
  const w = workbench({ features: true });
  run(join(w, "scripts/gate.mjs"), ["lock", "gate-1"], { cwd: w });
  appendFileSync(join(w, "matrix/features.yaml"),
    "- id: F-CORE-002\n  name: Sneaky\n  domain: auth\n  confidence: low\n");
  const r = run(join(w, "scripts/validate.mjs"), [], { cwd: w });
  eq(r.code, 1, "must fail");
  has(r.out, "locked artifact modified", "message");
  has(r.out, "reopen gate-1 instead", "remediation");
});

t("validate detects a missing locked artifact", () => {
  const w = workbench({ features: true });
  run(join(w, "scripts/gate.mjs"), ["lock", "gate-1"], { cwd: w });
  rmSync(join(w, "matrix/features.yaml"));
  const r = run(join(w, "scripts/validate.mjs"), [], { cwd: w });
  eq(r.code, 1, "must fail");
  has(r.out, "locked file missing", "message");
});

t("validate detects a slice dependency cycle", () => {
  const w = workbench({ features: true });
  writeFileSync(join(w, "plan/slices.yaml"),
    "- id: S1\n  name: A\n  features: [F-CORE-001]\n  depends_on: [S2]\n  learning_goals: []\n  done_means: deployed and verified\n" +
    "- id: S2\n  name: B\n  features: [F-CORE-001]\n  depends_on: [S1]\n  learning_goals: []\n  done_means: deployed and verified\n");
  const r = run(join(w, "scripts/validate.mjs"), [], { cwd: w });
  eq(r.code, 1, "must fail");
  has(r.out, "dependency cycle", "message");
});

t("validate detects a dependency on an unknown slice", () => {
  const w = workbench({ features: true });
  writeFileSync(join(w, "plan/slices.yaml"),
    "- id: S1\n  name: A\n  features: [F-CORE-001]\n  depends_on: [S99]\n  learning_goals: []\n  done_means: deployed and verified\n");
  const r = run(join(w, "scripts/validate.mjs"), [], { cwd: w });
  eq(r.code, 1, "must fail");
  has(r.out, "depends on unknown slice S99", "message");
});

t("validate rejects a schema-invalid feature id", () => {
  const w = workbench();
  writeFileSync(join(w, "matrix/features.yaml"),
    "- id: not-a-valid-id\n  name: X\n  domain: auth\n  confidence: high\n");
  const r = run(join(w, "scripts/validate.mjs"), [], { cwd: w });
  eq(r.code, 1, "must fail");
  has(r.out, "matrix/features.yaml", "names the file");
});

console.log("\n=== gate-guard.mjs (PreToolUse hook) ===");

const hook = (payload) => {
  try {
    const out = execFileSync(process.execPath, [HOOK], {
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? -1, out: (e.stdout || "") + (e.stderr || "") };
  }
};

t("hook blocks an edit to a locked protects: path", () => {
  const w = workbench({ features: true });
  run(join(w, "scripts/gate.mjs"), ["lock", "gate-1"], { cwd: w });
  const r = hook({ cwd: w, tool_input: { file_path: join(w, "matrix/features.yaml") } });
  eq(r.code, 2, "must block with exit 2");
  has(r.out, "protected by gate-1", "explains which gate");
  has(r.out, "gate.mjs reopen gate-1", "offers the reopen path");
});

t("hook allows an edit when the gate is open", () => {
  const w = workbench({ features: true });
  eq(hook({ cwd: w, tool_input: { file_path: join(w, "matrix/features.yaml") } }).code, 0, "must allow");
});

t("hook blocks inside a locked directory but not a same-prefix sibling", () => {
  const w = workbench({ features: true });
  mkdirSync(join(w, "adr"), { recursive: true });
  writeFileSync(join(w, "adr/ADR-0001.md"), "# adr\n");
  writeFileSync(join(w, "adrenaline.md"), "not an adr\n");
  // gate-3 protects `adr/`; gate ordering blocks locking it directly this early, and the
  // prefix-matching behaviour under test is the hook's, not the lock ceremony's.
  const p = join(w, "locks/gate-3.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("status: open", "status: locked"));
  eq(hook({ cwd: w, tool_input: { file_path: join(w, "adr/ADR-0001.md") } }).code, 2, "adr/ADR-0001.md blocked");
  eq(hook({ cwd: w, tool_input: { file_path: join(w, "adrenaline.md") } }).code, 0, "adrenaline.md allowed");
});

t("hook allows paths outside any workbench", () => {
  eq(hook({ cwd: TMP, tool_input: { file_path: join(TMP, "loose.txt") } }).code, 0, "must allow");
});

t("hook fails open on malformed input", () => {
  eq(hook("not json at all").code, 0, "garbage stdin");
  eq(hook({}).code, 0, "no tool_input");
  eq(hook({ tool_input: {} }).code, 0, "no file_path");
});

t("hook reads tool_input.path as well as file_path", () => {
  const w = workbench({ features: true });
  run(join(w, "scripts/gate.mjs"), ["lock", "gate-1"], { cwd: w });
  eq(hook({ cwd: w, tool_input: { path: join(w, "matrix/features.yaml") } }).code, 2, "must block via .path too");
});

console.log("\n=== pause-check.mjs ===");

t("pause-check is shipped into the scaffold, where its own usage line points", () => {
  const w = workbench();
  if (!existsSync(join(w, "scripts/pause-check.mjs"))) {
    throw new Error("scripts/pause-check.mjs missing from the scaffold — `node scripts/pause-check.mjs` " +
      "(its own header, and g5-build.md) would fail with MODULE_NOT_FOUND");
  }
  eq(run(join(w, "scripts/pause-check.mjs"), [], { cwd: w }).code, 0, "runs from the workbench");
});

t("pause-check flags a workbench with no remote", () => {
  const w = workbench({ features: true });
  const r = run(join(w, "scripts/pause-check.mjs"), [], { cwd: w });
  eq(r.code, 0, "always exits 0 — advisory, never blocking");
  has(r.out, "NOT safe to pause", "verdict");
  has(r.out, "no git remote", "names the problem");
});

t("pause-check reports safe when clean, pushed and no gate mid-decision", () => {
  const w = workbench({ features: true });
  giveRemote(w, "wb-clean");
  const r = run(join(w, "scripts/pause-check.mjs"), [], { cwd: w });
  has(r.out, "Safe to pause", `verdict (out: ${r.out})`);
  has(r.out, "workbench: pushed to origin", "push state");
});

t("pause-check flags uncommitted work", () => {
  const w = workbench({ features: true });
  giveRemote(w, "wb-dirty");
  writeFileSync(join(w, "matrix/features.yaml"), "- id: F-CORE-009\n  name: Draft\n  domain: x\n  confidence: low\n");
  const r = run(join(w, "scripts/pause-check.mjs"), [], { cwd: w });
  has(r.out, "uncommitted change", "names the problem");
  has(r.out, "NOT safe to pause", "verdict");
});

t("pause-check flags commits that never reached a remote", () => {
  const w = workbench({ features: true });
  giveRemote(w, "wb-ahead");
  writeFileSync(join(w, "notes.md"), "local only\n");
  git(w, ["add", "-A"]); git(w, ["commit", "-qm", "local only"]);
  has(run(join(w, "scripts/pause-check.mjs"), [], { cwd: w }).out, "not on any remote", "names the problem");
});

t("[v0.3.3] a reopened gate's quoted title prints unescaped", () => {
  const w = workbench({ features: true });
  const title = "Contract lock: v2 revision";
  const p = join(w, "locks/gate-1.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace(/^title: .*$/m, `title: "${title}"`));
  git(w, ["add", "-A"]); git(w, ["commit", "-qm", "retitle"]);
  run(join(w, "scripts/gate.mjs"), ["lock", "gate-1"], { cwd: w });
  run(join(w, "scripts/gate.mjs"), ["reopen", "gate-1", "--reason", "needs rework"], { cwd: w });
  giveRemote(w, "wb-title");
  git(w, ["add", "-A"]); git(w, ["commit", "-qm", "reopened"]); git(w, ["push", "-q", "origin", "HEAD"]);
  const r = run(join(w, "scripts/pause-check.mjs"), [], { cwd: w });
  has(r.out, `gate-1 (${title}): reopened but not re-locked`, "plain title in the mid-decision message");
  hasNot(r.out, '\\"', "no escape sequences leak into the report");
  hasNot(r.out, `("${title}")`, "title is not printed still-quoted");
});

t("pause-check notes an empty repos.yaml instead of staying silent", () => {
  const w = workbench({ features: true });
  giveRemote(w, "wb-emptyrepos");
  has(run(join(w, "scripts/pause-check.mjs"), [], { cwd: w }).out,
    "repos.yaml has no repo entries", "note present");
});

t("[v0.3.2] pause-check detects a host-native dev server left running in a code repo", () => {
  const w = workbench({ features: true });
  giveRemote(w, "wb-dev");
  const code = join(TMP, "code-repo");
  mkdirSync(code, { recursive: true });
  writeFileSync(join(code, "idle.mjs"), "setTimeout(() => {}, 120000);\n");
  execFileSync("git", ["init", "-q", code], { stdio: "pipe" });
  git(code, ["add", "-A"]); git(code, ["commit", "-qm", "init"]);
  giveRemote(code, "code-repo");
  writeFileSync(join(w, "repos.yaml"), `repos:\n  - name: code-repo\n    path: ${code}\n`);
  git(w, ["add", "-A"]); git(w, ["commit", "-qm", "register repo"]); git(w, ["push", "-q", "origin", "HEAD"]);

  // Stands in for `pnpm dev`: a real process whose command line references the repo's path,
  // which is how the check finds dev servers without knowing any port or command convention.
  const child = spawn(process.execPath, [join(code, "idle.mjs")], { detached: true, stdio: "ignore" });
  child.unref();
  try {
    execFileSync("sh", ["-c", "sleep 1"], { stdio: "pipe" });
    const r = run(join(w, "scripts/pause-check.mjs"), [], { cwd: w });
    has(r.out, "still running under", "detects the process");
    has(r.out, "code-repo", "attributes it to the right repo");
    has(r.out, "NOT safe to pause", "verdict");
  } finally {
    try { process.kill(-child.pid); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  }
});

t("pause-check reports a clean code repo with no dev server running", () => {
  const w = workbench({ features: true });
  giveRemote(w, "wb-dev2");
  const code = join(TMP, "code-repo-2");
  mkdirSync(code, { recursive: true });
  writeFileSync(join(code, "README.md"), "# code\n");
  execFileSync("git", ["init", "-q", code], { stdio: "pipe" });
  git(code, ["add", "-A"]); git(code, ["commit", "-qm", "init"]);
  giveRemote(code, "code-repo-2");
  writeFileSync(join(w, "repos.yaml"), `repos:\n  - name: code-repo-2\n    path: ${code}\n`);
  git(w, ["add", "-A"]); git(w, ["commit", "-qm", "register"]); git(w, ["push", "-q", "origin", "HEAD"]);
  const r = run(join(w, "scripts/pause-check.mjs"), [], { cwd: w });
  has(r.out, "code-repo-2: no host-native process running", "no false positive");
  has(r.out, "Safe to pause", `verdict (out: ${r.out})`);
});

t("a dev server is matched by path boundary, not by prefix", () => {
  const w = workbench({ features: true });
  const code = join(TMP, "prefix-repo");
  mkdirSync(code, { recursive: true });
  writeFileSync(join(code, "README.md"), "# code\n");
  execFileSync("git", ["init", "-q", code], { stdio: "pipe" });
  git(code, ["add", "-A"]); git(code, ["commit", "-qm", "init"]);
  giveRemote(code, "prefix-repo");
  writeFileSync(join(w, "repos.yaml"), `repos:\n  - name: prefix-repo\n    path: ${code}\n`);
  const idle = join(TMP, "idle.mjs");
  writeFileSync(idle, "setTimeout(() => {}, 120000);\n");
  const spawnIdle = (...args) => {
    const c = spawn(process.execPath, [idle, ...args], { detached: true, stdio: "ignore" });
    c.unref();
    execFileSync("sh", ["-c", "sleep 1"], { stdio: "pipe" });
    return c;
  };
  const stop = (c) => { try { process.kill(-c.pid); } catch { try { c.kill("SIGKILL"); } catch { /* gone */ } } };

  // Siblings that merely extend the repo path — `<repo>.git` is the repo's own bare remote,
  // so this is the false positive people actually hit.
  const sibling = spawnIdle(`${code}.git`, `${code}-backup`, `${code}bar`);
  try {
    has(run(join(w, "scripts/pause-check.mjs"), [], { cwd: w }).out,
      "prefix-repo: no host-native process running",
      "a path that only shares the prefix is not a process inside the repo");
  } finally { stop(sibling); }

  // The boundary must still let a genuine child path through, or the check is just disabled.
  const inside = spawnIdle(join(code, "server.mjs"));
  try {
    has(run(join(w, "scripts/pause-check.mjs"), [], { cwd: w }).out,
      "still running under", "a process under the repo itself is still detected");
  } finally { stop(inside); }
});

t("pause-check refuses to run outside a workbench", () => {
  const r = run(join(SCRIPTS, "pause-check.mjs"), [], { cwd: TMP });
  eq(r.code, 1, "exit code");
  has(r.out, "run from the workbench root", "message");
});

console.log("\n=== backup.mjs ===");

t("backup status reports a workbench with no remote as unbacked", () => {
  const w = workbench({ features: true });
  const r = run(join(w, "scripts/backup.mjs"), ["status"], { cwd: w });
  eq(r.code, 0, "exit code");
  has(r.out, "NO REMOTE", "flags it");
  has(r.out, "last completed run: never", "reports no run yet");
});

t("backup status reports a pushed workbench as fully pushed", () => {
  const w = workbench({ features: true });
  giveRemote(w, "wb-backup");
  has(run(join(w, "scripts/backup.mjs"), ["status"], { cwd: w }).out, "fully pushed", "status");
});

t("[v0.4.2] the visibility warning is posture-neutral, not copyleft-specific", () => {
  const w = workbench({ features: true });
  writeFileSync(join(w, "license-posture.md"),
    "# License posture\n\nstatus: decided\n\n## Distribution intent\nprivate-learning\n");
  hasNot(run(join(w, "scripts/backup.mjs"), ["status"], { cwd: w }).out,
    "copyleft", "must not assert copyleft — the reference may be proprietary");
});

// pickNode() decides which interpreter a scheduled job is pinned to. It is evaluated from
// the real source text rather than reimplemented here, so this tests the shipped logic
// without running `install` (which would write a launchd/systemd unit on this machine).
const pickNodeSrc = (() => {
  const src = readFileSync(join(SCRIPTS, "backup.mjs"), "utf8");
  const from = src.indexOf("const versionManaged");
  const to = src.indexOf("const NODE = pickNode();");
  return from === -1 || to === -1 ? null : src.slice(from, to);
})();

t("[v0.4.1] the pickNode source block is still where the test extracts it from", () => {
  if (!pickNodeSrc) throw new Error("could not locate versionManaged..pickNode in backup.mjs");
  for (const s of ["versionManaged", "usableNode", "pickNode", "/opt/homebrew/bin/node"]) {
    has(pickNodeSrc, s, `mentions ${s}`);
  }
});

const evalPickNode = (execPathOverride) => {
  const f = join(TMP, `picknode-${++fixtureN}.mjs`);
  writeFileSync(f, `
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
Object.defineProperty(process, "execPath", { value: ${JSON.stringify(execPathOverride)} });
${pickNodeSrc}
console.log(JSON.stringify(pickNode()));
`);
  const r = run(f, []);
  if (r.code !== 0) throw new Error(`harness failed: ${r.out}`);
  return JSON.parse(r.out.trim().split("\n").pop());
};

t("[v0.4.1] a version-managed interpreter is never scheduled silently", () => {
  if (!pickNodeSrc) return "skip";
  const nvm = "/home/someone/.nvm/versions/node/v24.14.1/bin/node";
  const got = evalPickNode(nvm);
  if (got.warn === null) throw new Error("an nvm path produced no warning at all");
  const stable = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].filter(existsSync);
  if (stable.length) {
    eq(got.path, stable[0], "should prefer the stable interpreter");
    has(got.warn, "would vanish on your next node upgrade", "explains the substitution");
  } else {
    eq(got.path, nvm, "falls back to execPath when no stable node exists");
    has(got.warn, "version-manager-owned", "warns instead of pretending it is durable");
    has(got.warn, "breaks this schedule", "names the consequence");
  }
});

t("[v0.4.1] every known version manager path shape is recognised", () => {
  if (!pickNodeSrc) return "skip";
  for (const p of [
    "/home/x/.nvm/versions/node/v20.0.0/bin/node",
    "/home/x/.fnm/node-versions/v20.0.0/installation/bin/node",
    "/home/x/.asdf/installs/nodejs/20.0.0/bin/node",
    "/home/x/.volta/tools/image/node/20.0.0/bin/node",
    "/home/x/.nodenv/versions/20.0.0/bin/node",
    "/home/x/.n/bin/node",
  ]) {
    if (evalPickNode(p).warn === null) throw new Error(`${p} was treated as stable`);
  }
});

t("[v0.4.1] a stable interpreter is used as-is with no warning", () => {
  if (!pickNodeSrc) return "skip";
  const got = evalPickNode("/opt/homebrew/bin/node");
  eq(got.path, "/opt/homebrew/bin/node", "path");
  eq(got.warn, null, "no warning for a stable path");
});

t("backup install/uninstall — skipped deliberately (writes scheduler state on this machine)",
  () => "skip");

console.log("\n=== parity.mjs ===");

t("parity writes a report with coverage and slice progress", () => {
  const w = workbench();
  writeFileSync(join(w, "matrix/features.yaml"),
    "- id: F-CORE-001\n  name: Login\n  domain: auth\n  confidence: high\n  status: covered\n" +
    "- id: F-CORE-002\n  name: Logout\n  domain: auth\n  confidence: high\n  status: partial\n" +
    "- id: F-CORE-003\n  name: Reset\n  domain: auth\n  confidence: low\n  status: planned\n" +
    "- id: F-CORE-004\n  name: SSO\n  domain: auth\n  confidence: low\n  status: upstream-candidate\n");
  writeFileSync(join(w, "plan/slices.yaml"),
    "- id: S1\n  name: Auth\n  features: [F-CORE-001, F-CORE-003]\n  depends_on: []\n" +
    "  learning_goals: []\n  done_means: deployed and verified\n  status: done\n");
  const r = run(join(w, "scripts/parity.mjs"), [], { cwd: w });
  eq(r.code, 0, `exit code (out: ${r.out})`);
  has(r.out, "coverage 25%", "coverage figure");
  const report = readFileSync(join(w, `parity/${new Date().toISOString().slice(0, 10)}.md`), "utf8");
  has(report, "1/4 covered (25%)", "header line");
  has(report, "F-CORE-003 Reset", "flags a planned feature sitting in a done slice");
  has(report, "F-CORE-002 Logout", "lists partial");
  has(report, "F-CORE-004 SSO", "lists upstream candidate");
  has(report, "S1 Auth: done", "slice progress");
});

t("parity refuses without a feature matrix", () => {
  const w = workbench();
  const r = run(join(w, "scripts/parity.mjs"), [], { cwd: w });
  eq(r.code, 1, "exit code");
  has(r.out, "No matrix/features.yaml", "message");
});

console.log("\n=== rebuild-init.mjs ===");

t("scaffold contains every directory and file the pipeline expects", () => {
  const w = workbench();
  for (const p of [
    "sources.yaml", "license-posture.md", "repos.yaml", "package.json", "README.md",
    ".gitignore", ".github/workflows/validate.yml", "locks/pipeline.yaml",
    "schemas/finding.schema.json", "schemas/feature.schema.json",
    "schemas/slice.schema.json", "schemas/lock.schema.json",
    "findings/ground-truth", "findings/feature", "findings/nfr", "findings/flow",
    "matrix", "plan", "adr", "contracts/openapi", "contracts/internal",
    "contracts/asyncapi", "parity",
  ]) {
    if (!existsSync(join(w, p))) throw new Error(`missing from scaffold: ${p}`);
  }
  for (let g = 1; g <= 5; g++) {
    const doc = parseYaml(readFileSync(join(w, `locks/gate-${g}.yaml`), "utf8"));
    eq(doc.status, "open", `gate-${g} starts open`);
    eq(doc.gate, `gate-${g}`, `gate-${g} id`);
  }
});

t("the generated workflow does not fire on backup snapshot branches", () => {
  const w = workbench();
  const text = readFileSync(join(w, ".github/workflows/validate.yml"), "utf8");
  const doc = parseYaml(text);
  // YAML 1.1 reads a bare `on` key as boolean true; the 1.2 core schema keeps it a string.
  const on = doc.on ?? doc[true];
  if (!on?.push) throw new Error(`no push trigger found in:\n${text}`);
  const ignored = on.push["branches-ignore"] || [];
  if (!ignored.some((p) => String(p).startsWith("auto-backup"))) {
    throw new Error("the push trigger does not exclude auto-backup/<host>, which backup.mjs " +
      `force-pushes on every run: ${JSON.stringify(on.push)}`);
  }
  has(text, "npm run validate", "still runs the validator");
});

t("scaffold is a git repo with the initial commit already made", () => {
  const w = workbench();
  eq(git(w, ["rev-parse", "--is-inside-work-tree"]), "true", "is a repo");
  has(git(w, ["log", "--oneline"]), "workbench: scaffold", "initial commit");
  eq(git(w, ["status", "--porcelain"]), "", "clean tree");
});

t("scaffold refuses to overwrite an existing directory", () => {
  const w = workbench();
  const name = w.split("/").pop().replace(/-workbench$/, "");
  const r = run(join(SCRIPTS, "rebuild-init.mjs"), [name, "--dir", TMP]);
  eq(r.code, 1, "exit code");
  has(r.out, "Refusing to overwrite", "message");
});

t("scaffold rejects a missing project name", () => {
  const r = run(join(SCRIPTS, "rebuild-init.mjs"), ["--dir", TMP]);
  eq(r.code, 1, "exit code");
  has(r.out, "Usage:", "message");
});

t("every script the scaffold's package.json invokes was actually copied in", () => {
  const w = workbench();
  const pkg = JSON.parse(readFileSync(join(w, "package.json"), "utf8"));
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    const rel = cmd.replace(/^node /, "");
    if (!existsSync(join(w, rel))) {
      throw new Error(`package.json script "${name}" runs ${rel}, which was not copied into the scaffold`);
    }
  }
});

console.log("\n=== plugin manifests ===");

t("plugin.json parses, has a version, and that version has a CHANGELOG section", () => {
  const plugin = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin/plugin.json"), "utf8"));
  if (!plugin.version) throw new Error("plugin.json has no version");
  if (!plugin.name) throw new Error("plugin.json has no name");
  has(readFileSync(join(PLUGIN, "CHANGELOG.md"), "utf8"), `## [${plugin.version}]`,
    `CHANGELOG has a section for ${plugin.version}`);
});

t("marketplace.json parses and names this plugin", () => {
  const mkt = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin/marketplace.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin/plugin.json"), "utf8"));
  has(JSON.stringify(mkt), plugin.name, "marketplace references the plugin name");
});

t("hooks.json parses and references a hook script that exists", () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, "hooks/hooks.json"), "utf8"));
  has(JSON.stringify(hooks), "gate-guard.mjs", "references gate-guard.mjs");
  if (!existsSync(HOOK)) throw new Error("gate-guard.mjs missing");
});

// Skills and agents are addressed by a frontmatter `name:`; slash commands take their name
// from the filename, so only `description:` is required there.
const frontmatter = (f) => {
  const text = readFileSync(join(PLUGIN, f), "utf8");
  if (!text.startsWith("---\n")) throw new Error(`${f}: no frontmatter`);
  const end = text.indexOf("\n---", 4);
  if (end === -1) throw new Error(`${f}: unterminated frontmatter`);
  return text.slice(4, end);
};
const lsFiles = (...patterns) =>
  execFileSync("git", ["ls-files", ...patterns], { cwd: PLUGIN, encoding: "utf8" })
    .trim().split("\n").filter(Boolean);

t("every skill and agent declares a frontmatter name and description", () => {
  const files = lsFiles("skills/**/SKILL.md", "agents/*.md");
  if (files.length < 4) throw new Error(`expected the skill + 3 agents, found ${files.length}`);
  for (const f of files) {
    const fm = frontmatter(f);
    if (!/^name:/m.test(fm)) throw new Error(`${f}: frontmatter has no name:`);
    if (!/^description:/m.test(fm)) throw new Error(`${f}: frontmatter has no description:`);
  }
});

t("every slash command declares a frontmatter description", () => {
  const files = lsFiles("commands/*.md");
  if (!files.length) throw new Error("no command files found");
  for (const f of files) {
    if (!/^description:/m.test(frontmatter(f))) throw new Error(`${f}: frontmatter has no description:`);
  }
});

t("each agent's declared name matches the filename it ships as", () => {
  for (const f of lsFiles("agents/*.md")) {
    const declared = (frontmatter(f).match(/^name:\s*(\S+)/m) || [])[1];
    eq(declared, f.replace(/^agents\//, "").replace(/\.md$/, ""), `${f} declares name: ${declared}`);
  }
});

t("all shipped .mjs files parse as valid ES modules", () => {
  const files = lsFiles("*.mjs");
  if (files.length < 7) throw new Error(`expected the full script set, found ${files.length}`);
  for (const f of files) {
    try {
      execFileSync(process.execPath, ["--check", join(PLUGIN, f)], { stdio: "pipe" });
    } catch (e) {
      throw new Error(`${f} failed --check: ${(e.stderr || "").toString().slice(0, 300)}`);
    }
  }
});

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${"=".repeat(60)}`);
console.log(`${pass} passed, ${fail} failed, ${skip} skipped`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f.name}\n      ${f.msg.split("\n")[0]}`);
}
process.exit(fail ? 1 : 0);
