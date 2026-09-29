#!/usr/bin/env node
// dates-and-reruns.mjs — eval for E11 (local-calendar dates) and E12 (rerun evidence), 0.19.0.
//
//   node skills/rebuild-pipeline/eval/dates-and-reruns.mjs
//
// Scaffolds a throwaway workbench with rebuild-init.mjs, runs `npm install` in it (its scripts
// need the `yaml` dependency), then writes JUnit files and run records and runs the REAL
// parity.mjs and slice-review.mjs against them. Every case asserts on the reports those scripts
// write, never on a function in isolation: the failures these guard against were all in how a
// report picked and labelled a file.
//
// THE DATE SPLIT IS FORCED, NOT HOPED FOR. The scripts run under a TZ whose local date differs
// from the UTC date at the moment the eval runs (UTC+14 when the UTC hour is 10 or later, UTC-12
// before that), so a script still naming files by the UTC date fails every time, not only on
// local mornings east of UTC.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const TZ = new Date().getUTCHours() >= 10 ? "Etc/GMT-14" : "Etc/GMT+12";

// Local date in TZ, offset by `days`. Computed here the way the scripts must: from local fields.
const dayIn = (days = 0) => {
  const out = execFileSync("node", ["-e",
    `const d=new Date(Date.now()+${days}*86400000);` +
    `console.log(d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"))`],
  { env: { ...process.env, TZ }, encoding: "utf8" });
  return out.trim();
};
const today = dayIn(0), yesterday = dayIn(-1), tomorrow = dayIn(1);
const utcToday = new Date().toISOString().slice(0, 10);
if (today === utcToday) { console.error(`eval setup: TZ ${TZ} did not split the date from UTC (${today}).`); process.exit(1); }

const base = mkdtempSync(join(tmpdir(), "rebuild-eval-"));
execFileSync("node", [join(SCRIPTS, "rebuild-init.mjs"), "evalwb", "--dir", base], { stdio: "ignore" });
const wb = join(base, "evalwb-workbench");
execFileSync("npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: wb, stdio: "ignore" });

const w = (rel, text) => { mkdirSync(dirname(join(wb, rel)), { recursive: true }); writeFileSync(join(wb, rel), text); };
w("matrix/features.yaml", "- id: F-A-001\n  name: Alpha\n  status: planned\n");
w("plan/slices.yaml", "- id: S1\n  name: One\n  features: [F-A-001]\n");
w("plan/progress.yaml", "slices: { S1: deployed }\nfeatures: { F-A-001: covered }\n");

const junit = (cases) => `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="ac">\n` +
  cases.map(([name, st]) => st === "passed"
    ? `<testcase classname="F-A-001" name="${name}"/>`
    : `<testcase classname="F-A-001" name="${name}"><failure message="x">x</failure></testcase>`).join("\n") +
  `\n</testsuite></testsuites>\n`;
const meta = (shas, dirty = false) => JSON.stringify({
  started: new Date().toISOString(),
  repos: Object.fromEntries(Object.entries(shas).map(([n, sha]) => [n, { path: `/x/${n}`, sha, dirty }])),
});
const resetParity = () => { rmSync(join(wb, "parity"), { recursive: true, force: true }); mkdirSync(join(wb, "parity")); };
const run = (script, ...args) => {
  const r = spawnSync("node", [join("scripts", script), ...args], { cwd: wb, env: { ...process.env, TZ }, encoding: "utf8" });
  return r.stdout + r.stderr;
};
const report = (rel) => (existsSync(join(wb, rel)) ? readFileSync(join(wb, rel), "utf8") : "");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) { failures++; if (detail) console.log(`      ${detail.replace(/\n/g, "\n      ")}`); }
};

// --- 1. the date split: today's LOCAL file is the one read, and named, by both reports -------
resetParity();
w(`parity/${yesterday}-ac.xml`, junit([["t1", "passed"], ["t2", "passed"]]));
w(`parity/${today}-ac.xml`, junit([["t1", "passed"], ["t2", "passed"], ["t3", "passed"]]));
run("parity.mjs");
check("parity names its report by the local date", existsSync(join(wb, `parity/${today}.md`)),
  `no parity/${today}.md (UTC date is ${utcToday})`);
check("parity reads today's local JUnit", /AC pass rate: 3\/3/.test(report(`parity/${today}.md`)), report(`parity/${today}.md`).slice(0, 400));
run("slice-review.mjs", "S1");
const sr1 = report("plan/slice-reviews/S1.md");
check("slice-review reads today's local run and calls it today", /3\/3 passed/.test(sr1) && /\(today\)/.test(sr1), sr1.slice(0, 600));
check("slice-review raises no date warning for a same-day run", !/WARNING: no joint run for today/.test(sr1));

// --- 2. a file dated AHEAD of today is a warning, never "(today)" ---------------------------
resetParity();
w(`parity/${tomorrow}-ac.xml`, junit([["t1", "passed"]]));
run("slice-review.mjs", "S1");
const sr2 = report("plan/slice-reviews/S1.md");
check("an ahead-dated run leads with a warning", /WARNING: no joint run for today/.test(sr2) && /AHEAD of today/.test(sr2), sr2.slice(0, 600));
check("an ahead-dated run is not labelled (today)", !/\(today\)/.test(sr2));

// --- 3. an old run is announced, not presented as current -----------------------------------
resetParity();
w(`parity/${yesterday}-ac.xml`, junit([["t1", "passed"]]));
run("slice-review.mjs", "S1");
check("a day-old run leads with a warning", /WARNING: no joint run for today[^\n]*1 day\(s\) old/.test(report("plan/slice-reviews/S1.md")));

// --- 4. failed then passed on the SAME commits: PASS, labelled flaky, same rate everywhere --
resetParity();
w(`parity/${today}-ac.xml`, junit([["t1", "passed"], ["t2", "failed"], ["t3", "failed"]]));
w(`parity/${today}-ac-rerun.xml`, junit([["t2", "passed"], ["t3", "failed"]]));
w(`parity/${today}-ac.meta.json`, meta({ workbench: "aaa111", backend: "bbb222" }));
w(`parity/${today}-ac-rerun.meta.json`, meta({ workbench: "aaa111", backend: "bbb222" }));
run("parity.mjs"); run("slice-review.mjs", "S1");
const p4 = report(`parity/${today}.md`), sr4 = report("plan/slice-reviews/S1.md");
check("flaky: parity counts the rerun pass", /AC pass rate: 2\/3 passed \(67%\), 1 of them flaky/.test(p4), p4.slice(0, 700));
check("flaky: slice-review states the same rate", /2\/3 passed \(67%\), 1 of them flaky/.test(sr4), sr4.slice(0, 700));
check("flaky: the rerun pass is labelled flaky", /Passed on rerun — flaky/.test(sr4));
check("flaky: the joint run's own total stays visible", /Joint run: 1\/3 passed/.test(sr4));
check("flaky: the still-failing test is named", /Still failing after the rerun: F-A-001 › t3/.test(sr4));

// --- 5. failed then passed on DIFFERENT commits: labelled code-changed, with the range -------
w(`parity/${today}-ac-rerun.meta.json`, meta({ workbench: "aaa111", backend: "ccc333" }));
run("slice-review.mjs", "S1");
const sr5 = report("plan/slice-reviews/S1.md");
check("code-changed: labelled, not flaky", /Passed on rerun — code-changed/.test(sr5) && !/of them flaky/.test(sr5), sr5.slice(0, 700));
check("code-changed: names the repo and range", /backend: `bbb222\.\.ccc333`/.test(sr5));

// --- 6. a run record missing: unverified, never a silent PASS -------------------------------
rmSync(join(wb, `parity/${today}-ac-rerun.meta.json`));
run("slice-review.mjs", "S1");
check("missing record: labelled unverified", /Passed on rerun — unverified/.test(report("plan/slice-reviews/S1.md")));

// --- 7. a rerun file is never mistaken for a joint run --------------------------------------
const { acJunitFiles } = await import(join(SCRIPTS, "acsuite.mjs"));
check("acJunitFiles ignores -ac-rerun.xml", acJunitFiles(wb).every((f) => !f.path.endsWith("-ac-rerun.xml"))
  && acJunitFiles(wb).length === 1);

// --- 8. a failing test that did not exist last run is "new", not "already failing" ----------
resetParity();
w(`parity/${yesterday}-ac.xml`, junit([["t1", "passed"]]));
w(`parity/${today}-ac.xml`, junit([["t1", "passed"], ["t9", "failed"]]));
run("slice-review.mjs", "S1");
const sr8 = report("plan/slice-reviews/S1.md");
check("a new failing test is labelled new", new RegExp(`Failing, new since \`${yesterday}\`[^\\n]*\\n\\s+- F-A-001 › t9`).test(sr8), sr8.slice(0, 900));
check("a new failing test is not labelled already failing", !/already failing on/.test(sr8));

rmSync(base, { recursive: true, force: true });
console.log(`\n${failures ? `${failures} FAILED` : "all passed"} (TZ ${TZ}: local ${today}, UTC ${utcToday})`);
process.exit(failures ? 1 : 0);
