#!/usr/bin/env node
// gate.mjs — view and manage gate locks. Run from the workbench root.
// Usage:
//   node scripts/gate.mjs status
//   node scripts/gate.mjs lock <gate-id> [--by <name>]
//   node scripts/gate.mjs reopen <gate-id> --reason "..."
// Locking records sha256 hashes of every file under the gate's `protects:` paths.
// Zero-dependency: lock files use a fixed YAML subset written/parsed here.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { execSync } from "node:child_process";

const LOCKS = "locks";
const ORDER = ["gate-1", "gate-2", "gate-3", "gate-4", "gate-5"];
const PHASE_BEFORE = {
  "gate-1": "G2 feature matrix", "gate-2": "G3 milestone slicing",
  "gate-3": "G4a system design", "gate-4": "G4b data model + contracts",
  "gate-5": "GP production readiness",
};

if (!existsSync(join(LOCKS, "pipeline.yaml"))) {
  console.error("No locks/pipeline.yaml here — run from the workbench root.");
  process.exit(1);
}

const parseLock = (id) => {
  const text = readFileSync(join(LOCKS, `${id}.yaml`), "utf8");
  const get = (k) => (text.match(new RegExp(`^${k}: (.*)$`, "m")) || [])[1]?.trim();
  const protects = [...text.matchAll(/^  - (.+)$/gm)].map((m) => m[1].trim())
    .filter((p) => !p.startsWith("action:"));
  return { id, title: get("title"), status: get("status"), locked_at: get("locked_at"), text, protects };
};

const filesUnder = (p) => {
  if (!existsSync(p)) return [];
  if (statSync(p).isFile()) return [p];
  return readdirSync(p, { recursive: true })
    .map((f) => join(p, String(f))).filter((f) => statSync(f).isFile());
};
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

const cmd = process.argv[2];

if (cmd === "status" || !cmd) {
  const locks = ORDER.map(parseLock);
  for (const l of locks) {
    const mark = l.status === "locked" ? "LOCKED" : "open  ";
    console.log(`${l.id}  [${mark}]  ${l.title}${l.locked_at ? `  (${l.locked_at})` : ""}`);
  }
  const current = locks.find((l) => l.status !== "locked");
  console.log(current
    ? `\nCurrent phase: ${PHASE_BEFORE[current.id]} (working toward ${current.id})`
    : "\nAll gates locked — pipeline complete.");
  process.exit(0);
}

const id = process.argv[3];
if (!ORDER.includes(id)) { console.error(`Unknown gate: ${id}`); process.exit(1); }
const lock = parseLock(id);
const now = new Date().toISOString();
const argAfter = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

if (cmd === "lock") {
  const prevOpen = ORDER.slice(0, ORDER.indexOf(id)).map(parseLock).filter((l) => l.status !== "locked");
  if (prevOpen.length) {
    console.error(`Cannot lock ${id}: earlier gate(s) still open: ${prevOpen.map((l) => l.id).join(", ")}`);
    process.exit(1);
  }
  const hashes = lock.protects.flatMap(filesUnder).map((f) => `  ${f}: ${sha(f)}`);
  if (!hashes.length) { console.error(`Nothing to lock: no files under ${lock.protects.join(", ")}`); process.exit(1); }
  const by = argAfter("--by") || process.env.USER || "unknown";
  const history = lock.text.includes("history: []")
    ? `history:\n  - action: locked\n    at: ${now}\n    reason: gate review approved`
    : lock.text.match(/history:[\s\S]*$/)[0].trimEnd() + `\n  - action: locked\n    at: ${now}\n    reason: gate review approved`;
  writeFileSync(join(LOCKS, `${id}.yaml`),
`gate: ${id}
title: ${lock.title}
status: locked
locked_at: ${now}
locked_by: ${by}
protects:
${lock.protects.map((p) => `  - ${p}`).join("\n")}
artifact_hashes:
${hashes.join("\n")}
${history}
`);
  try {
    execSync(`git add ${LOCKS}/${id}.yaml && git commit -qm "${id}: locked" && git tag -f ${id}/v1`, { stdio: "pipe" });
    console.log(`${id} locked, committed, tagged ${id}/v1.`);
  } catch { console.log(`${id} locked. Commit and tag manually (git unavailable or dirty tree).`); }
  process.exit(0);
}

if (cmd === "reopen") {
  const reason = argAfter("--reason");
  if (!reason) { console.error("Reopening requires --reason \"...\" — it is a formal, logged event."); process.exit(1); }
  const body = lock.text
    .replace(/^status: locked$/m, "status: open")
    .replace(/^locked_at: .*$\n/m, "").replace(/^locked_by: .*$\n/m, "")
    .replace(/^artifact_hashes:[\s\S]*?(?=history:)/m, "")
    .trimEnd() + `\n  - action: reopened\n    at: ${now}\n    reason: ${reason}\n`;
  writeFileSync(join(LOCKS, `${id}.yaml`), body);
  console.log(`${id} reopened: ${reason}\nRemember: downstream artifacts built on this gate may now be stale.`);
  process.exit(0);
}

console.error("Usage: gate.mjs status | lock <gate-id> [--by <name>] | reopen <gate-id> --reason \"...\"");
process.exit(1);
