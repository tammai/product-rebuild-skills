#!/usr/bin/env node
// autopilot-guard.mjs — PreToolUse hook: stop an ENGAGED autopilot run once the 5-hour
// rate-limit window crosses its threshold.
//
// Why a hook rather than an instruction: "pause at 80%" written in a reference file is a
// rule the model applies to itself while mid-slice and convinced the current unit is nearly
// done. This one is not negotiable — the write simply fails, and the block message says what
// to do instead. It is the difference between a budget and a limit.
//
// It blocks exactly ONCE. `disengage` is a Bash call, which this matcher never sees, and it
// flips status to `paused` — after which this guard fails open and the model can freely write
// the drafts, commits and pause report the stop procedure requires.
//
// Exit 0 = allow. Exit 2 = block (stderr is fed back to the model).
//
// Fail-open up to the point where an engaged run is established, and closed after it. Every
// early exit below — no payload, no target path, not in a workbench, no autopilot state,
// state not `engaged` — returns 0, because none of those is an autopilot write and the guard
// must never break an unrelated edit. Once `status: engaged` is confirmed, the calculus
// inverts: an unverifiable window is not a low one, and the run has already declared itself
// unattended. Allowing writes there would mean the threshold silently stops existing exactly
// when the status line breaks — which is the one failure this guard is here to survive.
//
// The escape from a run left `engaged` by a session that died is one command, named in the
// block message: `autopilot.mjs disengage`.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";

// Deliberately far looser than the 15 minutes `autopilot.mjs check` allows, because the two
// run at different distances from a status-line render.
//
// Measured: the status line re-renders at tool-call BOUNDARIES, not during a call. Inside one
// 100-second foreground call the snapshot updated at the start, then went 95 seconds without a
// write, then updated as the call ended. `check` runs at unit boundaries, moments after a
// render, so 15 minutes there is generous. This hook can fire in the middle of a long one — a
// subagent writing its findings twenty minutes into a slice build — where the snapshot is
// legitimately old and nothing is wrong.
//
// So: 45 minutes. Long enough that no realistic single tool call trips it, short enough that a
// status line which has genuinely stopped is caught while the run is still worth stopping.
const MAX_SNAPSHOT_AGE_S = 2700;

let input = "";
try { input = readFileSync(0, "utf8"); } catch { process.exit(0); }
let payload;
try { payload = JSON.parse(input); } catch { process.exit(0); }

const target = payload?.tool_input?.file_path || payload?.tool_input?.path;
if (!target) process.exit(0);
const abs = resolve(payload?.cwd || process.cwd(), target);

// Walk up to the workbench root (same marker and same walk as gate-guard.mjs).
let root = dirname(abs);
while (root !== dirname(root)) {
  if (existsSync(join(root, "locks", "pipeline.yaml"))) break;
  root = dirname(root);
}
if (!existsSync(join(root, "locks", "pipeline.yaml"))) process.exit(0); // not in a workbench

const statePath = join(root, "plan", "autopilot.yaml");
if (!existsSync(statePath)) process.exit(0); // autopilot has never run here

let state = "";
try { state = readFileSync(statePath, "utf8"); } catch { process.exit(0); }
if (!/^status: engaged$/m.test(state)) process.exit(0); // paused or off — nothing to enforce

const threshold = Number((state.match(/^threshold_pct: (\d+)$/m) || [])[1]) || 80;

// --- from here the run is engaged: fail CLOSED ------------------------------------------

const snapshotPath = process.env.REBUILD_RATE_LIMITS
  || join(homedir(), ".claude", ".rate-limits.json");

// A subagent gets a different instruction, because the remedy is not its to run. A miner or
// spec-writer that disengaged the parent's run would be ending a session it cannot see —
// and `disengage` records a `next_action` only the orchestrator knows. So: stop, report up.
const asSubagent = Boolean(payload?.agent_id || payload?.agent_type);
const remedy = (reason, next) => asSubagent
  ? `Stop this unit now and return to your orchestrator, reporting: "${reason}".\n` +
    `Do NOT run autopilot.mjs yourself, and do not retry the write — ending the run is the\n` +
    `orchestrator's call, and it is the only one that knows what comes next.`
  : `Stop the run now — do not finish the current unit first. In order:\n` +
    `  1. node scripts/autopilot.mjs disengage --reason ${next} --next "<what comes next>"\n` +
    `     (this unblocks writing, so drafts and commits work again)\n` +
    `  2. Save any in-flight work to disk, commit, and push the workbench and every repo in repos.yaml\n` +
    `  3. node scripts/pause-check.mjs — and resolve what it flags\n` +
    `  4. Report the pause to the user and ask whether to continue after the reset or stop here.`;

const blockUnverifiable = (why) => {
  console.error(
    `Blocked: autopilot is engaged, but the 5-hour usage window cannot be verified — ${why}\n` +
    `An unverifiable window is not a low one, so the run stops rather than continuing blind.\n` +
    `If the status line has stopped writing ${snapshotPath}, that is the cause; if this run\n` +
    `was left engaged by an earlier session, disengaging clears it.\n` +
    remedy(`autopilot cannot verify the usage window — ${why}`, "error")
  );
  process.exit(2);
};

if (!existsSync(snapshotPath)) blockUnverifiable(`no snapshot at ${snapshotPath}.`);

let snap;
try { snap = JSON.parse(readFileSync(snapshotPath, "utf8")); }
catch { blockUnverifiable(`the snapshot at ${snapshotPath} is unreadable.`); }

const age = Math.floor(Date.now() / 1000) - Number(snap?.at || 0);
if (!Number.isFinite(age)) blockUnverifiable("the snapshot carries no readable timestamp.");
if (age > MAX_SNAPSHOT_AGE_S) {
  blockUnverifiable(`the snapshot is ${Math.round(age / 60)}m old (limit ${MAX_SNAPSHOT_AGE_S / 60}m).`);
}

const pct = Number(snap?.five_hour?.used_percentage);
if (!Number.isFinite(pct)) blockUnverifiable("the snapshot has no five_hour.used_percentage.");
if (pct < threshold) process.exit(0);

const resetsAt = Number(snap?.five_hour?.resets_at) || 0;
const resets = resetsAt
  ? ` The window resets at ${new Date(resetsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`
  : "";

console.error(
  `Blocked: autopilot is engaged and the 5-hour usage window is at ${Math.round(pct)}%, ` +
  `at or over its ${threshold}% threshold.${resets}\n` +
  remedy(`the 5-hour usage window is at ${Math.round(pct)}%, over the ${threshold}% threshold`,
         "usage-threshold")
);
process.exit(2);
