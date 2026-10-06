#!/usr/bin/env node
// lane-plan.mjs (eval) — E17b, 0.29.0: does lane-plan.mjs write a PLAN.md the harness's spec gate
// accepts, refuse what it must, amend without losing progress, and does slice-review notice a
// lane editing its own approved spec?
//
//   node skills/rebuild-pipeline/eval/lane-plan.mjs
//
// Scaffolds a throwaway workbench with rebuild-init.mjs (plus `npm install`, for slice-review's
// yaml dependency) and a code repo with a lane worktree, then runs the REAL scripts and asserts
// on the files they write. The spec gate's two patterns are copied from bigin-skills'
// spec-gate-guard.mjs (1.106.0) rather than the guard itself being run, since the guard ships in
// another plugin: if bigin changes how it reads Status or Branch, change GUARD_* here, and
// lane-plan.mjs's header, together.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const GUARD_STATUS = /^Status:\s*(\S+)/m;
const GUARD_BRANCH = /^Branch:\s*(\S+)/m;

const base = mkdtempSync(join(tmpdir(), "lane-plan-eval-"));
execFileSync("node", [join(SCRIPTS, "rebuild-init.mjs"), "lp", "--dir", base], { stdio: "ignore" });
const wb = join(base, "lp-workbench");
execFileSync("npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: wb, stdio: "ignore" });

const sh = (cwd, cmd, ...a) => execFileSync(cmd, a, { cwd, encoding: "utf8" });
const gitId = ["-c", "user.email=eval@x", "-c", "user.name=Eval Approver"];
const commitAll = (cwd, msg) => { sh(cwd, "git", "add", "-A"); sh(cwd, "git", ...gitId, "commit", "-qm", msg); };
const w = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

// The workbench as a git repo with an identity, as a real one is.
if (!existsSync(join(wb, ".git"))) sh(wb, "git", "init", "-q"); // rebuild-init normally has
sh(wb, "git", "config", "user.name", "Eval Approver");
sh(wb, "git", "config", "user.email", "eval@x");
w(wb, "matrix/features.yaml", "- id: F-A-001\n  name: Alpha\n  domain: billing\n  confidence: high\n");
w(wb, "plan/slices.yaml", "- id: S1\n  name: One\n  features: [F-A-001]\n");
w(wb, "plan/progress.yaml", "slices: { S1: deployed }\nfeatures: { F-A-001: covered }\n");
const specV1 = "---\ndomains: [billing]\n---\n# Billing\n\nWhat it does.\n\n## Acceptance criteria\n\n" +
  "1. A negative amount is rejected with 422. rule_id: R-BILL-001\n2. Totals round half-even to 2 dp.\n";
w(wb, "plan/specs/S1/billing.md", specV1);
commitAll(wb, "specs approved");

// The code repo and the lane's worktree.
const app = join(base, "app");
mkdirSync(app);
sh(app, "git", "init", "-q", "-b", "main");
w(app, "README.md", "app\n");
commitAll(app, "init");
const lanePath = join(base, "app-S1-api");
sh(app, "git", "worktree", "add", "-q", "-b", "slice/S1-api", lanePath);

const lanePlan = (...a) => spawnSync("node", [join("scripts", "lane-plan.mjs"), ...a], { cwd: wb, encoding: "utf8" });
const args = ["S1", "api", "--worktree", lanePath, "--specs", "plan/specs/S1/billing.md"];
const planText = () => (existsSync(join(lanePath, "PLAN.md")) ? readFileSync(join(lanePath, "PLAN.md"), "utf8") : "");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) { failures++; if (detail) console.log(`      ${String(detail).replace(/\n/g, "\n      ")}`); }
};

// --- refusals before anything is written -------------------------------------------------------
w(wb, "plan/specs/S1/billing.md", specV1 + "3. An uncommitted criterion.\n");
let r = lanePlan(...args);
check("refuses specs with uncommitted changes", r.status === 1 && /uncommitted changes/.test(r.stderr), r.stderr);
w(wb, "plan/specs/S1/billing.md", specV1);

r = lanePlan("S1", "api", "--worktree", app, "--specs", "plan/specs/S1/billing.md");
check("refuses a worktree on the wrong branch", r.status === 1 && /expected 'slice\/S1-api'/.test(r.stderr), r.stderr);
check("nothing written by a refusal", !planText());

// --- the plan the gate reads -------------------------------------------------------------------
r = lanePlan(...args);
const plan1 = planText();
check("writes PLAN.md", r.status === 0 && plan1, r.stderr);
check("the spec gate reads Status: approved", GUARD_STATUS.exec(plan1)?.[1]?.toLowerCase() === "approved");
check("the spec gate reads the lane's branch", GUARD_BRANCH.exec(plan1)?.[1] === "slice/S1-api");
const head = sh(wb, "git", "rev-parse", "--short", "HEAD").trim();
check("Approved: names the spec, the workbench commit and the approver",
  new RegExp(`^Approved: plan/specs/S1/billing\\.md @ workbench ${head} — Eval Approver, `, "m").test(plan1), plan1.split("\n").slice(0, 6).join("\n"));
const rows1 = plan1.split("\n").filter((l) => /^\|\s*\d+\s*\|/.test(l));
check("one task row per acceptance criterion", rows1.length === 2, rows1.join("\n"));
check("rule_id carried into its row", /\| 1 \| billing AC1: .*rule_id: R-BILL-001 \| Not started \|/.test(plan1));
check("spec headings demoted, so ## Tasks is the only h2 after ## Spec",
  !/^## Acceptance criteria/m.test(plan1) && /^#### Acceptance criteria/m.test(plan1));
check("recorded in plan/lane-plans/S1.yaml", existsSync(join(wb, "plan/lane-plans/S1.yaml")));

// --- never overwrite unfinished work -----------------------------------------------------------
r = lanePlan(...args);
check("refuses to overwrite a plan with unfinished rows", r.status === 1 && /unfinished rows/.test(r.stderr), r.stderr);

// --- amend: progress kept where the criterion is unchanged -------------------------------------
writeFileSync(join(lanePath, "PLAN.md"), plan1
  .replace(/^(\| 1 \|.*\|) Not started \|/m, "$1 Done |")
  .replace(/^Status: approved$/m, "Status: amending"));
r = lanePlan(...args, "--amend");
check("--amend without --reason is refused", r.status === 1 && /needs --reason/.test(r.stderr), r.stderr);
w(wb, "plan/specs/S1/billing.md", specV1.replace("half-even to 2 dp", "half-even to 2 dp, per line"));
commitAll(wb, "spec amended");
r = lanePlan(...args, "--amend", "--reason", "rounding is per line");
const plan2 = planText();
check("--amend re-approves", r.status === 0 && GUARD_STATUS.exec(plan2)?.[1] === "approved", r.stderr);
check("an unchanged criterion keeps Done", /\| 1 \| billing AC1: .* \| Done \|/.test(plan2), plan2);
check("a changed criterion goes back to Not started", /\| 2 \| billing AC2: .*per line\. \| Not started \|/.test(plan2));
check("the amendment is logged", /^## Amendments\n\n- .*rounding is per line \(rows added 1, dropped 1\)$/m.test(plan2), plan2.split("## Amendments")[1]);

// --- slice-review sees a lane editing its own approved spec ------------------------------------
const review = () => { spawnSync("node", [join("scripts", "slice-review.mjs"), "S1"], { cwd: wb, encoding: "utf8" });
  return readFileSync(join(wb, "plan/slice-reviews/S1.md"), "utf8"); };
let sr = review();
check("slice-review lists the lane plan", /- api: 1\/2 task rows Done · Status: approved/.test(sr), sr.slice(0, 900));
check("an untouched spec raises nothing", !/no longer matches what lane-plan\.mjs wrote/.test(sr));
writeFileSync(join(lanePath, "PLAN.md"), plan2.replace("rejected with 422", "rejected with 400"));
sr = review();
check("a hand-edited ## Spec is named in the review", /no longer matches what lane-plan\.mjs wrote/.test(sr), sr.slice(0, 1200));

// --- E18: verifier rounds recorded, capped, and surfaced -----------------------------------------
const rv = (...a) => spawnSync("node", [join("scripts", "lane-plan.mjs"), "record-verify", "S1", "api", ...a], { cwd: wb, encoding: "utf8" });
writeFileSync(join(lanePath, "PLAN.md"), plan2); // undo the hand-edit above
sr = review();
check("a lane with no verifier round is named", /- api: .*no verifier round recorded/.test(sr) && /api has no recorded verifier PASS/.test(sr), sr.slice(0, 1400));
r = rv("--verdict", "FAIL", "--round", "2");
check("record-verify refuses a round out of order", r.status === 1 && /out of order/.test(r.stderr), r.stderr);
check("round 1 FAIL recorded", rv("--verdict", "FAIL", "--round", "1", "--issues", "2").status === 0);
check("round 2 FAIL recorded", rv("--verdict", "FAIL", "--round", "2", "--issues", "1").status === 0);
r = rv("--verdict", "FAIL", "--round", "3", "--issues", "1");
check("the third FAIL says HALT", r.status === 0 && /cap reached\. HALT/.test(r.stdout), r.stdout + r.stderr);
r = rv("--verdict", "PASS", "--round", "4");
check("a fourth round is refused", r.status === 1 && /past the cap/.test(r.stderr), r.stderr);
sr = review();
check("the review shows the last verdict", /verifier FAIL at round 3\/3/.test(sr), sr.slice(0, 1400));
r = lanePlan(...args, "--amend", "--reason", "plan was wrong");
const rec = JSON.parse(readFileSync(join(wb, "plan/lane-plans/S1.yaml"), "utf8").replace(/^#.*\n/gm, ""));
check("an amended plan restarts the count and keeps prior rounds",
  r.status === 0 && rec.lanes.api.verify.length === 0 && rec.lanes.api.verify_prior?.length === 3, JSON.stringify(rec.lanes.api));
check("round 1 after an amendment is accepted, and PASS clears the review",
  rv("--verdict", "PASS", "--round", "1").status === 0 && /verifier PASS at round 1\/3/.test(review()) && !/has no recorded verifier PASS/.test(review()));

// --- E18: routing resolves build lanes to bigin's agents -----------------------------------------
const route = (cfg) => {
  if (cfg) w(wb, ".claude/model-routing.json", JSON.stringify(cfg));
  return JSON.parse(sh(wb, "node", join("scripts", "routing.mjs"))).roles;
};
let roles = route(null);
check("balanced: build-lane is bigin-skills:worker on sonnet", roles["build-lane"]?.agent === "bigin-skills:worker" && roles["build-lane"].model === "sonnet", JSON.stringify(roles["build-lane"]));
check("balanced: lane-verifier is bigin-skills:verifier", roles["lane-verifier"]?.agent === "bigin-skills:verifier");
roles = route({ profile: "frontier", models: { "lane-verifier": "opus" } });
check("frontier: build-lane is worker-frontier on opus at medium",
  roles["build-lane"].agent === "bigin-skills:worker-frontier" && roles["build-lane"].model === "opus" && roles["build-lane"].effort === "medium", JSON.stringify(roles["build-lane"]));
check("a lane-verifier role override applies", roles["lane-verifier"].model === "opus" && roles["lane-verifier"].modelFrom === "override:role:lane-verifier");

console.log(failures ? `\n${failures} failure(s). Workbench left at ${base}` : "\nall passed");
process.exit(failures ? 1 : 0);
