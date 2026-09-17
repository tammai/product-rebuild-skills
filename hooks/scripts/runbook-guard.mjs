#!/usr/bin/env node
// runbook-guard.mjs — PreToolUse hook: block writes into a CODE REPO while a slice after S1
// is in progress and the workbench has no plan/BUILD_RUNBOOK.md.
// Reads the hook payload from stdin, finds the code repo root above the target file
// (marker: .rebuild-workbench, holding the absolute workbench path), and denies the write.
// Exit 0 = allow. Exit 2 = block (stderr is fed back to the model).
// Fails open on anything unexpected — the guard must never break unrelated edits.
//
// WHAT IT PROTECTS
//
// S1 is where the team discovers how the locked contracts, the harness scaffold and the
// reference's quirks actually combine — which codegen invocation works, which harness output
// needed adjusting, what the running reference does that the spec never said. None of that is
// written anywhere S2's agents will read, so every later slice's lanes rediscover it, each at
// full price, each slightly differently.
//
// The runbook is the fix, and this hook is why it gets written. The rule could have been a line
// in g5-build.md telling the orchestrator to write it at the S1 boundary — but an instruction
// the orchestrator applies to itself mid-slice is a budget, and a hook is a limit. That is the
// same argument that made gate-guard a hook rather than a paragraph.
//
// WHY THE MARKER, AND NOT THE SUBMODULE
//
// A code repo pins the workbench as a read-only submodule at a GATE TAG — so the submodule's
// own plan/progress.yaml is checked out at gate-4/vN and is stale by design: it cannot know
// which slice is in progress, because slices happen after that tag. The guard needs the LIVE
// workbench, so G5's repo checklist writes `.rebuild-workbench` at the repo root holding its
// absolute path.
//
// FAILING OPEN IS THE DEFAULT, AND IT IS DELIBERATE
//
// No marker, an unreadable marker, a workbench path that no longer exists, no progress file,
// no slice in progress, S1 in progress, a runbook already there — every one of those allows the
// write. This guard fires on exactly one configuration. A guard that fires on anything it does
// not understand blocks unrelated work in repos that have nothing to do with this pipeline, and
// the escape hatch it offers has to be one that exists: here it is always "write the runbook",
// a file the person being blocked can create in the next tool call.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join, isAbsolute } from "node:path";

let input = "";
try { input = readFileSync(0, "utf8"); } catch { process.exit(0); }
let payload;
try { payload = JSON.parse(input); } catch { process.exit(0); }

const target = payload?.tool_input?.file_path || payload?.tool_input?.path;
if (!target) process.exit(0);
const abs = resolve(payload?.cwd || process.cwd(), target);

// Walk up for the code repo's marker.
let repo = dirname(abs);
while (repo !== dirname(repo)) {
  if (existsSync(join(repo, ".rebuild-workbench"))) break;
  repo = dirname(repo);
}
const markerPath = join(repo, ".rebuild-workbench");
if (!existsSync(markerPath)) process.exit(0); // not a code repo of a rebuild project

let workbench = "";
try { workbench = readFileSync(markerPath, "utf8").split("\n").map((l) => l.trim())
  .find((l) => l && !l.startsWith("#")) || ""; } catch { process.exit(0); }
if (!workbench) process.exit(0);
// Relative is allowed and resolved against the repo root — a marker committed to a repo that
// several people clone side by side with the workbench is more useful relative than absolute.
const wbRoot = isAbsolute(workbench) ? workbench : resolve(repo, workbench);
if (!existsSync(join(wbRoot, "locks", "pipeline.yaml"))) process.exit(0); // stale marker

// Never guard the workbench itself. Writing the runbook is the remedy this hook names, and a
// guard that blocked its own remedy would be the pre-0.14.0 flows-guard mistake again: an
// escape hatch that does not exist.
if (resolve(abs) === resolve(wbRoot) || resolve(abs).startsWith(resolve(wbRoot) + "/")) process.exit(0);

const RUNBOOK = join(wbRoot, "plan", "BUILD_RUNBOOK.md");
if (existsSync(RUNBOOK)) process.exit(0); // the thing this guard exists to require

// Which slice is in progress? Same fixed-YAML-subset read as gate.mjs's sliceStates(): the
// hook cannot depend on the workbench's node_modules, and this is one `slices:` block.
const progressPath = join(wbRoot, "plan", "progress.yaml");
if (!existsSync(progressPath)) process.exit(0);
let progress = "";
try { progress = readFileSync(progressPath, "utf8"); } catch { process.exit(0); }
const block = progress.match(/^slices:\n((?:(?:[ \t]+.*)?\n)*)/m);
if (!block) process.exit(0);
const inProgress = [...block[1].matchAll(/^\s+(S\d+):\s*([a-z-]+)/gm)]
  .filter((m) => m[2] === "in-progress").map((m) => m[1]);
if (!inProgress.length) process.exit(0);

// S1 is exempt, and it is the whole point: S1 is where the runbook's content is DISCOVERED.
// Requiring it during S1 would require writing down lessons nobody has learned yet.
const afterS1 = inProgress.filter((id) => id !== "S1");
if (!afterS1.length) process.exit(0);

console.error(
  `Blocked: ${afterS1.join(", ")} ${afterS1.length > 1 ? "are" : "is"} in progress and ` +
  `${RUNBOOK} does not exist.\n` +
  `\n` +
  `Slice S1 discovered how the locked contracts, the harness scaffold and the reference's ` +
  `quirks actually combine. None of that is written anywhere this slice's lanes will read, so ` +
  `they are about to rediscover it — each lane separately, and not necessarily the same way.\n` +
  `\n` +
  `Write the build runbook first, at the workbench, from what the S1 lanes REPORTED — not from ` +
  `memory (g5-build.md, "Write the build runbook"). Fixed sections: how codegen from ` +
  `contracts/ was invoked and what it got wrong; harness quirks that needed adjusting, and why; ` +
  `reference behaviors the running instance revealed that the spec did not say; the ` +
  `test-fixture approach; deploy prerequisites that turned out to be missing; commands that ` +
  `worked, verbatim.\n` +
  `\n` +
  `  ${RUNBOOK}\n` +
  `\n` +
  `Creating that file unblocks this write immediately — the guard checks only that it exists. ` +
  `An empty one would satisfy the hook and defeat the point, which is why the sections are ` +
  `named above and why slice-review.mjs asks, at every later boundary, what this slice taught ` +
  `that the runbook did not know.`
);
process.exit(2);
