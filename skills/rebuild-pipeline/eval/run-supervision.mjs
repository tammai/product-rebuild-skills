#!/usr/bin/env node
// run-supervision.mjs (eval) — 0.31.0, issue #1: the G5 gaps found in a real run.
//
//   node skills/rebuild-pipeline/eval/run-supervision.mjs
//
// Scaffolds a throwaway workbench with rebuild-init.mjs and a code repo registered in repos.yaml,
// then runs the REAL scripts against it:
//   - run-phases.mjs: phases in order, `NAME=value` reaching later phases, a stop at the first
//     failure, and the status files lanes-check reads;
//   - lanes-check.mjs: a dead driver is a stall with the newest file named, a live one is not, a
//     JUnit skip is not counted as a pass, and a code repo with no marker is named mid-slice;
//   - parity.mjs: a skip-heavy run and an env-var skip are both NOT GREEN;
//   - pause-check.mjs: a missing or wrong marker mid-slice is an issue.
// Each case asserts on what a script printed or wrote, as dates-and-reruns.mjs does.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const base = mkdtempSync(join(tmpdir(), "rebuild-eval-"));
execFileSync("node", [join(SCRIPTS, "rebuild-init.mjs"), "evalwb", "--dir", base], { stdio: "ignore" });
const wb = join(base, "evalwb-workbench");
execFileSync("npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: wb, stdio: "ignore" });

const w = (rel, text) => { mkdirSync(dirname(join(wb, rel)), { recursive: true }); writeFileSync(join(wb, rel), text); };
const run = (script, ...args) => {
  const r = spawnSync("node", [join("scripts", script), ...args], { cwd: wb, encoding: "utf8" });
  return { out: r.stdout + r.stderr, code: r.status };
};
const read = (rel) => (existsSync(join(wb, rel)) ? readFileSync(join(wb, rel), "utf8") : "");
const date = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) { failures++; if (detail) console.log(`      ${detail.replace(/\n/g, "\n      ")}`); }
};

// A code repo, committed, registered in repos.yaml, with S2 in progress.
const app = join(base, "app");
mkdirSync(app);
const g = (...a) => execFileSync("git", ["-C", app, ...a], { stdio: "ignore" });
g("init", "-q"); writeFileSync(join(app, "a.txt"), "a\n"); g("add", "."); g("-c", "user.email=e@x", "-c", "user.name=e", "commit", "-qm", "init");
w("repos.yaml", "repos:\n  - name: app\n    path: ../app\n");
w("plan/progress.yaml", "slices:\n  S1: done\n  S2: in-progress\n");

// --- 1. run-phases: order, env carry-over, stop at the first failure -------------------------
const RUN = `parity/runs/${date}-joint`;
w(`${RUN}/phases.txt`, [
  "# the joint run",
  "EVAL_DB_URL=postgres://eval",
  `one: node -e "require('fs').writeFileSync('${RUN}/seen.txt', process.env.EVAL_DB_URL || 'UNSET')"`,
  "two: node -e \"process.exit(3)\"",
  "three: node -e \"console.log('should not run')\"",
].join("\n") + "\n");
const r1 = run("run-phases.mjs", RUN);
check("run-phases exits with the failing phase's code", r1.code === 3, r1.out);
check("a NAME=value line reaches a later phase", read(`${RUN}/seen.txt`) === "postgres://eval", read(`${RUN}/seen.txt`));
check("each phase that ran has a .done file", /exit=0/.test(read(`${RUN}/one.done`)) && /exit=3/.test(read(`${RUN}/two.done`)));
check("no phase runs after a failure", !existsSync(join(wb, RUN, "three.log")) && /Not run, because two failed: three/.test(r1.out), r1.out);
const st1 = JSON.parse(read(`${RUN}/status.json`) || "{}");
check("status.json records the failed phase", st1.state === "failed" && st1.phase === "two" && st1.exit === 3, JSON.stringify(st1));
check("the run directory is gitignored", read("parity/runs/.gitignore").trim() === "*");
check("a malformed phases.txt is refused before anything runs", (() => {
  w("parity/runs/bad/phases.txt", "one: true\nthis is not a phase\n");
  const r = run("run-phases.mjs", "parity/runs/bad");
  return r.code === 1 && /line 2/.test(r.out) && !existsSync(join(wb, "parity/runs/bad/status.json"));
})());
rmSync(join(wb, "parity/runs/bad"), { recursive: true });

// --- 2. lanes-check: a driver that died mid-phase is a stall, and the newest file is named ----
w(`${RUN}/status.json`, JSON.stringify({ pid: 999999, state: "running", phase: "go", phases: ["go"], results: [] }));
w(`${RUN}/go.log`, "--- PASS: TestX\n");
const r2 = run("lanes-check.mjs");
check("a dead driver exits 2", r2.code === 2, r2.out);
check("a dead driver is named with its phase", /driver for parity\/runs\/[\d-]+-joint died during phase go/.test(r2.out), r2.out);
check("the stall names the newest file and its age", /Newest file anywhere: .*(go\.log|status\.json), written \d+ min ago/.test(r2.out), r2.out);

// --- 3. a live driver is a run in progress, even with no test process -------------------------
const sleeper = spawn("node", ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
w(`${RUN}/status.json`, JSON.stringify({ pid: sleeper.pid, state: "running", phase: "redeploy", phases: ["redeploy"], results: [] }));
const r3 = run("lanes-check.mjs", "--idle", "0");
sleeper.kill();
check("a live driver is not a stall", r3.code === 0 && /running phase redeploy/.test(r3.out), r3.out);
rmSync(join(wb, "parity/runs"), { recursive: true });

// --- 4. lanes-check and the markers ---------------------------------------------------------
const r4 = run("lanes-check.mjs");
check("lanes-check names a repo with no marker mid-slice", /MARKER: S2 in progress/.test(r4.out) && /app: no \.rebuild-workbench marker/.test(r4.out), r4.out);
const p4 = run("pause-check.mjs");
check("pause-check names a repo with no marker mid-slice", /app: no `\.rebuild-workbench` marker while S2 is in progress/.test(p4.out), p4.out);
writeFileSync(join(app, ".rebuild-workbench"), join(base, "elsewhere") + "\n");
check("pause-check names a marker pointing elsewhere", /app: `\.rebuild-workbench` points at .*elsewhere, not this workbench/.test(run("pause-check.mjs").out));
writeFileSync(join(app, ".rebuild-workbench"), wb + "\n");
check("a correct marker is not named", !/rebuild-workbench/.test(run("pause-check.mjs").out) && !/MARKER/.test(run("lanes-check.mjs").out));
rmSync(join(app, ".rebuild-workbench"));
w("plan/progress.yaml", "slices:\n  S1: done\n");
check("no slice in progress: no marker issue", !/rebuild-workbench/.test(run("pause-check.mjs").out));

// --- 5. skips: not counted as passes, and NOT GREEN beyond the bounds -----------------------
const junit = (cases) => `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="ac">\n` +
  cases.map(([name, st, why]) => st === "passed" ? `<testcase classname="F-A-001" name="${name}"/>`
    : st === "skipped" ? `<testcase classname="F-A-001" name="${name}"><skipped message="${why}"/></testcase>`
    : `<testcase classname="F-A-001" name="${name}"><failure message="x">x</failure></testcase>`).join("\n") +
  `\n</testsuite></testsuites>\n`;
w("matrix/features.yaml", "- id: F-A-001\n  name: Alpha\n  status: planned\n");
w("plan/slices.yaml", "- id: S1\n  name: One\n  features: [F-A-001]\n");
const many = [...Array(10)].map((_, i) => [`t${i}`, i < 4 ? "skipped" : "passed", "only runs on iOS"]);
w(`parity/${date}-ac.xml`, junit(many));
check("lanes-check does not count a skip as a pass", /6\/10 passed, 4 skipped/.test(run("lanes-check.mjs").out));
run("parity.mjs");
const rep5 = read(`parity/${date}.md`);
check("a 40% skip run is NOT GREEN", /NOT GREEN: 4 of 10 tests skipped \(40%\)/.test(rep5), rep5.slice(0, 900));
check("skips are grouped by reason", /4 × only runs on iOS/.test(rep5));

w(`parity/${date}-ac.xml`, junit([...[...Array(19)].map((_, i) => [`t${i}`, "passed"]), ["t19", "skipped", "TEST_DATABASE_URL not set"]]));
run("parity.mjs");
const rep6 = read(`parity/${date}.md`);
check("one env-var skip is NOT GREEN under the ratio bound", /NOT GREEN: 1 skipped because an environment variable was unset/.test(rep6) && !/tests skipped \(5%\)/.test(rep6), rep6.slice(0, 900));

w(`parity/${date}-ac.xml`, junit([...[...Array(19)].map((_, i) => [`t${i}`, "passed"]), ["t19", "skipped", "only runs on iOS"]]));
run("parity.mjs");
check("one platform skip in twenty is not flagged", !/NOT GREEN/.test(read(`parity/${date}.md`)), read(`parity/${date}.md`).slice(0, 900));

rmSync(base, { recursive: true, force: true });
console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
