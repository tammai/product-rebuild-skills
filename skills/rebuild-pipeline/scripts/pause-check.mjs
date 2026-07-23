#!/usr/bin/env node
// pause-check.mjs — is it safe to pause the rebuild pipeline and resume in a new session?
// Run from the workbench root.
// Usage:
//   node scripts/pause-check.mjs
//
// This is NOT one of the pipeline's five hash-pinned gates (gate-1..gate-5) — it locks
// nothing and has no protects:/PreToolUse enforcement. It's a repeatable, advisory readiness
// check: git cleanliness across the workbench and every repo in repos.yaml, any gate left
// mid-decision (reopened but not re-locked), and docker-compose stacks left running. Exits
// 0 always; "unsafe" is communicated in the report, not a process-failure exit code, since
// nothing here should ever block a tool call the way the gate-guard hook does.
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
const parseLock = (id) => {
  const p = join(LOCKS, `${id}.yaml`);
  if (!existsSync(p)) return null;
  const text = readFileSync(p, "utf8");
  const get = (k) => (text.match(new RegExp(`^${k}: (.*)$`, "m")) || [])[1]?.trim();
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

// --- Report ---
console.log("Pause-safety check\n");
for (const n of notes) console.log(`  ${n}`);
if (issues.length) {
  console.log("\n⚠️  NOT safe to pause without a look — issues found:");
  for (const i of issues) console.log(`  - ${i}`);
  console.log("\nCommit/persist draft work, resolve any reopened gate (re-lock or explicitly " +
    "leave it open with the reason noted to the user), and stop or consciously keep running " +
    "services before ending the session.");
} else {
  console.log("\n✅ Safe to pause — git clean everywhere checked, no gate mid-decision, no " +
    "services left running.");
}
console.log("\nReminder (not scriptable): confirm nothing non-trivial exists only in this " +
  "conversation — a partial ADR, a draft matrix, in-flight findings — that hasn't reached disk.");
process.exit(0);
