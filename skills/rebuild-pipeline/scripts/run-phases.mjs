#!/usr/bin/env node
// run-phases.mjs — run a long, several-phase test run as ONE tracked background process.
// Run from the workbench root, by the lane that owns the run, with Bash `run_in_background: true`.
//
//   node scripts/run-phases.mjs parity/runs/<local-date>-joint
//
// The directory holds `phases.txt`, written by the lane before it starts:
//
//   # comment
//   TEST_DATABASE_URL=postgres://...      # NAME=value: exported to every LATER phase
//   reset: cd ../crm-backend && make db-reset
//   stamp: node scripts/lanes-check.mjs stamp
//   go:    cd ../crm-backend && go test ./... 2>&1 | go-junit-report > ../crm-workbench/parity/<date>-ac-go.xml
//
// Each phase runs in a shell from the workbench root, in order. Output goes to `<phase>.log`, and
// `<phase>.done` gets the exit code and duration when the phase ends. `status.json` always says
// which phase is running, and the driver's pid, so `lanes-check.mjs` can tell a live run from a
// dead one. The driver stops at the first phase that exits non-zero, and exits with that code.
//
// WHY THIS EXISTS. A joint-run lane stalled three times in one slice, 13 to 18 minutes each:
// after the stamp, after the Go suite, after the backend deploy suites. It ran each suite with
// `nohup` and watched a done-marker with a Monitor. The harness does not track a `nohup` or `&`
// process, so its exit woke nobody, and a Monitor expires after at most 30 minutes, while the suites
// took 45 or more. Each hand-off between phases was one more wake-up that could be missed. With
// this driver as the lane's one `run_in_background` process, the lane has exactly one wake-up,
// when the whole run ends or a phase fails.
//
// WHY `NAME=value` LINES. In the same run, 670 of 1209 backend tests were skipped because the
// integration database settings were exported in one shell and the tests ran in another. Every
// phase here is its own shell, so an `export` in one phase never reaches the next. A `NAME=value`
// line is the one place a setting is given, and every phase after it inherits it.
//
// This is a script, not a paragraph in the brief, because a lane that writes its own driver per
// slice writes a different one each time, and lanes-check can only read a layout it knows.

import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

if (!existsSync(join("locks", "pipeline.yaml"))) {
  console.error("No locks/pipeline.yaml here — run from the workbench root.");
  process.exit(1);
}
const dir = process.argv[2];
if (!dir || !existsSync(join(dir, "phases.txt"))) {
  console.error("Usage: node scripts/run-phases.mjs <run dir>  — the directory must hold phases.txt.\n" +
    "Convention: parity/runs/<local-date>-<label>, e.g. parity/runs/2026-10-06-joint.");
  process.exit(1);
}

// Logs can run to hundreds of megabytes and say nothing a JUnit file does not. Written here, not
// by rebuild-init, so workbenches scaffolded before this script existed ignore them too.
const runsRoot = join(dir, "..");
if (!existsSync(join(runsRoot, ".gitignore"))) {
  mkdirSync(runsRoot, { recursive: true });
  writeFileSync(join(runsRoot, ".gitignore"), "*\n");
}

const env = { ...process.env };
const phases = [];
const problems = [];
readFileSync(join(dir, "phases.txt"), "utf8").split(/\r?\n/).forEach((raw, i) => {
  const line = raw.replace(/^\s+|\s+$/g, "");
  if (!line || line.startsWith("#")) return;
  const set = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  if (set) { phases.push({ set: set[1], value: set[2] }); return; }
  const ph = /^([A-Za-z0-9][\w.-]*):\s*(.+)$/.exec(line);
  if (ph) { phases.push({ name: ph[1], command: ph[2] }); return; }
  problems.push(`line ${i + 1}: neither "NAME=value" nor "phase: command" — ${line}`);
});
const names = phases.filter((p) => p.name).map((p) => p.name);
const dup = names.filter((n, i) => names.indexOf(n) !== i);
if (dup.length) problems.push(`phase names repeat (${[...new Set(dup)].join(", ")}): each one names its log and .done file`);
if (!names.length) problems.push("no phases");
if (problems.length) {
  console.error(`${join(dir, "phases.txt")} is not usable:\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

const started = new Date().toISOString();
const results = [];
const writeStatus = (fields) => writeFileSync(join(dir, "status.json"), JSON.stringify({
  pid: process.pid, started, updated: new Date().toISOString(), phases: names, results, ...fields,
}, null, 2) + "\n");

const runPhase = (p) => new Promise((done) => {
  const log = createWriteStream(join(dir, `${p.name}.log`));
  const t0 = Date.now();
  const child = spawn(p.command, { shell: true, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  // A command the shell cannot start still ends in `close`, with code 127 or 1, so this has one
  // exit path. A signal-killed phase has a null code and counts as a failure.
  child.on("close", (code, signal) => {
    log.end();
    const exit = code ?? 128;
    const seconds = Math.round((Date.now() - t0) / 1000);
    writeFileSync(join(dir, `${p.name}.done`), `exit=${exit}${signal ? ` signal=${signal}` : ""} seconds=${seconds}\n`);
    done({ phase: p.name, exit, seconds });
  });
});

for (const p of phases) {
  if (p.set) { env[p.set] = p.value; continue; }
  writeStatus({ state: "running", phase: p.name });
  const r = await runPhase(p);
  results.push(r);
  console.log(`${r.exit === 0 ? "ok  " : "FAIL"}  ${r.phase} — exit ${r.exit}, ${r.seconds}s, log ${join(dir, `${r.phase}.log`)}`);
  if (r.exit !== 0) {
    writeStatus({ state: "failed", phase: p.name, exit: r.exit });
    const skipped = names.slice(names.indexOf(p.name) + 1);
    if (skipped.length) console.log(`Not run, because ${p.name} failed: ${skipped.join(", ")}`);
    process.exit(r.exit);
  }
}
writeStatus({ state: "passed", phase: null, exit: 0 });
console.log(`All ${names.length} phase(s) passed. Read the JUnit each one wrote, skips included, before reporting.`);
