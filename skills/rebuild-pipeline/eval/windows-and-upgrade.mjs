#!/usr/bin/env node
// windows-and-upgrade.mjs (eval) — 0.32.0, issue #2: gaps found upgrading a Windows workbench
// from plugin 0.22.0 to 0.31.0.
//
//   node skills/rebuild-pipeline/eval/windows-and-upgrade.mjs
//
// Scaffolds a throwaway workbench with rebuild-init.mjs and runs the REAL scripts against it:
//   - CRLF files, as git writes them with core.autocrlf=true: gate.mjs status counts done slices,
//     and gate-guard.mjs still blocks an edit under a locked gate;
//   - a numbered `## 5. Acceptance criteria` heading is read by validate.mjs;
//   - `descoped` + `feature_notes` validate, leave the coverage denominator, and are listed by
//     parity.mjs; a descoped feature with no note fails validate;
//   - upgrade.mjs: a vendored copy re-checked-out as CRLF is current, not modified; a forced
//     partial upgrade that breaks an import is named; an --apply that makes validate fail warns.
// The Windows path-separator fixes (isMain, `--force scripts/x.mjs`, the lock file's own path in
// the dirty-tree check) cannot be reproduced on a POSIX host and are not covered here.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..", "scripts");
const PLUGIN = join(HERE, "..", "..", "..");
const base = mkdtempSync(join(tmpdir(), "rebuild-eval-"));
execFileSync("node", [join(SCRIPTS, "rebuild-init.mjs"), "evalwb", "--dir", base], { stdio: "ignore" });
const wb = join(base, "evalwb-workbench");
execFileSync("npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: wb, stdio: "ignore" });

const crlf = (t) => t.replace(/\n/g, "\r\n");
const w = (rel, text) => { mkdirSync(dirname(join(wb, rel)), { recursive: true }); writeFileSync(join(wb, rel), text); };
const read = (rel) => (existsSync(join(wb, rel)) ? readFileSync(join(wb, rel), "utf8") : "");
const run = (script, ...args) => {
  const r = spawnSync("node", [join("scripts", script), ...args], { cwd: wb, encoding: "utf8" });
  return { out: r.stdout + r.stderr, code: r.status };
};
const git = (...a) => execFileSync("git", a, { cwd: wb, encoding: "utf8" });
const commit = (msg) => { git("add", "-A"); git("commit", "-qm", msg); };
const date = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) { failures++; if (detail) console.log(`      ${detail.replace(/\n/g, "\n      ")}`); }
};

const slice = (id, status) => `- id: ${id}\n  name: Slice ${id}\n  features: [F-A-00${id.slice(1)}]\n` +
  `  depends_on: []\n  learning_goals: [x]\n  done_means: the slice is usable end to end\n${status ? `  status: ${status}\n` : ""}`;
const feature = (n) => `- id: F-A-00${n}\n  name: Feature ${n}\n  domain: a\n  confidence: high\n  status: planned\n`;
w("matrix/features.yaml", [1, 2, 3].map(feature).join(""));
w("plan/slices.yaml", ["S1", "S2", "S3"].map((s) => slice(s)).join(""));

// --- 1. CRLF: gate.mjs status reads the lock files and the progress overlay ------------------
// Gates 1-4 locked, so status has to count slices — the path that read "0/18 slices done".
for (const g of [1, 2, 3, 4]) w(`locks/gate-${g}.yaml`, crlf(read(`locks/gate-${g}.yaml`).replace(/^status: .*$/m, "status: locked")));
w("plan/progress.yaml", crlf("slices:\n  S1: done\n\n  S2: done\nfeatures:\n  F-A-001: covered\n  F-A-002: covered\n"));
const st = run("gate.mjs", "status").out;
check("gate status counts done slices in CRLF files", /next unfinished slice S3 \(pending\), 2\/3 slices done/.test(st), st);
git("checkout", "--", "locks");

// --- 2. CRLF: gate-guard still blocks under a locked gate ---------------------------------
const lockText = read("locks/gate-1.yaml").replace(/^status: .*$/m, "status: locked");
w("locks/gate-1.yaml", crlf(lockText));
const guard = spawnSync("node", [join(PLUGIN, "hooks", "scripts", "gate-guard.mjs")], {
  input: JSON.stringify({ tool_input: { file_path: join(wb, "matrix", "features.yaml") }, cwd: wb }), encoding: "utf8",
});
check("gate-guard blocks an edit under a CRLF lock file", guard.status === 2, `exit ${guard.status}: ${guard.stderr}`);
git("checkout", "--", "locks");

// --- 3. numbered Acceptance criteria heading ----------------------------------------------
w("plan/specs/a.md", "---\ndomains: [a]\n---\n# A\n\n## 5. Acceptance criteria\n\n1. It works.\n");
let v = run("validate.mjs");
check("validate reads `## 5. Acceptance criteria`", !/no `## Acceptance criteria` section/.test(v.out), v.out.slice(-800));

// --- 4. descoped + feature_notes ----------------------------------------------------------
w("plan/progress.yaml", "slices:\n  S1: done\nfeatures:\n  F-A-001: covered\n  F-A-003: descoped\n" +
  "feature_notes:\n  F-A-003: \"ruled out by the owner: no users\"\n");
v = run("validate.mjs");
check("validate accepts descoped with a note", v.code === 0, v.out.slice(-800));
run("parity.mjs");
const rep = read(`parity/${date}.md`);
check("parity leaves descoped out of the denominator", /Coverage: 1\/2 covered \(50%\).*1 descoped/.test(rep), rep.slice(0, 400));
check("parity lists descoped features with their reason", /## Descoped[^\n]*\n- F-A-003 Feature 3 — ruled out by the owner/.test(rep), rep);
w("plan/progress.yaml", "features:\n  F-A-003: descoped\n");
v = run("validate.mjs");
check("validate fails a descoped feature with no note", v.code !== 0 && /descoped with no reason.*F-A-003/.test(v.out), v.out.slice(-800));
w("plan/progress.yaml", "features:\n  F-A-001: covered\nfeature_notes:\n  F-A-009: x\n");
v = run("validate.mjs");
check("validate fails a feature_notes key that is not a feature", v.code !== 0 && /feature_notes: unknown feature F-A-009/.test(v.out), v.out.slice(-800));
w("plan/progress.yaml", "slices:\n  S1: done\n");
commit("eval fixtures");

// --- 5. upgrade: a CRLF re-checkout of a pristine copy is current --------------------------
w("scripts/erd.mjs", crlf(read("scripts/erd.mjs")));
let up = run("upgrade.mjs", "--plugin", PLUGIN).out;
check("upgrade: a CRLF copy of a vendored file is not `modified`", !/LOCALLY MODIFIED[\s\S]*scripts\/erd\.mjs/.test(up.split("UNKNOWN")[0]), up);
git("checkout", "--", "scripts/erd.mjs");

// --- 6. upgrade: a forced partial upgrade that breaks an import is named --------------------
// The workbench's acsuite gains an export its own parity.mjs starts using; forcing the plugin's
// acsuite over it, while parity stays local, removes the export parity calls.
w("scripts/acsuite.mjs", read("scripts/acsuite.mjs") + "\nexport const pickRun = () => null;\n");
w("scripts/parity.mjs", read("scripts/parity.mjs") + "\nif (acLib) acLib.pickRun();\n");
commit("local edits");
up = run("upgrade.mjs", "--plugin", PLUGIN, "--force", "scripts/acsuite.mjs").out;
check("upgrade names the import a forced file breaks",
  /BROKEN IMPORTS[\s\S]*parity\.mjs \(this workbench\) uses `pickRun` from acsuite\.mjs \(plugin/.test(up), up);
const pristine = run("upgrade.mjs", "--plugin", PLUGIN).out;
check("upgrade reports no broken import when nothing is forced", !/BROKEN IMPORTS/.test(pristine), pristine);
git("checkout", "HEAD~1", "--", "scripts/acsuite.mjs", "scripts/parity.mjs");
commit("undo local edits");

// --- 7. upgrade --apply warns when validate regresses --------------------------------------
// A local schema that accepts a status the plugin's does not: the workbench validates, then the
// forced plugin schema rejects its own data.
const schema = JSON.parse(read("schemas/progress.schema.json"));
schema.properties.slices.additionalProperties.enum.push("parked");
w("schemas/progress.schema.json", JSON.stringify(schema, null, 2) + "\n");
w("plan/progress.yaml", "slices:\n  S1: parked\n");
commit("local schema");
check("eval setup: the workbench validates before the upgrade", run("validate.mjs").code === 0);
up = run("upgrade.mjs", "--plugin", PLUGIN, "--apply", "--force", "schemas/progress.schema.json").out;
check("upgrade --apply warns that validate now fails", /WARNING[\s\S]*validate passed before this run and FAILS now/.test(up), up.slice(-1200));
check("upgrade --apply prints how to undo it", /git checkout -- .*schemas[\/\\]progress\.schema\.json/.test(up), up.slice(-1200));

console.log(failures ? `\n${failures} failure(s). Workbench left at ${wb}` : "\nall passed");
process.exit(failures ? 1 : 0);
