#!/usr/bin/env node
// flows-guard.mjs — PreToolUse hook: block edits to a COMMITTED AC flow under parity/flows/.
// Reads the hook payload from stdin, finds the nearest workbench root above the target file
// (marker: locks/pipeline.yaml), and denies writes to flow files git already tracks.
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
if (!rel.startsWith("parity/flows/")) process.exit(0);
// The directory's own documentation and its decision log are prose about the rule, not flows.
if (/^parity\/flows\/(README\.md|DECISIONS\.md|\.unlocked\.yaml)$/.test(rel)) process.exit(0);

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
const unlockFile = join(root, "parity", "flows", ".unlocked.yaml");
if (existsSync(unlockFile)) process.exit(0);

// A workbench scaffolded at 0.12.0 or 0.13.0 has parity/flows/ but no scripts/flows.mjs — the
// directory arrived a release before the mechanism did. Every other script this plugin added
// late degrades a CHECK when it is missing; this one would degrade into a hard block with an
// escape hatch that does not exist, which is the one failure mode a guard must never have. So
// when the script is absent, say so and name the upgrade in the same breath.
const hasFlowsScript = existsSync(join(root, "scripts", "flows.mjs"));
const escapeHatch = hasFlowsScript
  ? `  npm run flows -- unlock --reason "..."   # then make the change, then: npm run flows -- relock\n`
  : `  This workbench has no scripts/flows.mjs — it predates the mechanism. Copy it from the\n` +
    `  plugin's skills/rebuild-pipeline/scripts/, add "flows": "node scripts/flows.mjs" to\n` +
    `  package.json's scripts, and add parity/flows/.unlocked.yaml to .gitignore (an active\n` +
    `  unlock must never be committed). Then:\n` +
    `    npm run flows -- unlock --reason "..."   # change it, then: npm run flows -- relock\n`;

console.error(
  `Blocked: ${rel} is a recorded AC flow (committed under parity/flows/).\n` +
  `These flows were recorded against the LEGACY app before the slice was built — that ` +
  `authorship direction is the only reason the suite measures parity instead of agreeing with ` +
  `whatever got built.\n` +
  `If a build is failing this flow, the flow is doing its job. Do NOT loosen the assertion to ` +
  `make it pass: that silently redefines parity and reads downstream as a build that got ` +
  `better.\n` +
  `If the assertion is genuinely wrong, that is a human decision and it gets logged, same ` +
  `register as a gate reopen:\n` +
  escapeHatch +
  `Recording NEW flows and ADDING assertions need none of this — only an existing committed ` +
  `flow is guarded.`
);
process.exit(2);
