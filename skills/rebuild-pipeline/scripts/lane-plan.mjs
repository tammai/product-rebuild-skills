#!/usr/bin/env node
// lane-plan.mjs — write a G5 build lane's PLAN.md from the slice specs you approved (E17b, 0.29.0).
// Run from the workbench root, right after the slice's specs are approved and before the lane
// is dispatched.
//
//   node scripts/lane-plan.mjs S3 billing-backend --worktree ../app-S3-billing \
//        --specs plan/specs/S3/billing.md,plan/specs/S3/invoicing.md
//   node scripts/lane-plan.mjs S3 billing-backend --worktree ../app-S3-billing \
//        --specs plan/specs/S3/billing.md --amend --reason "AC 4 contradicted R-BILL-002"
//
// WHY THIS EXISTS. Every code repo carries bigin-harness-setup's spec-gate-guard: no edit over
// ~20 lines until PLAN.md at the worktree root says `Status: approved`. Since E17a forwards that
// guard to pipeline sessions, a lane with no plan is blocked on its first real edit. The human
// approval the gate wants already exists — you approve a slice's specs before any code
// (g5-build.md; autopilot halts for it) — but it lived in the workbench and never reached the
// file the gate reads. A lane told to write its own plan would be approving itself: `*.md` is on
// the guard's exempt list, so nothing would stop it, and the gate would then report an approval
// no person gave. So the plan is written here, by script, at the approval moment, and carries
// where the approval came from (`Approved:` — spec paths, workbench commit, approver).
//
// THE FORMAT IS task-workflow's PLAN.md, deliberately: `Status:` and `Branch:` are what the guard
// reads (`^Status:\s*(\S+)`, `^Branch:\s*(\S+)` — eval/lane-plan.mjs copies both patterns; if
// bigin changes them, change it), and task-workflow's verifier and its cleanup step read the rest.
// Tasks are one row per acceptance criterion, so `Done` means the same thing in the plan, in the
// AC→test mapping and in the per-rule parity report.
//
// It refuses rather than guesses: specs with uncommitted changes (the approval would point at
// text no commit holds), a worktree on a branch other than slice/<Sn>-<lane>, and an existing
// PLAN.md with unfinished rows (task-workflow's own never-overwrite rule). Every write is recorded
// in plan/lane-plans/<Sn>.yaml with a sha256 of the plan's `## Spec` section, which
// slice-review.mjs re-checks: the guard cannot stop a lane editing its own approved spec, since
// `*.md` is exempt, so the slice boundary is where that edit becomes visible.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// Section boundaries of a PLAN.md this script wrote. Spec headings are demoted two levels when
// embedded (below), so `## Tasks` and `## Amendments` are the only h2s after `## Spec`.
export const specSection = (plan) => {
  const m = plan.match(/^## Spec\n([\s\S]*?)(?=^## Tasks\s*$)/m);
  return m ? m[1] : null;
};
export const specHash = (plan) => {
  const s = specSection(plan);
  return s === null ? null : createHash("sha256").update(s).digest("hex");
};
export const taskRows = (plan) => {
  const sec = plan.match(/^## Tasks\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] || "";
  return sec.split("\n").filter((l) => /^\|\s*\d+\s*\|/.test(l)).map((l) => {
    // Split on unescaped pipes only: an AC text may carry `\|`.
    const cells = l.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    return { n: Number(cells[0]), task: cells[1] || "", status: cells[2] || "", notes: cells[3] || "" };
  });
};
export const readLanePlans = (sliceId, root = ".") => {
  const p = join(root, "plan", "lane-plans", `${sliceId}.yaml`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8").replace(/^#.*\n/gm, "")); } catch { return null; }
};

// The acceptance criteria of one spec: the list items under `## Acceptance criteria`, the same
// section and item shape validate.mjs counts for its rule_id figures.
const acceptanceCriteria = (text) => {
  const sec = text.split(/^##\s+/m).slice(1).find((c) => /^acceptance criteria\s*$/i.test(c.split("\n")[0].trim()));
  if (!sec) return [];
  return sec.split("\n").filter((l) => /^\s*(?:\d+\.|[-*])\s+\S/.test(l)).map((l) => l.replace(/^\s*(?:\d+\.|[-*])\s+/, "").trim());
};

// `record-verify` (E18, 0.30.0): the orchestrator records each lane-verifier round here, so the
// slice boundary can say whether every lane was audited and how it ended, instead of the claim
// living in a conversation nobody re-reads. The cap of 3 is task-workflow's: every verifier
// dispatch on a plan is a round, and the third FAIL ends the loop with a halt for the user.
export const VERIFY_CAP = 3;
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain && process.argv[2] === "record-verify") {
  const args = process.argv.slice(3);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const [sliceId, lane] = args.filter((a, i) => !a.startsWith("--") && !["--verdict", "--round", "--issues"].includes(args[i - 1]));
  const verdict = String(opt("--verdict") || "").toUpperCase();
  const round = Number(opt("--round"));
  const die = (msg) => { console.error(`lane-plan record-verify: ${msg}`); process.exit(1); };
  if (!existsSync(join("locks", "pipeline.yaml"))) die("no locks/pipeline.yaml here — run from the workbench root.");
  if (!sliceId || !lane || !["PASS", "FAIL"].includes(verdict) || !Number.isInteger(round) || round < 1) {
    die("usage: lane-plan.mjs record-verify <Sn> <lane> --verdict PASS|FAIL --round <n> [--issues <count>]");
  }
  const rec = readLanePlans(sliceId);
  if (!rec?.lanes?.[lane]) die(`no plan recorded for ${sliceId} ${lane} — a verifier audits a diff against a plan, so write the plan first.`);
  const rounds = rec.lanes[lane].verify || [];
  if (round !== rounds.length + 1) die(`round ${round} out of order: ${rounds.length} round(s) already recorded for ${lane}.`);
  if (round > VERIFY_CAP) die(`round ${round} is past the cap of ${VERIFY_CAP}. The loop ended at round ${VERIFY_CAP}; that is a halt for the user, not another round.`);
  const d = new Date();
  rounds.push({ round, verdict, issues: Number(opt("--issues") || 0), at: d.toISOString() });
  rec.lanes[lane].verify = rounds;
  writeFileSync(join("plan", "lane-plans", `${sliceId}.yaml`),
    "# Written by scripts/lane-plan.mjs; read by slice-review.mjs. Do not hand-edit.\n" + JSON.stringify(rec, null, 2) + "\n");
  const capHit = verdict === "FAIL" && round === VERIFY_CAP;
  console.log(`${sliceId} ${lane}: verifier round ${round}/${VERIFY_CAP} ${verdict}` +
    (capHit ? ` — cap reached. HALT: show the user the issues and ask whether to amend the plan, raise the cap, or take over.` : ""));
  process.exit(0);
}
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const OPTS = new Set(["--worktree", "--specs", "--reason", "--branch"]);
  const [sliceId, lane] = args.filter((a, i) => !a.startsWith("--") && !OPTS.has(args[i - 1]));
  const amend = args.includes("--amend");
  const die = (msg) => { console.error(`lane-plan: ${msg}`); process.exit(1); };

  if (!existsSync(join("locks", "pipeline.yaml"))) die("no locks/pipeline.yaml here — run from the workbench root.");
  if (!sliceId || !lane || !opt("--worktree") || !opt("--specs")) {
    die("usage: lane-plan.mjs <Sn> <lane> --worktree <path> --specs <a.md,b.md> [--amend --reason \"...\"] [--branch <name>]");
  }
  if (amend && !opt("--reason")) die("--amend needs --reason: the amendment log is the only record the plan's shape changed.");

  const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
  const worktree = resolve(opt("--worktree"));
  const specs = opt("--specs").split(",").map((s) => s.trim()).filter(Boolean);

  // The approval must point at committed text.
  for (const s of specs) {
    if (!existsSync(s)) die(`no such spec ${s}`);
    if (!s.replace(/\\/g, "/").startsWith(`plan/specs/${sliceId}/`)) die(`${s} is not under plan/specs/${sliceId}/`);
  }
  let dirty, untracked;
  try {
    dirty = git(".", "status", "--porcelain", "--", ...specs);
    untracked = specs.filter((s) => { try { git(".", "ls-files", "--error-unmatch", s); return false; } catch { return true; } });
  } catch { die("the workbench is not a git repository, so there is no commit for the approval to point at."); }
  if (untracked.length) die(`not committed: ${untracked.join(", ")}. Commit the approved specs first.`);
  if (dirty) die(`uncommitted changes to approved specs:\n${dirty}\nCommit them first — the approval has to point at text a commit holds.`);
  const commit = git(".", "rev-parse", "--short", "HEAD");
  let approver = "";
  try { approver = git(".", "config", "user.name"); } catch { /* unset */ }
  if (!approver) die("git user.name is unset in the workbench, so the approval would name nobody.");

  // The worktree, on the lane's own branch.
  let branch;
  try { branch = git(worktree, "branch", "--show-current"); } catch { die(`${worktree} is not a git worktree.`); }
  const expected = opt("--branch") || `slice/${sliceId}-${lane}`;
  if (branch !== expected) {
    die(`${worktree} is on '${branch || "(detached)"}', expected '${expected}'. One lane, one worktree, one ` +
      `branch: the guard reads PLAN.md per worktree, so two lanes sharing a checkout would share a plan.`);
  }

  const planPath = join(worktree, "PLAN.md");
  const existing = existsSync(planPath) ? readFileSync(planPath, "utf8") : null;
  const oldRows = existing ? taskRows(existing) : [];
  if (existing && !amend && oldRows.some((r) => r.status !== "Done")) {
    die(`${planPath} has unfinished rows. Finish or archive that plan, or use --amend if the approved specs changed.`);
  }
  if (amend && !existing) die(`--amend: there is no ${planPath} to amend.`);

  // Spec text, verbatim apart from headings demoted two levels so the plan's own `## Tasks`
  // stays the only h2 after `## Spec`.
  const date = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const specBody = specs.map((s) => {
    const text = readFileSync(s, "utf8").replace(/^(#{1,4})(\s)/gm, "##$1$2");
    return `### ${s.replace(/\\/g, "/")}\n\n${text.trim()}\n`;
  }).join("\n");
  const acs = specs.flatMap((s) => {
    const mod = s.split(/[\\/]/).pop().replace(/\.md$/, "");
    return acceptanceCriteria(readFileSync(s, "utf8")).map((ac, i) => `${mod} AC${i + 1}: ${ac}`.replace(/(?<!\\)\|/g, "\\|"));
  });
  if (!acs.length) die("the specs carry no `## Acceptance criteria` items, so there is nothing to make task rows from.");

  // On amend, a row keeps its status only when its criterion text is unchanged; a changed
  // criterion is a new row, which is how an invalidated `Done` goes back to `Not started`.
  const oldByTask = new Map(oldRows.map((r) => [r.task, r]));
  const rows = acs.map((task, i) => {
    const keep = amend ? oldByTask.get(task) : null;
    return `| ${i + 1} | ${task} | ${keep?.status || "Not started"} | ${keep?.notes || ""} |`;
  });
  const added = amend ? acs.filter((t) => !oldByTask.has(t)).length : 0;
  const removed = amend ? oldRows.filter((r) => !acs.includes(r.task)).length : 0;
  const priorAmendments = existing?.match(/^## Amendments\n([\s\S]*)$/m)?.[1]?.trim();
  const amendLine = amend ? `- ${date} @ workbench ${commit}, ${approver}: ${opt("--reason")} (rows added ${added}, dropped ${removed})` : null;

  const plan = [
    `# Plan: ${sliceId} ${lane}`,
    "",
    "Status: approved",
    `Branch: ${branch}`,
    `Approved: ${specs.map((s) => s.replace(/\\/g, "/")).join(", ")} @ workbench ${commit} — ${approver}, ${date}`,
    "",
    "Written by the rebuild pipeline's lane-plan.mjs from the slice specs approved in the workbench. " +
      "Work the task rows; do not edit Status, Branch, Approved or the Spec section. If the spec is " +
      "wrong, set `Status: amending` and report — that is the only Status edit a lane may make.",
    "",
    "## Spec",
    "",
    specBody,
    "## Tasks",
    "",
    "| # | Task | Status | Notes |",
    "|---|------|--------|-------|",
    ...rows,
    ...(priorAmendments || amendLine ? ["", "## Amendments", "", ...(priorAmendments ? [priorAmendments] : []), ...(amendLine ? [amendLine] : [])] : []),
    "",
  ].join("\n");
  writeFileSync(planPath, plan);

  // The record slice-review checks against. JSON in a .yaml file: valid YAML, and readable here
  // without the yaml dependency, so this script runs in a workbench whose node_modules is absent.
  const recPath = join("plan", "lane-plans", `${sliceId}.yaml`);
  mkdirSync(join("plan", "lane-plans"), { recursive: true });
  const rec = readLanePlans(sliceId) || { slice: sliceId, lanes: {} };
  const prior = rec.lanes[lane] || {};
  rec.lanes[lane] = {
    // A new or amended plan restarts the verifier count, as task-workflow resets it: earlier
    // rounds audited a plan that no longer exists. They are kept, not dropped, as history.
    verify: [],
    ...(amend && (prior.verify?.length || prior.verify_prior?.length)
      ? { verify_prior: [...(prior.verify_prior || []), ...(prior.verify || [])] } : {}),
    worktree: relative(".", worktree) || ".", branch, specs: specs.map((s) => s.replace(/\\/g, "/")),
    workbench_commit: commit, approved_by: approver, approved_at: date,
    spec_sha256: specHash(plan), tasks: acs.length,
    amendments: (rec.lanes[lane]?.amendments || 0) + (amend ? 1 : 0),
  };
  writeFileSync(recPath, "# Written by scripts/lane-plan.mjs; read by slice-review.mjs. Do not hand-edit.\n" +
    JSON.stringify(rec, null, 2) + "\n");

  console.log(`${amend ? "amended" : "wrote"} ${planPath}: ${acs.length} task row(s), Status: approved, ` +
    `Branch: ${branch}, approved @ workbench ${commit} by ${approver}` +
    (amend ? ` — ${added} row(s) added, ${removed} dropped` : "") + `\nrecorded in ${recPath}`);
}
