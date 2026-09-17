#!/usr/bin/env node
// flows-guard.mjs — PreToolUse hook: block edits to a COMMITTED recorded artifact under
// parity/flows/ (Maestro AC flows) or parity/equiv/ (equivalence traces).
// Reads the hook payload from stdin, finds the nearest workbench root above the target file
// (marker: locks/pipeline.yaml), and denies writes to files git already tracks.
// Exit 0 = allow. Exit 2 = block (stderr is fed back to the model).
// Fails open on anything unexpected — the guard must never break unrelated edits.
//
// WHAT IT PROTECTS, AND WHY IT IS NOT THE GATE GUARD
//
// The AC flows are recorded against the LEGACY app before each slice builds. That authorship
// direction is the whole reason the suite measures parity rather than agreeing with whatever
// got built (g5-build.md step 0, g6-parity.md). They are deliberately NOT inside a gate's
// `protects:`, because flows are recorded per slice and gate-locking them would force a formal
// reopen every slice. The rule instead: an assertion in a recorded flow changes only with a
// logged human decision — `npm run flows -- unlock --reason "..."`.
//
// ONE GUARD, TWO DIRECTORIES
//
// `parity/equiv/` holds equivalence traces: what the OLD system actually returned, captured
// before the rebuild's backend lane started. Different layer — HTTP and database rows rather
// than the accessibility tree — and a different question (does the system produce what the old
// system produced, rather than does the UI do what the old UI did). But structurally it is the
// same artifact under the same rule: recorded against the legacy system first, not gate-locked
// because it is recorded per slice, and worthless the moment an agent is free to edit it to
// make a build pass. So it gets the same teeth, in the same hook, with its own unlock file and
// its own decision log. Two guards would be two places to forget.
//
// COMMITTED IS THE LINE, and it is the load-bearing choice here.
//
// Recording a flow is iterative: write, run against the old app, tweak, until green. Blocking
// every edit would make the guard fire constantly during normal work, and a guard that fires on
// legitimate work gets switched off within a week. Committing the flow is the act that says
// "this is the recorded reference" — so an untracked flow is free to edit, and a tracked one is
// not. New files, new directories and deletions all stay unguarded on purpose; the failure being
// prevented is narrow (loosening an assertion that was green against the reference) and a rule
// wide enough to catch everything would catch the recording loop too.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve, relative, sep, join } from "node:path";

let input = "";
try { input = readFileSync(0, "utf8"); } catch { process.exit(0); }
let payload;
try { payload = JSON.parse(input); } catch { process.exit(0); }

const target = payload?.tool_input?.file_path || payload?.tool_input?.path;
if (!target) process.exit(0);
const abs = resolve(payload?.cwd || process.cwd(), target);

// Walk up to find the workbench root.
let root = dirname(abs);
while (root !== dirname(root)) {
  if (existsSync(join(root, "locks", "pipeline.yaml"))) break;
  root = dirname(root);
}
if (!existsSync(join(root, "locks", "pipeline.yaml"))) process.exit(0); // not in a workbench

const rel = relative(root, abs).split(sep).join("/");

// Which of the two recorded suites is this, if either? Everything below is parameterised on
// the answer, so the two stay in step by construction rather than by somebody remembering.
const SUITES = [
  {
    dir: "parity/flows", kind: "recorded AC flow", script: "flows.mjs", npm: "flows",
    guards: (r) => r.endsWith(".yaml") || r.endsWith(".yml"),
    why: "These flows were recorded against the LEGACY app before the slice was built — that " +
      "authorship direction is the only reason the suite measures parity instead of agreeing " +
      "with whatever got built.",
    dont: "Do NOT loosen the assertion to make it pass: that silently redefines parity and " +
      "reads downstream as a build that got better.",
  },
  {
    dir: "parity/equiv", kind: "recorded equivalence trace", script: "equiv.mjs", npm: "equiv",
    guards: (r) => r.endsWith(".trace.yaml"),
    why: "A trace is what the OLD system actually returned — status, response body, and the " +
      "rows the request left behind — captured before this slice's backend lane started.",
    dont: "Do NOT edit the expectation to match the rebuild: that does not make them " +
      "equivalent, it makes the evidence agree with the code, which is the one property this " +
      "lane exists to have.",
  },
];
const suite = SUITES.find((s) => rel.startsWith(s.dir + "/"));
if (!suite) process.exit(0);
// A directory's own documentation, its decision log and its config are prose and settings
// about the rule, not recordings. `config.yaml` names env vars and endpoints and is meant to
// be edited; the request files a trace is recorded FROM are inputs, not evidence.
if (new RegExp(`^${suite.dir}/(README\\.md|DECISIONS\\.md|config\\.yaml|\\.unlocked\\.yaml)$`).test(rel)) process.exit(0);
// Only the recorded artifact itself is guarded — not a *.request.yaml beside it.
if (!suite.guards(rel)) process.exit(0);

// A file git does not track yet is still being recorded — leave the recording loop alone.
let tracked = false;
try {
  execFileSync("git", ["ls-files", "--error-unmatch", "--", rel], { cwd: root, stdio: "pipe" });
  tracked = true;
} catch { process.exit(0); } // untracked, or git unavailable: fail open
if (!tracked) process.exit(0);

// An active, logged decision suspends the rule. Parsed here rather than imported from
// scripts/flows.mjs: the hook runs from the plugin directory against an arbitrary workbench,
// which may be an older one with no such script, and a guard that throws on a missing import
// is a guard that blocks every edit it was never meant to see.
const unlockFile = join(root, ...suite.dir.split("/"), ".unlocked.yaml");
if (existsSync(unlockFile)) process.exit(0);

// A workbench scaffolded at 0.12.0 or 0.13.0 has parity/flows/ but no scripts/flows.mjs — the
// directory arrived a release before the mechanism did. Every other script this plugin added
// late degrades a CHECK when it is missing; this one would degrade into a hard block with an
// escape hatch that does not exist, which is the one failure mode a guard must never have. So
// when the script is absent, say so and name the upgrade in the same breath.
const hasScript = existsSync(join(root, "scripts", suite.script));
const escapeHatch = hasScript
  ? `  npm run ${suite.npm} -- unlock --reason "..."   # then make the change, then: npm run ${suite.npm} -- relock\n`
  : `  This workbench has no scripts/${suite.script} — it predates the mechanism. Copy it from\n` +
    `  the plugin's skills/rebuild-pipeline/scripts/ (or run npm run upgrade), add\n` +
    `  "${suite.npm}": "node scripts/${suite.script}" to package.json's scripts, and add\n` +
    `  ${suite.dir}/.unlocked.yaml to .gitignore (an active unlock must never be committed). Then:\n` +
    `    npm run ${suite.npm} -- unlock --reason "..."   # change it, then: npm run ${suite.npm} -- relock\n`;

console.error(
  `Blocked: ${rel} is a ${suite.kind} (committed under ${suite.dir}/).\n` +
  `${suite.why}\n` +
  `If a build is failing this, it is doing its job. ${suite.dont}\n` +
  `If the recorded expectation is genuinely wrong, that is a human decision and it gets logged, ` +
  `same register as a gate reopen:\n` +
  escapeHatch +
  `Recording NEW ones and ADDING assertions need none of this — only an existing committed ` +
  `recording is guarded.`
);
process.exit(2);
