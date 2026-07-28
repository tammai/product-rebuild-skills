#!/usr/bin/env node
// backup.mjs — get the pipeline's work off this machine.
// Run from the workbench root.
// Usage:
//   node scripts/backup.mjs             push every repo now (workbench + repos.yaml)
//   node scripts/backup.mjs status      report what is exposed; push nothing
//   node scripts/backup.mjs install     schedule a daily run (launchd / systemd --user)
//   node scripts/backup.mjs uninstall   remove that schedule
//
// Why this exists: a rebuild accumulates months of decisions — findings, feature matrix,
// ADRs, gate locks, parity runs — that are NOT reproducible from the reference product.
// Re-mining a codebase gets you different findings; it does not get you back the taxonomy
// you argued yourself into. Local git protects none of that from a dead disk, and the
// pipeline otherwise never tells anyone to push.
//
// What it does per repo, workbench first (code repos pin the workbench as a submodule, so
// a pinned commit must reach the remote before the parent that references it):
//   1. push every local branch and tag to `origin`
//   2. if the tree is dirty, snapshot the uncommitted state onto `auto-backup/<host>`
//
// The snapshot never touches `main`. Gate locks hash artifact content and `gate-N/vN` tags
// are consumed as submodule pins, so an automated job committing to the mainline would
// corrupt exactly the history the gates exist to make trustworthy. It also honours
// .gitignore, so `.env` files and node_modules stay on the machine.
//
// Deliberately NOT backed up: the reference checkout. It is an upstream clone, reproducible
// from the pins in sources.yaml — which this script pushes.
//
// Exits 0 even when a repo fails, matching pause-check.mjs: a backup job should not turn a
// broken remote into a failed build step. Failures are reported in the output and the log.
// Zero-dependency: repos.yaml is parsed with the same fixed-subset regex style as gate.mjs.

import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, hostname, tmpdir, platform } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCKS = "locks";
const cmd = (process.argv[2] || "run").replace(/^--/, "");

if (["help", "h"].includes(cmd)) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8")
    .split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
if (!["run", "status", "install", "uninstall"].includes(cmd)) {
  console.error(`Unknown command: ${cmd}. Try: run | status | install | uninstall | help`);
  process.exit(1);
}

if (!existsSync(join(LOCKS, "pipeline.yaml"))) {
  console.error("No locks/pipeline.yaml here — run from the workbench root.");
  process.exit(1);
}

// --- project identity (names the schedule unit and log, so several rebuilds coexist) ---
const pipelineText = readFileSync(join(LOCKS, "pipeline.yaml"), "utf8");
const PROJECT = (pipelineText.match(/^project:\s*(\S+)/m) || [])[1] || "rebuild";
const SLUG = PROJECT.replace(/[^A-Za-z0-9._-]/g, "-");
const HOST = hostname().split(".")[0].replace(/[^A-Za-z0-9._-]/g, "-") || "unknown-host";
const SNAPSHOT_BRANCH = `auto-backup/${HOST}`;

// --- logging (outside the repo: a log file inside it would dirty the tree it backs up) ---
const isMac = platform() === "darwin";
const LOG_DIR = isMac
  ? join(homedir(), "Library", "Logs")
  : join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "rebuild-pipeline");
const LOG = join(LOG_DIR, `rebuild-backup-${SLUG}.log`);

const out = [];
const say = (s) => { out.push(s); console.log(s); };

const writeLog = () => {
  if (cmd !== "run") return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    // Keep the log bounded — this runs daily for the life of the project.
    try {
      if (statSync(LOG).size > 1_000_000) {
        const kept = readFileSync(LOG, "utf8").split("\n").slice(-200).join("\n");
        writeFileSync(LOG, `[log trimmed]\n${kept}`);
      }
    } catch { /* no log yet */ }
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    appendFileSync(LOG, out.map((l) => `${stamp} ${l}`).join("\n") + "\n");
  } catch { /* logging must never break the backup */ }
};

// --- git helpers ---
const git = (dir, args, env) => execFileSync("git", args, {
  cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  ...(env ? { env } : {}),
}).trim();

const gitOk = (dir, args, env) => { try { git(dir, args, env); return true; } catch { return false; } };
const gitTry = (dir, args) => { try { return { ok: true, out: git(dir, args) }; }
  catch (e) { return { ok: false, out: `${e.stderr || e.stdout || e.message}`.trim().replace(/\s+/g, " ") }; } };

const isGitRepo = (dir) => gitOk(dir, ["rev-parse", "--is-inside-work-tree"]);
const hasOrigin = (dir) => gitOk(dir, ["remote", "get-url", "origin"]);
const hasHead = (dir) => gitOk(dir, ["rev-parse", "--verify", "HEAD"]);
const dirtyPaths = (dir) => { const r = gitTry(dir, ["status", "--porcelain"]);
  return r.ok && r.out ? r.out.split("\n").filter(Boolean) : []; };
// Commits on local branches that no remote has. The real "how much would a dead disk cost".
const unpushed = (dir) => { const r = gitTry(dir, ["log", "--branches", "--not", "--remotes", "--oneline"]);
  return r.ok && r.out ? r.out.split("\n").filter(Boolean).length : 0; };

// --- targets: workbench first, then every repo in repos.yaml ---
const targets = [{ name: "workbench", dir: "." }];
if (existsSync("repos.yaml")) {
  const text = readFileSync("repos.yaml", "utf8");
  // Same two shapes pause-check.mjs accepts: `repos: []`, or a `- name: ... path: ...` list.
  for (const m of text.matchAll(/^\s*-\s*(?:name:\s*(\S+)\s*)?path:\s*(\S+)/gm)) {
    targets.push({ name: m[1] || m[2], dir: resolve(m[2]) });
  }
}

// --- license posture: pushing a copyleft-derived rebuild to a public remote is the one
// way this script can cause harm, so it says so rather than assuming the user remembers.
const posture = () => {
  if (!existsSync("license-posture.md")) return null;
  const t = readFileSync("license-posture.md", "utf8");
  for (const p of ["private-learning", "possible-closed-distribution", "permissive-reference"]) {
    // Skip the template's own menu line, which lists all three separated by pipes.
    const hit = t.split("\n").find((l) => l.includes(p) && !/\|/.test(l));
    if (hit) return p;
  }
  return null;
};

const visibilityAdvice = () => {
  const p = posture();
  if (p === "permissive-reference") {
    return "license-posture.md records `permissive-reference`, so visibility is your call.";
  }
  if (p) {
    return `license-posture.md records \`${p}\` — create remotes **private**. Publishing a ` +
      "copyleft-derived rebuild is distribution, and needs a G0 reopen first.";
  }
  return "license-posture.md has no recorded distribution intent yet — default to **private** remotes.";
};

// ---------------------------------------------------------------- status
if (cmd === "status") {
  console.log(`Backup status — ${PROJECT} (host ${HOST})\n`);
  let exposed = 0;
  for (const { name, dir } of targets) {
    if (!existsSync(dir)) { console.log(`  ${name}: path missing (${dir}) — skipped.`); continue; }
    if (!isGitRepo(dir)) { console.log(`  ${name}: not a git repo — skipped.`); continue; }
    if (!hasOrigin(dir)) {
      console.log(`  ${name}: ⚠️  NO REMOTE — nothing is backed up. ${dir}`);
      exposed++; continue;
    }
    const url = git(dir, ["remote", "get-url", "origin"]);
    const ahead = unpushed(dir), dirty = dirtyPaths(dir).length;
    const bits = [];
    if (ahead) { bits.push(`${ahead} unpushed commit(s)`); exposed++; }
    if (dirty) { bits.push(`${dirty} uncommitted path(s)`); exposed++; }
    console.log(`  ${name}: ${bits.length ? `⚠️  ${bits.join(", ")}` : "✅ fully pushed"} → ${url}`);
  }
  // A scheduled backup can die quietly in more ways than one — an unloaded job, an
  // interpreter removed by a node upgrade, expired push credentials. Rather than check each,
  // treat the age of the last completed run as the single honest health signal.
  let last = null;
  try {
    last = readFileSync(LOG, "utf8").trimEnd().split("\n")
      .filter((l) => /backup (OK|FINISHED)/.test(l)).pop() || null;
  } catch { /* no log yet */ }
  if (!last) {
    console.log("\n  last completed run: never — nothing has run yet. `install` schedules it.");
  } else {
    const stamp = (last.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/) || [])[1];
    const days = stamp ? Math.floor((Date.now() - new Date(stamp.replace(" ", "T")).getTime()) / 86_400_000) : null;
    const stale = days !== null && days >= 3;
    console.log(`\n  last completed run: ${last}`);
    if (stale) {
      console.log(`  ⚠️  that is ${days} days ago — the schedule may have stopped running. ` +
        "Re-run `install` and check the log.");
    }
  }
  console.log(`  log: ${LOG}`);
  console.log(`\n${visibilityAdvice()}`);
  if (exposed) console.log("\nRun `node scripts/backup.mjs` to push now, or `install` to schedule it daily.");
  process.exit(0);
}

// ---------------------------------------------------------------- install / uninstall
const LABEL = `vn.bigin.rebuild-backup.${SLUG}`;
const SERVICE = `rebuild-backup-${SLUG}`;
const SCRIPT = join(HERE, "backup.mjs");
const WORKBENCH = resolve(".");

// Schedulers run with a minimal PATH, so the unit has to name an absolute node binary.
// process.execPath is often inside a version manager, and those paths disappear on the next
// `nvm install` — the schedule would then fail silently, which is the exact failure mode this
// script exists to prevent. Prefer a stable interpreter when one is available.
const versionManaged = (p) => /\/(\.nvm|\.fnm|\.asdf|\.volta|\.nodenv|\.n)\//.test(p);
const usableNode = (p) => {
  try {
    if (!existsSync(p)) return false;
    const v = execFileSync(p, ["--version"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    return Number(v.replace(/^v/, "").split(".")[0]) >= 18;   // matches this script's syntax
  } catch { return false; }
};
const pickNode = () => {
  if (!versionManaged(process.execPath)) return { path: process.execPath, warn: null };
  const stable = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].find(usableNode);
  if (stable) {
    return { path: stable, warn: `Scheduled with ${stable} rather than ${process.execPath}: ` +
      "the latter is version-manager-owned and would vanish on your next node upgrade." };
  }
  return { path: process.execPath, warn: `⚠️  Scheduled with ${process.execPath}, which is ` +
    "version-manager-owned. Upgrading or removing that node version breaks this schedule " +
    "silently — re-run `install` after any node change, and use `status` to confirm the last " +
    "run is recent." };
};
const NODE = pickNode();

if (cmd === "install" || cmd === "uninstall") {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;

  if (isMac) {
    const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
    if (cmd === "uninstall") {
      try { execFileSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" }); } catch {}
      try { unlinkSync(plistPath); } catch {}
      console.log(`Removed schedule: ${plistPath}`);
      process.exit(0);
    }
    // RunAtLoad as well as the daily calendar entry: a laptop that is asleep at 13:00 for a
    // week would otherwise never back up, and login is the one event you can rely on.
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE.path}</string>
        <string>${SCRIPT}</string>
        <string>run</string>
    </array>
    <key>WorkingDirectory</key><string>${WORKBENCH}</string>
    <key>StartCalendarInterval</key>
    <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>0</integer></dict>
    <key>RunAtLoad</key><true/>
    <key>StandardErrorPath</key><string>${join(LOG_DIR, `rebuild-backup-${SLUG}.stderr.log`)}</string>
    <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
    mkdirSync(dirname(plistPath), { recursive: true });
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(plistPath, plist);
    try { execFileSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" }); } catch {}
    execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { stdio: "inherit" });
    console.log(`Scheduled daily (13:00) + at login: ${plistPath}`);
    console.log(`Log: ${LOG}`);
    if (NODE.warn) console.log(`\n${NODE.warn}`);
    console.log("\nPushes must work with no terminal attached. If the remote is SSH with a\n" +
      "passphrased key, add it to the keychain (`ssh-add --apple-use-keychain <key>`) — then\n" +
      "confirm with: node scripts/backup.mjs status");
    process.exit(0);
  }

  if (platform() === "linux") {
    const unitDir = join(homedir(), ".config", "systemd", "user");
    if (cmd === "uninstall") {
      try { execFileSync("systemctl", ["--user", "disable", "--now", `${SERVICE}.timer`], { stdio: "ignore" }); } catch {}
      for (const f of [`${SERVICE}.service`, `${SERVICE}.timer`]) { try { unlinkSync(join(unitDir, f)); } catch {} }
      try { execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" }); } catch {}
      console.log(`Removed schedule: ${unitDir}/${SERVICE}.{service,timer}`);
      process.exit(0);
    }
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, `${SERVICE}.service`), `[Unit]
Description=Off-machine backup for the ${PROJECT} rebuild workbench and its code repos

[Service]
Type=oneshot
WorkingDirectory=${WORKBENCH}
ExecStart=${NODE.path} ${SCRIPT} run
`);
    // Persistent=true is the systemd equivalent of RunAtLoad's safety net: a missed run
    // (machine off at 13:00) fires on the next boot instead of being skipped.
    writeFileSync(join(unitDir, `${SERVICE}.timer`), `[Unit]
Description=Daily off-machine backup for the ${PROJECT} rebuild

[Timer]
OnCalendar=*-*-* 13:00:00
Persistent=true

[Install]
WantedBy=timers.target
`);
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", `${SERVICE}.timer`], { stdio: "inherit" });
    console.log(`Scheduled daily (13:00): ${unitDir}/${SERVICE}.timer`);
    console.log(`Log: ${LOG}`);
    if (NODE.warn) console.log(`\n${NODE.warn}`);
    console.log("\nUnattended pushes need credentials available with no terminal: an SSH key\n" +
      "with no passphrase, a keyring the user session unlocks, or a git credential helper.\n" +
      "Confirm with: node scripts/backup.mjs status");
    process.exit(0);
  }

  console.log(`No built-in scheduler for platform "${platform()}". Run this daily by any means\n` +
    `you already trust (cron, Task Scheduler), from the workbench root:\n\n` +
    `  cd ${WORKBENCH} && ${NODE.path} ${SCRIPT} run\n`);
  process.exit(0);
}

// ---------------------------------------------------------------- run
say(`=== backup start — ${PROJECT} (host ${HOST}) ===`);
let failed = 0, unprotected = 0;

for (const { name, dir } of targets) {
  if (!existsSync(dir)) { say(`${name}: SKIP — path does not exist (${dir})`); failed++; continue; }
  if (!isGitRepo(dir)) { say(`${name}: SKIP — not a git repo (${dir})`); failed++; continue; }
  if (!hasOrigin(dir)) {
    say(`${name}: SKIP — no 'origin' remote, so this repo is NOT backed up (${dir})`);
    unprotected++; continue;
  }

  // 1. committed history
  for (const [what, args] of [["branches", ["push", "--all", "origin"]], ["tags", ["push", "--tags", "origin"]]]) {
    const r = gitTry(dir, args);
    if (r.ok) say(`${name}: ${what} pushed`);
    else { say(`${name}: ${what.toUpperCase()} PUSH FAILED — ${r.out}`); failed++; }
  }

  // 2. uncommitted work
  const dirty = dirtyPaths(dir);
  if (!dirty.length) { say(`${name}: tree clean, no snapshot needed`); continue; }
  if (!hasHead(dir)) { say(`${name}: ${dirty.length} uncommitted path(s) but no commit yet — commit once, then re-run`); failed++; continue; }

  // Build the snapshot in a scratch index so HEAD, the real index and the working tree are
  // left exactly as the user left them — this runs unattended, mid-edit.
  const tmpIndex = join(tmpdir(), `rebuild-backup-index-${SLUG}-${process.pid}`);
  try { rmSync(tmpIndex, { force: true }); } catch {}
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  let ok = false, why = "could not build snapshot";
  try {
    git(dir, ["read-tree", "HEAD"], env);
    git(dir, ["add", "-A", "--", ":/"], env);           // honours .gitignore: no secrets
    const tree = git(dir, ["write-tree"], env);
    const msg = `auto-backup: ${dirty.length} uncommitted path(s) on ${HOST}`;
    const commit = git(dir, ["commit-tree", tree, "-p", "HEAD", "-m", msg]);
    const r = gitTry(dir, ["push", "-f", "origin", `${commit}:refs/heads/${SNAPSHOT_BRANCH}`]);
    ok = r.ok; if (!ok) why = r.out;
  } catch (e) { why = `${e.stderr || e.message}`.trim().replace(/\s+/g, " "); }
  finally { try { rmSync(tmpIndex, { force: true }); } catch {} }

  if (ok) say(`${name}: snapshotted ${dirty.length} uncommitted path(s) → ${SNAPSHOT_BRANCH}`);
  else { say(`${name}: SNAPSHOT FAILED — ${why}`); failed++; }
}

if (unprotected) say(`${unprotected} repo(s) have no remote. ${visibilityAdvice().replace(/\*\*/g, "")}`);
say(failed || unprotected ? "=== backup FINISHED WITH ERRORS ===" : "=== backup OK ===");
writeLog();
process.exit(0);
