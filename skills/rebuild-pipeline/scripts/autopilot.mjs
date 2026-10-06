#!/usr/bin/env node
// autopilot.mjs — run-state and safety checks for unattended pipeline stretches.
// Run from the workbench root.
// Usage:
//   node scripts/autopilot.mjs preflight [--threshold 80] [--context-tokens 250000]
//   node scripts/autopilot.mjs check
//   node scripts/autopilot.mjs engage [--threshold 80] [--context-tokens 250000] [--phase "..."]
//   node scripts/autopilot.mjs log --unit "..." --outcome done|failed|skipped [--note "..."]
//   node scripts/autopilot.mjs disengage --reason <r> [--next "..."]
//   node scripts/autopilot.mjs status
//
// Autopilot never touches a gate. It runs the mechanical stretches BETWEEN gates and halts
// at each one; locking stays a human act (SKILL.md Step 5).
//
// Zero-dependency, same fixed YAML subset as gate.mjs and pause-check.mjs.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

// CRLF to LF on every text read. With git's core.autocrlf=true (the Windows default) the working
// copy is CRLF, and a pattern with a literal `\n` (`^slices:\n`, `^---\n`) silently matches
// nothing — read as "no such block" rather than an error. Same helper in every script that
// parses text; copied, not imported, because each is vendored and must run alone. See
// playbook.mjs's readText for the incident.
const readText = (p) => readFileSync(p, "utf8").replace(/\r\n?/g, "\n");

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

// The orchestrator's own context, in tokens, and the size at which a run halts at the next unit
// boundary so the user can start a fresh session.
//
// Cost here is context re-read on every turn, not output: one audited run held a ~445k median
// context for 5,000 turns, and one autopilot session spent 181M tokens. "One session per unit"
// was already the rule (SKILL.md, Context hygiene), but autopilot was the one mode that never
// ended a session, and it can't clear its own context, so the run has to stop and ask.
//
// Like the 5-hour window, the number is only visible to the status line (it gets
// `transcript_path`), so it is read from a snapshot the status line writes per directory
// (references/autopilot.md has the block). Unlike the window, a missing snapshot FAILS OPEN:
// this is hygiene, not a safety limit, and refusing to run without it would break every
// setup that predates the block.
const CONTEXT_DIR = process.env.REBUILD_CONTEXT_DIR || join(homedir(), ".claude", ".context");
const DEFAULT_CONTEXT_TOKENS = 250000;

const REASONS = [
  "usage-threshold", "context-threshold", "gate-review", "validate-failed",
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
  const text = readText(STATE);
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
    context_tokens: Number(top("context_tokens")) || undefined,
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
  if (s.context_tokens) lines.push(`context_tokens: ${s.context_tokens}`);
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

// The snapshot is keyed by directory, not session: autopilot cannot learn its own session id.
// The status line writes one for the session's current dir and one for its project dir; this
// walks up from the workbench root and takes the freshest match, which covers a session
// started in the workbench or in a parent of it. Two live sessions in the same directory
// overwrite each other, and the freshest wins.
const slug = (dir) => dir.replace(/[^A-Za-z0-9]/g, "-");
const readContext = () => {
  let best = null;
  for (let dir = resolve("."); ; dir = dirname(dir)) {
    const f = join(CONTEXT_DIR, `${slug(dir)}.json`);
    if (existsSync(f)) {
      try {
        const snap = JSON.parse(readFileSync(f, "utf8"));
        const age = nowS() - Number(snap.at || 0);
        if (Number.isFinite(Number(snap.tokens)) && age <= MAX_SNAPSHOT_AGE_S &&
            (!best || snap.at > best.at)) best = { ...snap, tokens: Number(snap.tokens) };
      } catch { /* unreadable: treat as absent */ }
    }
    if (dirname(dir) === dir) break;
  }
  if (!best) return { ok: false, reason: `no fresh context snapshot under ${CONTEXT_DIR} for this directory ` +
    "or a parent (add the context block to your statusLine command — references/autopilot.md)" };
  return { ok: true, tokens: best.tokens, dir: best.dir };
};
const kTok = (n) => `${Math.round(n / 1000)}k`;
const contextLimitOf = (state) =>
  Number(argAfter("--context-tokens")) || state?.context_tokens || DEFAULT_CONTEXT_TOKENS;

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
  const limit = contextLimitOf(state);
  const c = readContext();
  if (c.ok && c.tokens >= limit) {
    console.log(`PAUSE  context ${kTok(c.tokens)} tokens — at or over the ${kTok(limit)} limit.`);
    console.log("       Finish nothing new. Run the pause procedure with --reason context-threshold,");
    console.log("       then tell the user: /clear, then /rebuild to resume in a fresh session.");
    process.exit(3);
  }
  console.log(`OK     ${usageLine(u)} · threshold ${threshold}%`);
  console.log(c.ok ? `       context ${kTok(c.tokens)} tokens · limit ${kTok(limit)}`
                   : `       context unknown — ${c.reason}`);
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

  // 1b. The G0 preflight (preflight.json). An unattended run's first act at G1 is to
  //     dispatch miners at every lane in parallel, and a wrong `pinned_commit` makes every
  //     lane-D citation they write wrong — silently, because a finding's hash is of the
  //     finding, not of the thing it describes. That is the one failure an unattended run
  //     cannot notice and cannot undo cheaply: by the time a human reads it, a gate has
  //     hashed it. So Not-ready is a blocker here and not a note.
  //
  //     Absent is NOT a blocker. Every workbench scaffolded before 0.16.0 has no
  //     preflight.json and no scripts/preflight.mjs, and refusing to run unattended on that
  //     basis would break every existing project the day this shipped, for a check that has
  //     never run for them anyway.
  if (!existsSync("preflight.json")) {
    notes.push("no preflight.json — this workbench predates 0.16.0 or has not run `npm run preflight`.\n" +
      "    G0's reference check is the user's word, as it was before. Copy scripts/preflight.mjs\n" +
      "    and schemas/preflight.schema.json from the plugin to get the real one (docs/PLAYBOOK.md).");
  } else {
    let pf = null;
    try { pf = JSON.parse(readFileSync("preflight.json", "utf8")); }
    catch (e) { blockers.push(`preflight.json is unreadable (${String(e.message).split("\n")[0]}) — re-run \`npm run preflight\`.`); }
    if (pf) {
      const laneLine = Object.entries(pf.lanes || {}).map(([k, v]) => `${k}:${v}`).join(" · ");
      if (pf.verdict === "Not-ready") {
        blockers.push(`G0 preflight reads Not-ready — G1 must not dispatch miners:\n` +
          (pf.blockers || []).map((b) => `      - ${b}`).join("\n") +
          `\n      Fix the cause and re-run \`npm run preflight\`. PREFLIGHT.md has the detail.`);
      } else if (pf.verdict === "Ready-with-gaps") {
        notes.push(`preflight: 🟡 Ready-with-gaps (lanes ${laneLine}) — mining may start; the gaps are named ` +
          `in PREFLIGHT.md:\n` + (pf.gaps || []).map((g) => `    - ${g}`).join("\n"));
      } else if (pf.verdict === "Ready") {
        notes.push(`preflight: ✅ Ready (lanes ${laneLine}).`);
      } else {
        blockers.push(`preflight.json carries no recognised verdict (${pf.verdict}) — re-run \`npm run preflight\`.`);
      }
    }
  }

  // 2. Dependencies for validate.mjs / parity.mjs.
  if (!existsSync("node_modules")) {
    blockers.push("node_modules/ is missing — run `npm install`; validate and parity need it.");
  }

  // 2b. The model ladder. A malformed .claude/model-routing.json degrades to the balanced
  //     default rather than failing, which is right for an attended dispatch — the orchestrator
  //     relays the warning and the user sees it. Unattended there is nobody to relay to, and a
  //     whole run's worth of dispatches on a silently-defaulted ladder is exactly the kind of
  //     thing you find out about from the bill. So surface it here, as a NOTE and never a
  //     blocker: the default is a working configuration, just not the one the file asked for.
  if (!existsSync(join("scripts", "routing.mjs"))) {
    notes.push("no scripts/routing.mjs — this workbench predates 0.16.0, so the model ladder is\n" +
      "    resolved from the plugin's copy instead (SKILL.md 4b has the command). Nothing to fix.");
  } else {
    try {
      const r = JSON.parse(execFileSync("node", ["scripts/routing.mjs"], { encoding: "utf8" }));
      const real = (r.warnings ?? []).filter((w) => !/effort/i.test(w));
      if (real.length) {
        notes.push("model ladder has warnings — dispatches will run on the resolved values below, not the file's:\n" +
          real.map((w) => `    - ${w}`).join("\n"));
      }
      notes.push(`model ladder: ${r.profile} (${r.profileSource}) — ` +
        Object.entries(r.roles).map(([k, v]) => `${k}:${v.model}`).join(" · "));
    } catch (e) {
      notes.push(`could not resolve the model ladder (${String(e.message).split("\n")[0]}) — ` +
        "dispatches will fall back to whatever model the session runs on.");
    }
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

  // 4b. The session's own context. Starting a run in a session that is already large means
  //     every unit pays for it; a fresh session is one /clear away.
  const limit = contextLimitOf(state);
  const c = readContext();
  if (!c.ok) notes.push(`context: unknown — ${c.reason}. The run will not halt on context size.`);
  else {
    notes.push(`context: ${kTok(c.tokens)} tokens · limit ${kTok(limit)}`);
    if (c.tokens >= limit) {
      blockers.push(`this session's context is already ${kTok(c.tokens)} tokens, over the ${kTok(limit)} limit — ` +
        "/clear and run /rebuild in a fresh session before engaging.");
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
  console.log(`   Threshold ${threshold}% of the 5-hour window; context limit ${kTok(limit)} tokens.`);
  console.log("   Gates still halt for the user.");
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
  const limit = Number(argAfter("--context-tokens")) || DEFAULT_CONTEXT_TOKENS;
  const c = readContext();
  if (c.ok && c.tokens >= limit) {
    console.error(`Cannot engage: context is ${kTok(c.tokens)} tokens, over the ${kTok(limit)} limit — /clear first.`);
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
    context_tokens: limit,
    stop_at_gates: true,
    last_check: { at: now, five_hour_pct: Math.round(u.pct), resets_at: u.resets_at,
                  context_tokens: c.ok ? c.tokens : undefined },
    paused: undefined,
    log: state?.log || [],
  });
  commitState(`engaged at ${phase || "unknown"}`);
  console.log(`Autopilot ENGAGED at: ${phase || "unknown"}`);
  console.log(`  ${usageLine(u)} · threshold ${threshold}% · context limit ${kTok(limit)}`);
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
  const c = readContext();
  if (u.ok) state.last_check = { at: now, five_hour_pct: Math.round(u.pct), resets_at: u.resets_at,
                                 context_tokens: c.ok ? c.tokens : undefined };
  writeState(state);
  commitState(`${outcome} — ${unit}`);
  console.log(`Logged: ${unit} (${outcome})${u.ok ? ` · ${usageLine(u)}` : ""}` +
    (c.ok ? ` · context ${kTok(c.tokens)}` : ""));
  process.exit(0);
}

if (cmd === "disengage") {
  const reason = argAfter("--reason");
  if (!REASONS.includes(reason)) {
    console.error(`disengage requires --reason <${REASONS.join("|")}>`); process.exit(1);
  }
  const now = new Date().toISOString();
  const u = readUsage();
  const c = readContext();
  const base = state || { threshold_pct: DEFAULT_THRESHOLD, stop_at_gates: true, log: [] };
  writeState({
    ...base,
    status: "paused",
    paused: {
      at: now, reason,
      five_hour_pct: u.ok ? Math.round(u.pct) : undefined,
      resets_at: u.ok ? u.resets_at : undefined,
      context_tokens: c.ok ? c.tokens : undefined,
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
  if (reason === "context-threshold") {
    console.log(`  Context ${c.ok ? kTok(c.tokens) + " tokens" : "size"} — a fresh session is the fix: /clear, then /rebuild.`);
  }
  console.log("  Now run: node scripts/pause-check.mjs — and resolve what it flags.");
  process.exit(0);
}

if (cmd === "status") {
  // Context is printed whether or not a run exists: an attended session uses this line to
  // decide when to end itself (SKILL.md, Context hygiene).
  const c = readContext();
  const ctxLine = c.ok ? `  context ${kTok(c.tokens)} tokens · limit ${kTok(contextLimitOf(state))}`
                       : `  context unknown — ${c.reason}`;
  if (!state) { console.log("Autopilot: off (no plan/autopilot.yaml)."); console.log(ctxLine); process.exit(0); }
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
  console.log(ctxLine);
  process.exit(0);
}

console.error("Usage: autopilot.mjs preflight | check | engage | log | disengage | status");
process.exit(1);
