#!/usr/bin/env node
// autopilot.mjs — run-state and safety checks for unattended pipeline stretches.
// Run from the workbench root.
// Usage:
//   node scripts/autopilot.mjs preflight [--threshold 80]
//   node scripts/autopilot.mjs check
//   node scripts/autopilot.mjs engage [--threshold 80] [--phase "..."]
//   node scripts/autopilot.mjs log --unit "..." --outcome done|failed|skipped [--note "..."]
//   node scripts/autopilot.mjs disengage --reason <r> [--next "..."]
//   node scripts/autopilot.mjs status
//
// Autopilot never touches a gate. It runs the mechanical stretches BETWEEN gates and halts
// at each one; locking stays a human act (SKILL.md Step 5).
//
// Zero-dependency, same fixed YAML subset as gate.mjs and pause-check.mjs.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const STATE = join("plan", "autopilot.yaml");
const DEFAULT_THRESHOLD = 80;

// Where the status line drops its snapshot. The 5-hour and 7-day windows are piped by Claude
// Code to the STATUS LINE ONLY — not to hooks, not to the model — so the only way anything
// here can see them is if the status line has been patched to persist them. Overridable so
// the behaviour at 0%, 85% and "stale" can actually be tested.
const SNAPSHOT = process.env.REBUILD_RATE_LIMITS || join(homedir(), ".claude", ".rate-limits.json");

// A snapshot older than this is treated as no snapshot at all.
//
// 15 minutes is safe HERE specifically because `check` runs at unit boundaries. The status
// line re-renders at tool-call boundaries, not during a call (measured: one 100-second call
// saw updates at each end and a 95-second silence between), so by the time `check` runs a
// render has just happened. The guard hook can fire mid-call — a subagent writing findings
// twenty minutes into a slice build — so it uses a far looser bound for the same reason.
// See hooks/scripts/autopilot-guard.mjs.
const MAX_SNAPSHOT_AGE_S = 900;

const REASONS = [
  "usage-threshold", "gate-review", "validate-failed",
  "pause-check-unsafe", "needs-user-decision", "error", "user",
];
const OUTCOMES = ["done", "failed", "skipped"];

if (!existsSync(join("locks", "pipeline.yaml"))) {
  console.error("No locks/pipeline.yaml here — run from the workbench root.");
  process.exit(1);
}

// --- YAML subset (same rules as gate.mjs:83-89) ---------------------------------------
const needsQuoting = (s) => /: |:$|^[-?:,[\]{}#&*!|>'"%@`]|\n|^\s|\s$/.test(String(s));
const yamlStr = (s) => needsQuoting(s)
  ? `"${String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"')}"`
  : String(s);
const unquote = (s) => s !== undefined && /^".*"$/.test(s)
  ? s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\")
  : s;

const argAfter = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

// --- State file ------------------------------------------------------------------------
// Read into a plain object and rewrite whole on every mutation, exactly like gate.mjs does
// with a lock file. Nothing else writes this file, so round-tripping a fixed shape is safe.
const readState = () => {
  if (!existsSync(STATE)) return null;
  const text = readFileSync(STATE, "utf8");
  const top = (k) => unquote((text.match(new RegExp(`^${k}: (.*)$`, "m")) || [])[1]?.trim());
  const block = (name) => {
    const m = text.match(new RegExp(`^${name}:\\n((?:  [^ \\n].*\\n?)*)`, "m"));
    if (!m) return undefined;
    const out = {};
    for (const line of m[1].matchAll(/^  ([a-z_]+): (.*)$/gm)) out[line[1]] = unquote(line[2].trim());
    return out;
  };
  const log = [];
  const logBlock = text.match(/^log:\n((?:(?:[ \t]+.*)?\n)*)/m);
  if (logBlock) {
    for (const chunk of logBlock[1].split(/^  - /m).slice(1)) {
      const e = {};
      for (const line of ("  - " + chunk).matchAll(/^(?:  - |    )([a-z_]+): (.*)$/gm)) {
        e[line[1]] = unquote(line[2].trim());
      }
      if (Object.keys(e).length) log.push(e);
    }
  }
  return {
    status: top("status"),
    engaged_at: top("engaged_at"),
    engaged_phase: top("engaged_phase"),
    threshold_pct: Number(top("threshold_pct")) || DEFAULT_THRESHOLD,
    stop_at_gates: top("stop_at_gates") !== "false",
    last_check: block("last_check"),
    paused: block("paused"),
    log,
  };
};

const writeState = (s) => {
  mkdirSync("plan", { recursive: true });
  const lines = [
    "# Autopilot run state. Mutable and ungated — no gate protects plan/.",
    "# BREADCRUMBS, NOT TRUTH: on resume, re-derive the real phase from",
    "# `node scripts/gate.mjs status`. Never act on engaged_phase or paused.next_action alone.",
    "# Written by scripts/autopilot.mjs — do not edit by hand.",
    `status: ${s.status}`,
  ];
  if (s.engaged_at) lines.push(`engaged_at: ${s.engaged_at}`);
  if (s.engaged_phase) lines.push(`engaged_phase: ${yamlStr(s.engaged_phase)}`);
  lines.push(`threshold_pct: ${s.threshold_pct}`);
  lines.push(`stop_at_gates: ${s.stop_at_gates === false ? "false" : "true"}`);
  const sub = (name, obj) => {
    if (!obj) return;
    lines.push(`${name}:`);
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null || v === "") continue;
      lines.push(`  ${k}: ${typeof v === "number" ? v : yamlStr(v)}`);
    }
  };
  sub("last_check", s.last_check);
  sub("paused", s.paused);
  // `log:` with nothing under it parses as null, not [] — which fails the schema on every
  // freshly engaged run, before a single unit has been logged.
  lines.push((s.log || []).length ? "log:" : "log: []");
  for (const e of s.log || []) {
    lines.push(`  - at: ${e.at}`);
    for (const k of ["unit", "outcome", "note"]) {
      if (e[k] !== undefined && e[k] !== "") lines.push(`    ${k}: ${yamlStr(e[k])}`);
    }
  }
  writeFileSync(STATE, lines.join("\n") + "\n");
};

// Commit the state file on every mutation, and only ever this one path.
//
// Not tidiness: `gate.mjs lock` refuses to run while the working tree is dirty outside the
// lock file, because hashes computed from a dirty tree describe content the gate tag will
// not contain. Autopilot halts AT a gate and hands over to the user to lock — so leaving
// plan/autopilot.yaml uncommitted would make the very next thing the user does fail. Commit
// it here so the handover lands on a clean tree.
//
// execFileSync, not a shell string: `msg` carries a unit label the model wrote, and a slice
// name containing a quote or a backtick would otherwise be interpolated straight into a
// shell command by the one script that runs unattended.
const commitState = (msg) => {
  const git = (args) => execFileSync("git", args, { stdio: "pipe" });
  try {
    git(["add", "--", STATE]);
    try {
      git(["diff", "--cached", "--quiet", "--", STATE]);
      return; // exit 0 from --quiet means no staged change
    } catch { /* exit 1 means there is one — fall through and commit */ }
    git(["commit", "-qm", `autopilot: ${msg}`]);
  } catch { /* git unavailable or mid-rebase — never fatal */ }
};

// --- Usage snapshot ----------------------------------------------------------------------
const nowS = () => Math.floor(Date.now() / 1000);
const clock = (epoch) => new Date(epoch * 1000)
  .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const humanIn = (seconds) => {
  if (seconds <= 0) return "now";
  const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

// Returns { ok, pct, resets_at, reason } — `ok: false` means the number could not be
// established, which is never the same thing as "usage is low".
const readUsage = () => {
  if (!existsSync(SNAPSHOT)) {
    return { ok: false, reason:
      `no usage snapshot at ${SNAPSHOT}.\n` +
      `  The 5-hour window is piped only to the status line, so it has to be persisted there.\n` +
      `  Add the snapshot block to your statusLine command (see references/autopilot.md), or —\n` +
      `  if you are not on a Claude Pro/Max plan — the field does not exist and autopilot\n` +
      `  cannot watch the window at all.` };
  }
  let snap;
  try { snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")); }
  catch { return { ok: false, reason: `usage snapshot at ${SNAPSHOT} is unreadable.` }; }
  const age = nowS() - Number(snap.at || 0);
  if (!Number.isFinite(age) || age > MAX_SNAPSHOT_AGE_S) {
    return { ok: false, reason:
      `usage snapshot is stale (${Math.round(age / 60)}m old, limit ${MAX_SNAPSHOT_AGE_S / 60}m).\n` +
      `  The status line re-renders constantly in a live session, so a stale snapshot means\n` +
      `  renders have stopped — autopilot is interactive-session only.` };
  }
  const pct = Number(snap.five_hour?.used_percentage);
  if (!Number.isFinite(pct)) {
    return { ok: false, reason:
      `usage snapshot has no five_hour.used_percentage.\n` +
      `  This field exists only for Claude Pro/Max plans, and only after the session's first\n` +
      `  API response.` };
  }
  return { ok: true, pct, resets_at: Number(snap.five_hour?.resets_at) || 0,
           seven_day: Number(snap.seven_day?.used_percentage) };
};

const usageLine = (u) => {
  const resets = u.resets_at
    ? ` — window resets ${clock(u.resets_at)} (in ${humanIn(u.resets_at - nowS())})`
    : "";
  const week = Number.isFinite(u.seven_day) ? `, 7d ${Math.round(u.seven_day)}%` : "";
  return `5h usage ${Math.round(u.pct)}%${week}${resets}`;
};

const thresholdOf = (state) =>
  Number(argAfter("--threshold")) || state?.threshold_pct || DEFAULT_THRESHOLD;

// --- Commands ------------------------------------------------------------------------
const cmd = process.argv[2] || "status";
const state = readState();

if (cmd === "check") {
  // Deliberately read-only and fast: safe to call before every unit of work, and it never
  // dirties the tree. `last_check` is stamped by engage/log/disengage instead.
  //
  // Conservative where the guard hook is permissive: an unverifiable snapshot exits 3 here
  // (only autopilot calls this) but is ignored by hooks/scripts/autopilot-guard.mjs, which
  // must never break an unrelated edit.
  const threshold = thresholdOf(state);
  const u = readUsage();
  if (!u.ok) {
    console.log(`PAUSE  cannot verify usage — ${u.reason}`);
    process.exit(3);
  }
  if (u.pct >= threshold) {
    console.log(`PAUSE  ${usageLine(u)} — at or over the ${threshold}% threshold.`);
    console.log("       Run the pause procedure: save, commit, push, disengage, pause-check.");
    process.exit(3);
  }
  console.log(`OK     ${usageLine(u)} · threshold ${threshold}%`);
  process.exit(0);
}

if (cmd === "preflight") {
  const threshold = thresholdOf(state);
  const blockers = [], notes = [];

  // 1. Phase must be derivable, and there must be something left to do.
  let phase = null;
  try {
    const out = execFileSync("node", ["scripts/gate.mjs", "status"], { encoding: "utf8" });
    notes.push("gate.mjs status:\n" + out.trim().split("\n").map((l) => `    ${l}`).join("\n"));
    if (/All gates locked/.test(out)) blockers.push("pipeline is complete — all five gates are locked.");
    phase = (out.match(/^Current phase: (.+?) \(working toward/m) || [])[1] || null;
    if (!phase && !/All gates locked/.test(out)) blockers.push("gate.mjs status did not report a current phase.");
  } catch (e) {
    blockers.push(`gate.mjs status failed: ${String(e.message).split("\n")[0]}`);
  }

  // 2. Dependencies for validate.mjs / parity.mjs.
  if (!existsSync("node_modules")) {
    blockers.push("node_modules/ is missing — run `npm install`; validate and parity need it.");
  }

  // 3. Everything a session-end check already covers: dirty trees, unpushed work across
  //    repos.yaml, stashes, gates reopened but not re-locked, stray services. Reuse it
  //    rather than reimplementing any of it.
  if (!existsSync(join("scripts", "pause-check.mjs"))) {
    blockers.push("scripts/pause-check.mjs is missing — copy it from the plugin's skills/rebuild-pipeline/scripts/.");
  } else {
    let pc = "";
    try { pc = execFileSync("node", ["scripts/pause-check.mjs"], { encoding: "utf8" }); }
    catch (e) { pc = String(e.stdout || ""); }
    if (/NOT safe to pause/.test(pc)) {
      blockers.push("pause-check reports the workbench is NOT in a safe state:\n" +
        pc.split("\n").filter((l) => /^\s+- /.test(l))
          .map((l) => `      ${l.trim()}`).join("\n"));
    } else if (/Safe to pause as far as could be checked/.test(pc)) {
      notes.push("pause-check: 🟡 clean, but a remote was unreachable — unpushed tags could not be ruled out.");
    } else if (/Safe to pause/.test(pc)) {
      notes.push("pause-check: ✅ clean.");
    } else {
      blockers.push("pause-check produced no verdict — resolve that before running unattended.");
    }
  }

  // 4. The usage signal itself.
  const u = readUsage();
  if (!u.ok) blockers.push(u.reason);
  else {
    notes.push(`usage: ${usageLine(u)}`);
    if (u.pct >= threshold) {
      blockers.push(`5h usage is already ${Math.round(u.pct)}%, at or over the ${threshold}% threshold` +
        (u.resets_at ? ` — the window resets ${clock(u.resets_at)}.` : "."));
    }
  }

  // 5. A run left engaged by a session that died.
  if (state?.status === "engaged") {
    notes.push("NOTE: plan/autopilot.yaml still says `engaged` — a previous run ended without " +
      "disengaging. Re-engaging will overwrite it; its log is preserved.");
  }
  if (state?.status === "paused" && state.paused) {
    notes.push(`previous run paused (${state.paused.reason})` +
      (state.paused.next_action ? `; next_action was: ${state.paused.next_action}` : "") +
      "\n    Treat that as a hint only — the phase above is the authority.");
  }

  console.log("Autopilot preflight\n");
  for (const n of notes) console.log(`  ${n}`);
  if (blockers.length) {
    console.log("\n⛔ NOT ready for autopilot:");
    for (const b of blockers) console.log(`  - ${b}`);
    console.log("\nResolve these, then re-run preflight. Do not engage on a partial pass.");
    process.exit(1);
  }
  console.log(`\n✅ Ready for autopilot at: ${phase}`);
  console.log(`   Threshold ${threshold}% of the 5-hour window. Gates still halt for the user.`);
  console.log("   Present the brief and get explicit confirmation before engaging.");
  process.exit(0);
}

if (cmd === "engage") {
  const threshold = Number(argAfter("--threshold")) || DEFAULT_THRESHOLD;
  const u = readUsage();
  if (!u.ok) { console.error(`Cannot engage: ${u.reason}`); process.exit(1); }
  if (u.pct >= threshold) {
    console.error(`Cannot engage: ${usageLine(u)} is already at or over the ${threshold}% threshold.`);
    process.exit(1);
  }
  let phase = argAfter("--phase");
  if (!phase) {
    try {
      const out = execFileSync("node", ["scripts/gate.mjs", "status"], { encoding: "utf8" });
      phase = (out.match(/^Current phase: (.+?) \(working toward/m) || [])[1];
    } catch { /* recorded as unknown below */ }
  }
  const now = new Date().toISOString();
  writeState({
    status: "engaged",
    engaged_at: now,
    engaged_phase: phase || "unknown",
    threshold_pct: threshold,
    stop_at_gates: true,
    last_check: { at: now, five_hour_pct: Math.round(u.pct), resets_at: u.resets_at },
    paused: undefined,
    log: state?.log || [],
  });
  commitState(`engaged at ${phase || "unknown"}`);
  console.log(`Autopilot ENGAGED at: ${phase || "unknown"}`);
  console.log(`  ${usageLine(u)} · threshold ${threshold}%`);
  console.log("  Gates halt for the user. Run `check` before every unit of work.");
  process.exit(0);
}

if (cmd === "log") {
  if (!state) { console.error("Not engaged — nothing to log against."); process.exit(1); }
  const unit = argAfter("--unit");
  const outcome = argAfter("--outcome");
  if (!unit) { console.error('log requires --unit "..."'); process.exit(1); }
  if (!OUTCOMES.includes(outcome)) {
    console.error(`log requires --outcome <${OUTCOMES.join("|")}>`); process.exit(1);
  }
  const now = new Date().toISOString();
  const u = readUsage();
  state.log.push({ at: now, unit, outcome, note: argAfter("--note") });
  if (u.ok) state.last_check = { at: now, five_hour_pct: Math.round(u.pct), resets_at: u.resets_at };
  writeState(state);
  commitState(`${outcome} — ${unit}`);
  console.log(`Logged: ${unit} (${outcome})${u.ok ? ` · ${usageLine(u)}` : ""}`);
  process.exit(0);
}

if (cmd === "disengage") {
  const reason = argAfter("--reason");
  if (!REASONS.includes(reason)) {
    console.error(`disengage requires --reason <${REASONS.join("|")}>`); process.exit(1);
  }
  const now = new Date().toISOString();
  const u = readUsage();
  const base = state || { threshold_pct: DEFAULT_THRESHOLD, stop_at_gates: true, log: [] };
  writeState({
    ...base,
    status: "paused",
    paused: {
      at: now, reason,
      five_hour_pct: u.ok ? Math.round(u.pct) : undefined,
      resets_at: u.ok ? u.resets_at : undefined,
      next_action: argAfter("--next"),
    },
  });
  commitState(`paused (${reason})`);
  const done = (base.log || []).filter((e) => e.outcome === "done").length;
  console.log(`Autopilot PAUSED — ${reason}`);
  console.log(`  ${done} unit(s) completed this run.${u.ok ? ` ${usageLine(u)}` : ""}`);
  if (u.ok && u.resets_at && reason === "usage-threshold") {
    console.log(`  The 5-hour window resets ${clock(u.resets_at)} (in ${humanIn(u.resets_at - nowS())}).`);
  }
  console.log("  Now run: node scripts/pause-check.mjs — and resolve what it flags.");
  process.exit(0);
}

if (cmd === "status") {
  if (!state) { console.log("Autopilot: off (no plan/autopilot.yaml)."); process.exit(0); }
  console.log(`Autopilot: ${state.status}`);
  if (state.engaged_phase) console.log(`  engaged at: ${state.engaged_phase} (${state.engaged_at})`);
  console.log(`  threshold: ${state.threshold_pct}% · gates halt: ${state.stop_at_gates}`);
  if (state.paused) {
    console.log(`  paused ${state.paused.at} — ${state.paused.reason}`);
    if (state.paused.next_action) console.log(`  next_action (hint only): ${state.paused.next_action}`);
  }
  if (state.log.length) {
    console.log(`  ${state.log.length} unit(s) logged:`);
    for (const e of state.log.slice(-10)) console.log(`    ${e.outcome.padEnd(7)} ${e.unit}`);
  }
  const u = readUsage();
  console.log(u.ok ? `  ${usageLine(u)}` : `  usage unknown — ${u.reason.split("\n")[0]}`);
  process.exit(0);
}

console.error("Usage: autopilot.mjs preflight | check | engage | log | disengage | status");
process.exit(1);
