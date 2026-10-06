#!/usr/bin/env node
// lanes-check.mjs — is a build lane still working, or did its run end and nobody noticed?
// Run from the workbench root.
//
//   node scripts/lanes-check.mjs                   # evidence, per repo and worktree
//   node scripts/lanes-check.mjs --idle 15         # minutes of silence before "looks stalled"
//   node scripts/lanes-check.mjs stamp             # record which code the joint run is about to test
//   node scripts/lanes-check.mjs stamp --rerun     # the same, for the rerun of its failures
//
// WHY THIS EXISTS. A lane watched its 45-minute suite with a Monitor, which gives up after at
// most 30 minutes, then went idle "waiting for the notification". Nothing woke it: 2½ hours once,
// 40 minutes once, several 10–20 minute gaps, over two days — and the orchestrator only noticed
// when the user asked for status. The orchestrator's 10-minute watchdog (g5-build.md, "Guardrails
// you enforce as orchestrator") runs this, so the check is one cheap call and the same in every
// project, instead of a hand-assembled `ps | grep` that differs by machine.
//
// EXIT CODES. 0: nothing to act on. 2: a lane looks stalled — a run-phases.mjs driver died
// mid-phase, or no test process or driver is alive and nothing in any repo or run directory has
// changed for longer than --idle minutes. It is a heuristic and says so; the orchestrator decides, with the evidence this
// prints, and it is that evidence it sends the lane.
//
// RUN DIRECTORIES. A run driven by `run-phases.mjs` keeps `status.json` (driver pid, current
// phase, state) in parity/runs/<local-date>-<label>/. A driver whose pid is alive counts as a run
// in progress, even between test processes (a reset or a redeploy runs no test binary). One that
// says `running` with a dead pid died mid-phase, and that is reported by name, not inferred from
// silence.
//
// WHEN IT EXITS 2 it names the newest file it saw anywhere and its age, so the orchestrator's
// nudge can quote evidence: "go.log, written 14 min ago" is something a lane acts on, where
// "looks stalled" is something it argues with.
//
// MARKERS. A code repo with no `.rebuild-workbench` marker turns `runbook-guard.mjs` off silently,
// because the guard fails open without it. While a slice is in progress this names the repo and
// the one-line fix. pause-check.mjs carries the same check.
//
// STAMP. JUnit carries no field for the commit it ran against, and that is the one fact needed
// to say what a pass on rerun means (acsuite.mjs countWithRerun: same commits → flaky, different
// → code changed, unknown → unverified). `stamp` writes parity/<local-date>-ac.meta.json (or
// -ac-rerun.meta.json) with every repo's HEAD and whether its tree was dirty. Run it immediately
// before the run it describes, from the workbench root, by whichever lane starts that run.
//
// Zero-dependency: repos.yaml is parsed with the same fixed-subset regex as pause-check.mjs.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { localDate, runMetaPath, readAcSuite } from "./acsuite.mjs";

if (!existsSync(join("locks", "pipeline.yaml"))) {
  console.error("No locks/pipeline.yaml here — run from the workbench root.");
  process.exit(1);
}

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("-") ? args[0] : "check";
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const git = (dir, a) => {
  try { return execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
};

const repoEntries = () => {
  const out = [{ name: "workbench", path: resolve(".") }];
  if (!existsSync("repos.yaml")) return out;
  const text = readFileSync("repos.yaml", "utf8");
  for (const m of text.matchAll(/^\s*-\s*(?:name:\s*(\S+)\s*)?path:\s*(\S+)/gm)) {
    out.push({ name: m[1] || m[2], path: resolve(m[2]) });
  }
  return out;
};

// ---------------------------------------------------------------------------------------------
if (cmd === "stamp") {
  const rerun = flag("--rerun");
  const repos = {};
  const problems = [];
  for (const { name, path } of repoEntries()) {
    const sha = existsSync(path) ? git(path, ["rev-parse", "HEAD"]) : null;
    if (!sha) { problems.push(`${name}: no HEAD at ${path}`); continue; }
    const dirty = (git(path, ["status", "--porcelain"]) || "").length > 0;
    repos[name] = { path, sha, dirty };
    if (dirty) problems.push(`${name}: uncommitted changes — this run's code cannot be named by a commit`);
  }
  const out = runMetaPath(localDate(), { rerun });
  mkdirSync("parity", { recursive: true });
  writeFileSync(out, JSON.stringify({ started: new Date().toISOString(), rerun, repos }, null, 2) + "\n");
  console.log(`Wrote ${out} — ${Object.keys(repos).length} repo(s) stamped.`);
  if (problems.length) {
    console.log("\nA pass on rerun will be reported as UNVERIFIED, because:");
    for (const p of problems) console.log(`  - ${p}`);
    console.log("Commit first (a WIP commit on the lane's branch is fine), then stamp again.");
  }
  process.exit(0);
}

if (cmd !== "check") {
  console.error(`Unknown command "${cmd}". Usage: lanes-check.mjs [--idle <min>] | stamp [--rerun]`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// Live test processes. Command lines, not image names: on Windows `tasklist` only shows
// `node.exe`, which cannot tell Playwright from the dev server, so PowerShell's Win32_Process
// is asked for the command line instead.
const TEST_PROC = [
  /\bgo(\.exe)?"?\s+test\b/, /[\\/][\w.-]+\.test(\.exe)?"?(\s|$)/,       // go test, and its compiled test binaries
  /playwright(\.cmd)?"?\s+test\b|@playwright[\\/]test/, /\bvitest\b/, /\bjest\b/,
  /\bmaestro(\.bat)?"?\s+test\b/, /\bflutter(\.bat)?"?\s+test\b/, /\bdart(\.exe)?"?\s+test\b/,
  /\bequiv\.mjs"?\s+(replay|record)\b/,
];
const listProcesses = () => {
  try {
    if (process.platform === "win32") {
      const csv = execFileSync("powershell", ["-NoProfile", "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 });
      return csv.split(/\r?\n/).slice(1).map((l) => {
        const m = /^"(\d+)","(.*)"$/.exec(l);
        return m ? { pid: m[1], command: m[2].replace(/""/g, '"') } : null;
      }).filter(Boolean);
    }
    const ps = execFileSync("ps", ["-axo", "pid=,etime=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return ps.split("\n").map((l) => {
      const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l);
      return m ? { pid: m[1], elapsed: m[2], command: m[3] } : null;
    }).filter(Boolean);
  } catch { return null; }
};
const procs = listProcesses();
const testProcs = (procs || []).filter((p) => p.pid !== String(process.pid) && TEST_PROC.some((re) => re.test(p.command)));

// ---------------------------------------------------------------------------------------------
// Repos and their worktrees: last commit, dirty count, newest change to a dirty file.
const now = Date.now();
const ago = (ms) => {
  if (ms == null) return "—";
  const m = Math.round((now - ms) / 60000);
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
};
const rows = [];
let lastActivity = 0;
// The newest file seen anywhere, by path: what the stall message quotes.
let newestFile = null;
const seeFile = (path, mtime) => { if (mtime && (!newestFile || mtime > newestFile.mtime)) newestFile = { path, mtime }; };
for (const { name, path } of repoEntries()) {
  if (!existsSync(path)) { rows.push({ label: name, path, missing: true }); continue; }
  const trees = [];
  const wt = git(path, ["worktree", "list", "--porcelain"]);
  if (wt) for (const m of wt.matchAll(/^worktree (.+)$/gm)) trees.push(m[1]);
  if (!trees.length) trees.push(path);
  const real = (() => { try { return realpathSync(path); } catch { return path; } })();
  for (const tree of trees) {
    const committed = Number(git(tree, ["log", "-1", "--format=%ct"]) || 0) * 1000 || null;
    const status = (git(tree, ["status", "--porcelain"]) || "").split("\n").filter(Boolean);
    let dirtyMtime = null;
    for (const line of status) {
      const file = join(tree, line.slice(3).replace(/^"|"$/g, "").split(" -> ").pop());
      try { const t = statSync(file).mtimeMs; if (t > (dirtyMtime || 0)) dirtyMtime = t; seeFile(file, t); }
      catch { /* deleted file */ }
    }
    lastActivity = Math.max(lastActivity, committed || 0, dirtyMtime || 0);
    const branch = git(tree, ["rev-parse", "--abbrev-ref", "HEAD"]) || "?";
    const procsHere = testProcs.filter((p) => p.command.includes(tree));
    rows.push({ label: tree === path || tree === real ? name : `${name} (worktree)`, path: tree, branch, committed, dirty: status.length, dirtyMtime, procsHere });
  }
}

// ---------------------------------------------------------------------------------------------
// Newest results: the joint run's and rerun's JUnit in parity/, and Playwright's own
// `.last-run.json` in any repo's test-results/ — the file a frontend lane's run leaves behind.
const results = [];
if (existsSync("parity")) {
  for (const f of readdirSync("parity").filter((f) => /-(ac|ac-rerun|equiv)\.xml$/.test(f))) {
    const p = join("parity", f);
    // Skips are counted apart from passes. This used to be total minus failures, which showed a
    // run with 670 of 1209 tests skipped as 1209/1209 passed.
    const r = readAcSuite(p);
    const status = !r || r.unreadable ? "unreadable as JUnit"
      : `${r.passed}/${r.total} passed` + (r.failed ? `, ${r.failed} failed` : "") + (r.skipped ? `, ${r.skipped} skipped` : "");
    results.push({ path: p, mtime: statSync(p).mtimeMs, status });
  }
}
// Playwright writes `.last-run.json` into its outputDir, which is `test-results/` by default and
// whatever playwright.config says otherwise (`e2e/.artifacts/` in one rebuild) — so it is found,
// not assumed: a shallow walk, skipping dependency and build directories.
const findLastRun = (dir, depth = 3) => {
  const out = [];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isFile() && e.name === ".last-run.json") out.push(join(dir, e.name));
    else if (e.isDirectory() && depth > 0 && !/^(node_modules|\.git|\.nuxt|\.output|\.next|dist|build|vendor|workbench)$/.test(e.name)) {
      out.push(...findLastRun(join(dir, e.name), depth - 1));
    }
  }
  return out;
};
for (const p of rows.filter((r) => !r.missing).flatMap((r) => findLastRun(r.path))) {
  let status = "unreadable";
  try { const j = JSON.parse(readFileSync(p, "utf8")); status = `${j.status}${j.failedTests?.length ? `, ${j.failedTests.length} failed` : ""}`; }
  catch { /* reported as unreadable */ }
  results.push({ path: p, mtime: statSync(p).mtimeMs, status });
}
results.sort((a, b) => b.mtime - a.mtime);
for (const r of results) seeFile(r.path, r.mtime);

// ---------------------------------------------------------------------------------------------
// Runs driven by run-phases.mjs. parity/runs/ is gitignored by the driver, so nothing above sees
// its logs change; they are read here directly.
const pidAlive = (pid) => {
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return e.code === "EPERM"; } // exists, owned by someone else
};
const runs = [];
const RUNS = join("parity", "runs");
if (existsSync(RUNS)) {
  for (const d of readdirSync(RUNS, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const dir = join(RUNS, d.name);
    let status = null;
    try { status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")); } catch { /* not started, or not a driver run */ }
    let newest = null;
    for (const f of readdirSync(dir)) {
      try { const t = statSync(join(dir, f)).mtimeMs; if (!newest || t > newest.mtime) newest = { path: join(dir, f), mtime: t }; }
      catch { /* removed while listing */ }
    }
    if (newest) seeFile(newest.path, newest.mtime);
    const alive = status?.state === "running" && status.pid && pidAlive(status.pid);
    runs.push({ dir, status, newest, alive, died: status?.state === "running" && !alive });
  }
  runs.sort((a, b) => (b.newest?.mtime || 0) - (a.newest?.mtime || 0));
}
const liveRuns = runs.filter((r) => r.alive);
// A driver that died a day ago was either rerun under a new directory or abandoned, and an
// old one counted here would make every later check exit 2.
const deadRuns = runs.filter((r) => r.died && r.newest && now - r.newest.mtime < 24 * 3600000);

// ---------------------------------------------------------------------------------------------
// Code repos with no usable `.rebuild-workbench` marker, while a slice is in progress. Copied
// from pause-check.mjs, not imported, because both are standalone scripts — if you change one,
// change both.
const markerProblems = [];
const inProgress = (() => {
  try {
    const block = readFileSync(join("plan", "progress.yaml"), "utf8").match(/^slices:\n((?:(?:[ \t]+.*)?\n)*)/m);
    return block ? [...block[1].matchAll(/^\s+(S\d+):\s*([a-z-]+)/gm)].filter((m) => m[2] === "in-progress").map((m) => m[1]) : [];
  } catch { return []; }
})();
if (inProgress.length) {
  const here = resolve(".");
  for (const { name, path } of repoEntries().slice(1)) {
    if (!existsSync(path)) continue;
    const marker = join(path, ".rebuild-workbench");
    let target = "";
    try { target = readFileSync(marker, "utf8").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) || ""; }
    catch { /* missing: reported below */ }
    const points = target && resolve(path, target);
    if (!target) markerProblems.push(`${name}: no .rebuild-workbench marker`);
    else if (!existsSync(join(points, "locks", "pipeline.yaml"))) markerProblems.push(`${name}: .rebuild-workbench points at ${points}, which is not a workbench`);
    else if (realpathSync(points) !== realpathSync(here)) markerProblems.push(`${name}: .rebuild-workbench points at ${points}, not this workbench`);
  }
}

// ---------------------------------------------------------------------------------------------
console.log(`lanes-check — ${new Date().toLocaleString()}\n`);
for (const r of rows) {
  if (r.missing) { console.log(`${r.label}: registered in repos.yaml, path missing (${r.path})`); continue; }
  console.log(`${r.label} [${r.branch}] — last commit ${ago(r.committed)}, ${r.dirty} dirty` +
    (r.dirty ? ` (newest edit ${ago(r.dirtyMtime)})` : "") +
    (r.procsHere.length ? `, ${r.procsHere.length} test process(es)` : ""));
}
console.log("");
if (procs === null) console.log("Test processes: could not list processes on this machine — the stall check below is weaker.");
else if (!testProcs.length) console.log("Test processes: none alive.");
else {
  console.log(`Test processes: ${testProcs.length} alive`);
  for (const p of testProcs.slice(0, 10)) console.log(`  ${p.pid}${p.elapsed ? ` (${p.elapsed})` : ""} ${p.command.slice(0, 140)}`);
}
if (runs.length) {
  console.log("\nDriven runs (run-phases.mjs):");
  for (const r of runs.slice(0, 5)) {
    const st = r.status;
    const what = !st ? "no status.json — not started by run-phases.mjs"
      : r.alive ? `running phase ${st.phase} (pid ${st.pid})`
      : r.died ? `DRIVER DIED during phase ${st.phase} — status says running, pid ${st.pid} is gone`
      : st.state === "failed" ? `failed in phase ${st.phase}, exit ${st.exit}`
      : `${st.state}`;
    console.log(`  ${r.dir} — ${what}; newest file ${r.newest ? `${r.newest.path}, written ${ago(r.newest.mtime)}` : "none"}`);
  }
}
console.log("");
if (!results.length) console.log("Results files: none (parity/*-ac*.xml, Playwright .last-run.json).");
else {
  console.log("Newest results:");
  for (const r of results.slice(0, 3)) console.log(`  ${r.path} — written ${ago(r.mtime)}, ${r.status}`);
}

const idleMin = Number(opt("--idle", "10"));
const newest = results[0];
const quietSince = Math.max(lastActivity, newest?.mtime || 0, newestFile?.mtime || 0);
const busy = testProcs.length || liveRuns.length;
const stalled = deadRuns.length || (procs !== null && !busy && quietSince && (now - quietSince) / 60000 > idleMin);
console.log("");
if (markerProblems.length) {
  console.log(`MARKER: ${inProgress.join(", ")} in progress, and runbook-guard.mjs is off for these repos, because it fails open without a marker:`);
  for (const m of markerProblems) console.log(`  - ${m}`);
  console.log(`  Fix, in each repo: echo "${resolve(".")}" > .rebuild-workbench && git add .rebuild-workbench && git commit -m "chore: point at the rebuild workbench"\n`);
}
if (stalled) {
  const since = newest && newest.mtime >= quietSince
    ? `the newest results file (${newest.path}, ${newest.status}) was written ${ago(newest.mtime)} and nothing in any repo has changed since`
    : `nothing in any repo or run directory has changed for ${ago(quietSince).replace(" ago", "")}`;
  for (const r of deadRuns) console.log(`STALLED: the driver for ${r.dir} died during phase ${r.status.phase}; its newest file is ${r.newest?.path}, written ${ago(r.newest?.mtime)}.`);
  if (!deadRuns.length) console.log(`LOOKS STALLED: no test process alive, and ${since}.`);
  if (newestFile) console.log(`Newest file anywhere: ${newestFile.path}, written ${ago(newestFile.mtime)}.`);
  console.log("If a lane still has work, send it this evidence and tell it to resume. Heuristic — you decide.");
  process.exit(2);
}
console.log(busy ? "Nothing to act on: a test run is still in progress."
  : `Nothing to act on: activity within the last ${idleMin} min.`);
