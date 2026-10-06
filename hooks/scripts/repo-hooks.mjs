#!/usr/bin/env node
// repo-hooks.mjs — PreToolUse/PostToolUse hook: run a code repo's OWN Claude Code hooks for a
// tool call that targets it, when the session did not start in that repo (E17a, 0.29.0).
//
// WHY THIS EXISTS. Claude Code loads `.claude/settings.json` hooks only from the directory the
// session started in, never from a nested repo. A rebuild's sessions start in the project's
// parent directory — it holds the workbench and every code repo — so the guards
// bigin-harness-setup registers in each code repo (spec gate, bash guard, bugfix-test guard,
// commit-msg guard, injection gate and scan) never ran for any pipeline tool call, the
// orchestrator's or a lane's. In the linear rebuild, 56 of the backend's 68 slice commits added
// over 20 lines of non-test code with no PLAN.md ever existing, under a spec gate that would
// have blocked every one. Verified 2026-10-06: a nested repo's hook blocking every Write was
// bypassed from a parent-rooted session and fired from inside the repo. The repos' GIT hooks
// (pre-commit, commit-msg, pre-push) were unaffected — git runs those itself.
//
// It is a hook rather than a convention because plugin hooks DO load wherever the session
// starts (gate-guard works that way), and a guard the pipeline merely asks lanes to respect is
// the state this replaces. It runs bigin-skills' guard code unchanged: the pipeline forwards,
// it never reimplements, so the harness stays the one source of what its guards mean.
//
// WHAT IS FORWARDED. For the event it was called for, every hook the target repo registers
// whose `matcher` matches the tool, fed the same stdin payload, with cwd and
// CLAUDE_PROJECT_DIR set to the root its registrations were read from (the worktree, or its main
// checkout when the worktree carries none). Results combine strictest-first:
// block > ask > allow. A forwarded hook that times out, dies on a signal or exits with
// anything but 0 or 2 is reported as a BLOCK with its stderr — a guard that silently stopped
// running is exactly the failure this file exists for, so a crash may not read as a pass.
//
// WHAT IS NOT. SessionStart and PreCompact hooks belong to a session, and a pipeline session
// spans several repos; running one repo's canary seed or resume check for it would be wrong in
// a different way for each repo. They are not registered here, deliberately.
//
// HOW THE TARGET REPO IS FOUND. File tools: the file path (`file_path`, `notebook_path`,
// `path`). Bash: a leading `cd <dir> &&|;` or a `git -C <dir>` in the command. A Bash call
// that names no directory runs no repo hooks — the build-lane brief tells lanes to start every
// command with `cd <worktree> &&` for exactly this reason. That gap is real and is the one
// thing this hook cannot close by itself. Prefer `cd` over `git -C` even though both are
// recognised here: the harness's own commit-msg-guard parses `git commit -m` and does not see
// a message behind `git -C <dir> commit` (checked 2026-10-06 against bigin-skills 1.106.0 —
// forwarded or run directly, it allows it; the repo's git commit-msg hook still catches it).
//
// WHEN IT DOES NOTHING (fails open, exit 0): the target is in no git repo; the repo is not
// listed in the `repos.yaml` of a workbench at or directly under the session root (a lane's
// worktree counts, through its main repo); the repo has no `.claude/settings.json` hooks; or
// the session started in that repo already — Claude Code loaded its hooks itself, and
// forwarding too would run every guard twice.

import { readFileSync, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve, join, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";

const raw = (() => { try { return readFileSync(0, "utf8"); } catch { return ""; } })();
let payload;
try { payload = JSON.parse(raw); } catch { process.exit(0); }

const event = payload?.hook_event_name;
if (event !== "PreToolUse" && event !== "PostToolUse") process.exit(0);
const tool = String(payload?.tool_name || "");
const input = payload?.tool_input || {};
const sessionRoot = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
const cwd = payload?.cwd || sessionRoot;

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const unquote = (s) => s.replace(/^(["'])(.*)\1$/, "$2");

// --- the directory this call acts on -----------------------------------------------------------
const targetDir = (() => {
  const file = input.file_path || input.notebook_path || (typeof input.path === "string" ? input.path : "");
  if (file) return dirname(resolve(cwd, file));
  if (tool === "Bash" && typeof input.command === "string") {
    const cmd = input.command;
    const cd = cmd.match(/^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)/);
    const gitC = cmd.match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/);
    const dir = cd?.[1] ?? gitC?.[1];
    if (dir) return resolve(cwd, unquote(dir).replace(/^~(?=\/|$)/, process.env.HOME || "~"));
  }
  return null;
})();
if (!targetDir) process.exit(0);

// --- the git worktree it lies in, and that worktree's main repo --------------------------------
// Walk up from the nearest directory that exists (a Write may create several). `.git` is a
// directory in a main checkout and a `gitdir:` file in a linked worktree; reading it directly
// avoids spawning git on every tool call.
let dir = targetDir;
while (!existsSync(dir) && dir !== dirname(dir)) dir = dirname(dir);
let worktree = null;
for (let d = dir; d !== dirname(d); d = dirname(d)) {
  if (existsSync(join(d, ".git"))) { worktree = d; break; }
}
if (!worktree) process.exit(0);
let mainRepo = worktree;
try {
  if (statSync(join(worktree, ".git")).isFile()) {
    const gitdir = readFileSync(join(worktree, ".git"), "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    const m = gitdir && resolve(worktree, gitdir).match(/^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/);
    if (m) mainRepo = m[1];
  }
} catch { /* unreadable .git file: treat the worktree as its own repo */ }

if (real(sessionRoot) === real(worktree)) process.exit(0); // Claude Code already loaded these

// --- is it one of this project's code repos? ----------------------------------------------------
// Workbenches at the session root or one level below it — the layout rebuild-init creates
// (<project>/<name>-workbench beside the code repos). repos.yaml is read with the same
// fixed-subset regex as scripts/lanes-check.mjs and pause-check.mjs: copied, not imported, since
// a hook cannot depend on a workbench's vendored scripts. If you change one, change all three.
const workbenches = [];
const isWorkbench = (d) => existsSync(join(d, "locks", "pipeline.yaml"));
if (isWorkbench(sessionRoot)) workbenches.push(sessionRoot);
try {
  for (const e of readdirSync(sessionRoot, { withFileTypes: true })) {
    if (e.isDirectory() && isWorkbench(join(sessionRoot, e.name))) workbenches.push(join(sessionRoot, e.name));
  }
} catch { /* unreadable session root */ }
const listed = new Set();
for (const wb of workbenches) {
  const reposFile = join(wb, "repos.yaml");
  if (!existsSync(reposFile)) continue;
  for (const m of readFileSync(reposFile, "utf8").matchAll(/^\s*-\s*(?:name:\s*(\S+)\s*)?path:\s*(\S+)/gm)) {
    listed.add(real(isAbsolute(m[2]) ? m[2] : resolve(wb, m[2])));
  }
}
if (!listed.has(real(mainRepo)) && !listed.has(real(worktree))) process.exit(0);

// --- the repo's own registrations ---------------------------------------------------------------
// Read from the worktree first: a lane's branch could carry a changed guard registration, and the
// worktree is what Claude Code would have loaded had the session started there. A worktree with
// no `.claude/settings.json` of its own (the registrations never committed, or ignored) falls back
// to the main checkout's — a lane working in a fresh worktree must not slip past guards its repo
// has, which is the failure this file exists for. Hooks then run from wherever the settings came
// from, so `${CLAUDE_PROJECT_DIR}/.claude/guards/...` resolves to a file that exists.
let settings, settingsRoot = null;
for (const root of [worktree, mainRepo]) {
  try { settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8")); settingsRoot = root; break; } catch { /* next */ }
}
if (!settingsRoot) process.exit(0);
const matches = (matcher) => {
  if (!matcher || matcher === "*") return true;
  try { return new RegExp(`^(?:${matcher})$`).test(tool); } catch { return matcher === tool; }
};
const commands = [];
for (const group of settings?.hooks?.[event] || []) {
  if (!matches(group?.matcher)) continue;
  for (const h of group?.hooks || []) if (h?.type === "command" && h.command) commands.push(h);
}
if (!commands.length) process.exit(0);

// --- run them, combine strictest-first ----------------------------------------------------------
const blocks = [], asks = [], context = [];
const label = (h) => (h.command.match(/[\w.-]+\.(?:mjs|js|sh|py)/) || [h.command.slice(0, 60)])[0];
for (const h of commands) {
  const r = spawnSync("/bin/sh", ["-c", h.command], {
    input: raw, cwd: settingsRoot, encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: settingsRoot },
    timeout: (Number(h.timeout) || 60) * 1000,
  });
  const who = `${label(h)} (${settingsRoot})`;
  if (r.error || r.signal || (r.status !== 0 && r.status !== 2)) {
    blocks.push(`${who} did not complete (${r.error?.code || r.signal || `exit ${r.status}`}) — ` +
      `treated as a block, since a guard that stopped running must not read as a pass.` +
      `${r.stderr?.trim() ? `\n${r.stderr.trim()}` : ""}`);
    continue;
  }
  if (r.status === 2) { blocks.push(`${who}: ${r.stderr?.trim() || "blocked"}`); continue; }
  let out = null;
  try { out = r.stdout?.trim() ? JSON.parse(r.stdout) : null; } catch { /* plain stdout: not a decision */ }
  const hso = out?.hookSpecificOutput;
  const decision = hso?.permissionDecision || (out?.decision === "block" ? "deny" : null);
  const reason = hso?.permissionDecisionReason || out?.reason || "";
  if (decision === "deny") blocks.push(`${who}: ${reason || "denied"}`);
  else if (decision === "ask") asks.push(`${who}: ${reason}`);
  if (hso?.additionalContext) context.push(String(hso.additionalContext));
}

if (blocks.length) {
  console.error(blocks.join("\n\n"));
  process.exit(2);
}
if (asks.length || context.length) {
  const hookSpecificOutput = { hookEventName: event };
  if (asks.length && event === "PreToolUse") {
    hookSpecificOutput.permissionDecision = "ask";
    hookSpecificOutput.permissionDecisionReason = asks.join("\n\n");
  }
  if (context.length) hookSpecificOutput.additionalContext = context.join("\n\n");
  console.log(JSON.stringify({ hookSpecificOutput }));
}
process.exit(0);
