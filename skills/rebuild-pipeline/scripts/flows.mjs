#!/usr/bin/env node
// flows.mjs — the logged-decision mechanism for AC flow assertions. Run from the workbench root.
// Usage:
//   node scripts/flows.mjs status
//   node scripts/flows.mjs unlock --reason "..." [--by <name>]
//   node scripts/flows.mjs relock [--by <name>]
//
// Zero-dependency, and deliberately so: the PreToolUse guard imports nothing from here but
// reads the same file, and a guard that needs `npm install` to work is a guard that fails open
// on a fresh clone.
//
// WHY THIS EXISTS
//
// `parity/flows/` holds the acceptance-criteria suite, recorded against the LEGACY app before
// each slice builds (g5-build.md step 0). That authorship direction is the only thing making it
// a parity harness rather than a suite that agrees with whatever got built. It is not
// hash-locked into a gate — flows are recorded per slice, and gate-locking them would mean a
// formal reopen every slice, which is the bookkeeping-versus-decisions line plan/progress.yaml
// already draws. So the substitute rule is:
//
//   An assertion in a recorded flow changes only with a logged human decision.
//
// Same register as a gate reopen: a human decides, the reason is written down. This script is
// the log, and hooks/scripts/flows-guard.mjs is the teeth. The failure being prevented is
// specific: an agent with a red build and a flow within reach will loosen the assertion, and
// the result is indistinguishable from a build that got better.

import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export const FLOWS_DIR = "parity/flows";
export const UNLOCK_FILE = join(FLOWS_DIR, ".unlocked.yaml");
export const DECISION_LOG = join(FLOWS_DIR, "DECISIONS.md");

/** Is the assertion rule currently suspended, and why? Read by the guard and by pause-check. */
export const readUnlock = (root = ".") => {
  const p = join(root, UNLOCK_FILE);
  if (!existsSync(p)) return null;
  let text = "";
  try { text = readFileSync(p, "utf8"); } catch { return null; }
  const get = (k) => (text.match(new RegExp(`^${k}:\\s*(.*)$`, "m")) || [])[1]?.trim().replace(/^"|"$/g, "");
  return { reason: get("reason") || "(no reason recorded)", at: get("at") || "(unknown)", by: get("by") || "unknown" };
};

// --- CLI below. Importing this module runs nothing. ---
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  if (!existsSync(join("locks", "pipeline.yaml"))) {
    console.error("No locks/pipeline.yaml here — run from the workbench root.");
    process.exit(1);
  }
  const cmd = process.argv[2] || "status";
  const argAfter = (flag) => {
    const i = process.argv.indexOf(flag);
    return i !== -1 ? process.argv[i + 1] : undefined;
  };
  const by = argAfter("--by") || process.env.USER || "unknown";
  const now = new Date().toISOString();
  const yamlStr = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
  const logDecision = (line) => {
    mkdirSync(FLOWS_DIR, { recursive: true });
    if (!existsSync(DECISION_LOG)) {
      writeFileSync(DECISION_LOG, "# AC flow assertion decisions\n\n" +
        "Every suspension of the assertion rule, and every restoration of it, in order.\n" +
        "Written by `npm run flows -- unlock|relock`. Do not edit by hand — the point of the\n" +
        "log is that it records what happened, not what someone remembers happening.\n\n");
    }
    appendFileSync(DECISION_LOG, line);
  };

  if (cmd === "status") {
    const u = readUnlock();
    if (u) {
      console.log(`AC flow assertions: UNLOCKED since ${u.at} by ${u.by}\n  reason: ${u.reason}`);
      console.log(`\nRe-lock as soon as the change is made: npm run flows -- relock`);
      console.log(`Left unlocked, the guard is off and nothing notices an assertion being loosened.`);
    } else {
      console.log("AC flow assertions: protected. Editing a committed flow under parity/flows/ is blocked.");
      console.log("  To change one deliberately: npm run flows -- unlock --reason \"...\"");
    }
    process.exit(0);
  }

  if (cmd === "unlock") {
    const reason = argAfter("--reason");
    if (!reason) {
      console.error("Unlocking requires --reason \"...\" — it is a formal, logged event, same as a gate reopen.");
      console.error("Say which assertion is changing and why the old one was wrong. \"tests failing\" is not a reason;");
      console.error("it is the situation the rule exists for.");
      process.exit(1);
    }
    mkdirSync(FLOWS_DIR, { recursive: true });
    writeFileSync(join(FLOWS_DIR, ".unlocked.yaml"),
`# AC flow assertions are temporarily unprotected. Written by scripts/flows.mjs.
# Re-lock with: npm run flows -- relock
at: ${now}
by: ${yamlStr(by)}
reason: ${yamlStr(reason)}
`);
    logDecision(`- **${now}** · unlocked by ${by}\n  - ${reason}\n`);
    console.log(`AC flow assertions unlocked. Logged to ${DECISION_LOG}.`);
    console.log(`Make the change, then: npm run flows -- relock`);
    console.log(`pause-check will flag this workbench as unsafe to pause until you do.`);
    process.exit(0);
  }

  if (cmd === "relock") {
    const u = readUnlock();
    if (!u) { console.log("Already protected — nothing to re-lock."); process.exit(0); }
    rmSync(join(FLOWS_DIR, ".unlocked.yaml"));
    logDecision(`- **${now}** · re-locked by ${by} (was unlocked ${u.at})\n`);
    console.log(`AC flow assertions re-locked. Logged to ${DECISION_LOG}.`);
    process.exit(0);
  }

  console.error("Usage: flows.mjs status | unlock --reason \"...\" [--by <name>] | relock [--by <name>]");
  process.exit(1);
}
