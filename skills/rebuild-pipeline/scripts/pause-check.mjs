#!/usr/bin/env node
// pause-check.mjs — is it safe to pause the rebuild pipeline and resume in a new session?
// Run from the workbench root.
// Usage:
//   node scripts/pause-check.mjs
//
// This is NOT one of the pipeline's five hash-pinned gates (gate-1..gate-5) — it locks
// nothing and has no protects:/PreToolUse enforcement. It's a repeatable, advisory readiness
// check: git cleanliness across the workbench and every repo in repos.yaml, whether that work
// has actually left the machine (a remote exists; no unpushed commits — including on a
// detached HEAD — no unpushed tags, no stash entries), any gate left mid-decision (reopened
// but not re-locked), docker-compose stacks left running, and host-native dev servers
// (pnpm dev, go run, etc.) left running. Exits 0 always; "unsafe"
// is communicated in the report, not a process-failure exit code, since nothing here should
// ever block a tool call the way the gate-guard hook does.
// Zero-dependency: repos.yaml is parsed with the same fixed-subset regex style as gate.mjs.

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";

const LOCKS = "locks";
const ORDER = ["gate-1", "gate-2", "gate-3", "gate-4", "gate-5"];

if (!existsSync(join(LOCKS, "pipeline.yaml"))) {
  console.error("No locks/pipeline.yaml here — run from the workbench root.");
  process.exit(1);
}

const issues = [];
const notes = [];

// --- 1. Git cleanliness: workbench + every repo in repos.yaml ---
const isGitRepo = (dir) => {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd: dir, stdio: "pipe" });
    return true;
  } catch { return false; }
};
const gitDirty = (dir) => {
  try {
    return execSync("git status --porcelain", { cwd: dir, encoding: "utf8" }).trim();
  } catch { return null; } // not a git repo, or git unavailable
};

// A commit is not durable just because it exists. "Safe to pause" has to mean the work
// survives the machine, so this also asks whether each repo has a remote and whether
// anything is sitting on a local ref no remote has seen.
const hasOrigin = (dir) => {
  try { execSync("git remote get-url origin", { cwd: dir, stdio: "pipe" }); return true; }
  catch { return false; }
};
// Refs are named explicitly rather than using `--branches` or `--all`, and both halves of
// that matter:
//   - `--branches` alone walks refs/heads only, so a commit made on a DETACHED HEAD is
//     invisible and the repo reports as fully pushed. Not exotic here — gate.mjs hands out
//     `git checkout --detach <gate-tag>` for submodule syncing, so this pipeline actively
//     puts people in that state. Hence the explicit HEAD.
//   - `--all` would over-reach the other way: it includes refs/stash, and a stash cannot be
//     pushed by any `git push`, so counting it here produces a warning whose suggested fix
//     does nothing and which therefore never clears. Stashes are real risk, but they are a
//     different problem with a different remedy — counted separately below.
// `--tags` stays in: gate-N/vN tags are consumed as submodule pins, so a tag on an unpushed
// commit is genuinely unpushed work.
const unpushedCount = (dir) => {
  try {
    const out = execSync("git log --branches --tags HEAD --not --remotes --oneline",
      { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    return out ? out.split("\n").filter(Boolean).length : 0;
  } catch { return null; }
};
// A stash is local-only by construction: it lives at refs/stash, no push sends it, and it
// survives neither a dead disk nor a fresh clone. Easy to leave behind precisely because
// `git status` then reports the tree as clean.
const stashCount = (dir) => {
  try {
    const out = execSync("git stash list", { cwd: dir, encoding: "utf8" }).trim();
    return out ? out.split("\n").filter(Boolean).length : 0;
  } catch { return 0; }
};
// Detached HEAD changes the remedy, not just the count: plain `git push` fails with
// "You are not currently on a branch", so the message has to say to land it somewhere first.
const detachedHead = (dir) => {
  try { execSync("git symbolic-ref -q HEAD", { cwd: dir, stdio: "pipe" }); return false; }
  catch { return true; }
};
// Tags are refs, not commits, so the walk above structurally cannot see them: a gate tag
// pointing at an already-pushed commit is itself still local-only. It matters because code
// repos pin the workbench as a submodule at `gate-N/vN` — a tag that never left the machine
// breaks `git clone --recurse-submodules` for everyone but you.
// The only way to know is to ask the remote, so this is the one networked check here:
// GIT_TERMINAL_PROMPT=0 and a short timeout keep it from ever hanging a session-end check,
// and it returns null (→ a note, not a blocking issue) whenever the remote can't be reached.
const unpushedTags = (dir) => {
  let local;
  try { local = execSync("git tag", { cwd: dir, encoding: "utf8" }).trim(); }
  catch { return null; }
  if (!local) return [];
  try {
    const remote = execSync("git ls-remote --tags origin", {
      cwd: dir, encoding: "utf8", timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    // Peeled annotated tags appear twice, as `<sha> refs/tags/x` and `refs/tags/x^{}`.
    const onRemote = new Set([...remote.matchAll(/refs\/tags\/(.+?)(?:\^\{\})?$/gm)].map((m) => m[1]));
    return local.split("\n").filter((t) => t && !onRemote.has(t));
  } catch { return null; }
};

const checkRepo = (label, dir) => {
  if (!existsSync(dir)) { notes.push(`${label}: path does not exist (${dir}) — skipped.`); return; }
  if (!isGitRepo(dir)) { notes.push(`${label}: not a git repo — skipped.`); return; }
  const dirty = gitDirty(dir);
  if (dirty === null) { notes.push(`${label}: git unavailable — skipped.`); return; }
  if (dirty) {
    const lines = dirty.split("\n");
    issues.push(`${label}: ${lines.length} uncommitted change(s) — ${dir}`);
  } else {
    notes.push(`${label}: clean.`);
  }

  if (!hasOrigin(dir)) {
    issues.push(`${label}: no git remote — this repo exists only on this machine (${dir}). ` +
      `Give it one: \`gh repo create <name> --private --source . --push\` (visibility follows ` +
      `license-posture.md).`);
    return;
  }
  const at = dir === "." ? "" : ` -C ${dir}`;
  const stashes = stashCount(dir);
  if (stashes) {
    issues.push(`${label}: ${stashes} stash entr${stashes === 1 ? "y" : "ies"} — a stash is ` +
      `local-only and no push sends it, so this work dies with the machine (${dir}). ` +
      `Review \`git${at} stash list\`, then pop and commit what matters or drop what doesn't.`);
  }
  const staleTags = unpushedTags(dir);
  if (staleTags === null) {
    notes.push(`${label}: could not reach origin to check tags — if you locked a gate this ` +
      `session, confirm \`git${at} push --tags\` landed.`);
  } else if (staleTags.length) {
    const shown = staleTags.slice(0, 3).join(", ") + (staleTags.length > 3 ? ", …" : "");
    issues.push(`${label}: ${staleTags.length} tag(s) not on the remote (${shown}) — ` +
      `\`git${at} push --tags\`. Code repos pin the workbench at gate tags, so an unpushed ` +
      `one breaks a fresh recursive clone.`);
  }

  const ahead = unpushedCount(dir);
  if (ahead === null) { notes.push(`${label}: could not compare against remotes — skipped.`); return; }
  if (ahead > 0) {
    issues.push(detachedHead(dir)
      ? `${label}: ${ahead} commit(s) not on any remote, and HEAD is DETACHED — they are on ` +
        `no branch, so a plain push will not send them (${dir}). Land them first: ` +
        `\`git${at} switch -c <branch>\` then \`git${at} push -u origin <branch>\`.`
      : `${label}: ${ahead} commit(s) not on any remote — \`git${at} push\`.`);
  } else {
    notes.push(`${label}: pushed to origin.`);
  }
};

checkRepo("workbench", ".");

let repoEntries = [];
if (existsSync("repos.yaml")) {
  const text = readFileSync("repos.yaml", "utf8");
  // Two supported shapes: `repos: []` (empty stub) or a `- path: ...` / `- name: ... path: ...` list.
  const pathMatches = [...text.matchAll(/^\s*-\s*(?:name:\s*(\S+)\s*)?path:\s*(\S+)/gm)];
  repoEntries = pathMatches.map((m) => ({ name: m[1] || m[2], path: m[2] }));
}
if (!repoEntries.length) {
  notes.push("repos.yaml has no repo entries — nothing outside the workbench was checked. " +
    "If code repos exist for this project, add them (see repos.yaml's own comment for the format).");
}
for (const { name, path } of repoEntries) {
  checkRepo(name, resolve(path));
}

// --- 2. Gates left mid-decision: reopened but not re-locked ---
// unquote mirrors gate.mjs's yamlStr/unquote — title may have been quoted there
// (e.g. it contains ": ") and must be unescaped the same way when read back here.
const unquote = (s) => s !== undefined && /^".*"$/.test(s)
  ? s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\")
  : s;
const parseLock = (id) => {
  const p = join(LOCKS, `${id}.yaml`);
  if (!existsSync(p)) return null;
  const text = readFileSync(p, "utf8");
  const get = (k) => unquote((text.match(new RegExp(`^${k}: (.*)$`, "m")) || [])[1]?.trim());
  const historyBlock = text.match(/history:[\s\S]*$/)?.[0] || "";
  const actions = [...historyBlock.matchAll(/^\s*-\s*action:\s*(\S+)/gm)].map((m) => m[1]);
  const lastAction = actions[actions.length - 1];
  return { id, title: get("title"), status: get("status"), lastAction };
};
for (const id of ORDER) {
  const l = parseLock(id);
  if (!l) continue;
  if (l.status === "open" && l.lastAction === "reopened") {
    issues.push(`${id} (${l.title}): reopened but not re-locked — a decision is mid-flight.`);
  } else if (l.status === "locked") {
    notes.push(`${id}: locked.`);
  } else {
    notes.push(`${id}: open (not yet reached — normal mid-pipeline state).`);
  }
}

// --- 3. Running docker-compose stacks left up ---
const checkCompose = (label, dir) => {
  const composeFile = join(dir, "docker-compose.yml");
  if (!existsSync(composeFile)) return;
  try {
    const out = execSync("docker compose ps --format '{{.Name}}\t{{.State}}'", { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (!out) { notes.push(`${label}: docker-compose.yml present, nothing running.`); return; }
    const running = out.split("\n").filter((l) => /running/i.test(l));
    if (running.length) {
      issues.push(`${label}: ${running.length} container(s) still running (docker compose ps) — ${dir}`);
    } else {
      notes.push(`${label}: docker-compose.yml present, containers stopped.`);
    }
  } catch {
    notes.push(`${label}: docker-compose.yml present, but docker is unavailable/not running — could not check.`);
  }
};
checkCompose("workbench", ".");
for (const { name, path } of repoEntries) {
  checkCompose(name, resolve(path));
}

// --- 4. Host-native dev servers left running (pnpm dev, go run, etc.) ---
// Port/command conventions vary per repo, so this doesn't guess either — it looks for any
// running process whose command line references the repo's own absolute path (true for
// `pnpm dev`/`nuxt dev`/`go run` alike, since node_modules/.bin, cli entrypoints, or the
// working directory itself all resolve under it).
const checkDevProcess = (label, dir) => {
  const abs = resolve(dir);
  const escaped = abs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    // pgrep -f is an UNANCHORED regex match, so the bare path also matches any sibling that
    // merely extends it: `/x/foo` matches `/x/foo.git`, `/x/foo-copy`, `/x/foobar`. That
    // reported a dev server in repos that had none — the likeliest false match being the
    // repo's own bare remote (`<repo>.git`) sitting next to it.
    // Require a path boundary: the next character must open a child path, be whitespace (the
    // path was the whole argument), or end the command line.
    const out = execSync(`pgrep -f "${escaped}(/|[[:space:]]|$)"`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    const pids = out.split("\n").filter(Boolean);
    if (pids.length) {
      issues.push(`${label}: ${pids.length} process(es) still running under ${abs} (e.g. a dev server) — pid(s) ${pids.join(", ")}`);
    } else {
      notes.push(`${label}: no host-native process running.`);
    }
  } catch (e) {
    if (e.status === 1) notes.push(`${label}: no host-native process running.`);
    else notes.push(`${label}: could not check for running processes (pgrep unavailable).`);
  }
};
for (const { name, path } of repoEntries) {
  checkDevProcess(name, resolve(path));
}

// --- Report ---
console.log("Pause-safety check\n");
for (const n of notes) console.log(`  ${n}`);
if (issues.length) {
  console.log("\n⚠️  NOT safe to pause without a look — issues found:");
  for (const i of issues) console.log(`  - ${i}`);
  console.log("\nCommit/persist draft work, push it off-machine, " +
    "resolve any reopened gate (re-lock or explicitly leave it open with the reason noted to " +
    "the user), and stop or consciously keep running services before ending the session.");
} else {
  console.log("\n✅ Safe to pause — git clean everywhere checked, all work pushed to a remote, " +
    "no gate mid-decision, no services left running.");
}
console.log("\nReminder (not scriptable): confirm nothing non-trivial exists only in this " +
  "conversation — a partial ADR, a draft matrix, in-flight findings — that hasn't reached disk.");
process.exit(0);
