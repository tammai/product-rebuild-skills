#!/usr/bin/env node
// gate-guard.mjs — PreToolUse hook: block edits to files protected by a LOCKED gate.
// Reads the hook payload from stdin, finds the nearest workbench root above the target
// file (marker: locks/pipeline.yaml), and denies writes into locked `protects:` paths.
// Exit 0 = allow. Exit 2 = block (stderr is fed back to the model).
// Fails open on anything unexpected — the guard must never break unrelated edits.

import { readFileSync, existsSync } from "node:fs";
import { relative, sep, join } from "node:path";
import { locate, parseProtects } from "./lib.mjs";

const { abs, root } = locate();

const rel = relative(root, abs).split(sep).join("/");
for (let g = 1; g <= 5; g++) {
  const lockPath = join(root, "locks", `gate-${g}.yaml`);
  if (!existsSync(lockPath)) continue;
  const text = readFileSync(lockPath, "utf8");
  if (!/^status: locked$/m.test(text)) continue;
  const protects = parseProtects(text);
  for (const p of protects) {
    const norm = p.replace(/\/$/, "");
    if (rel === norm || rel.startsWith(norm + "/")) {
      console.error(
        `Blocked: ${rel} is protected by gate-${g} (status: locked). ` +
        `Do not edit locked artifacts. If this change is genuinely needed, propose ` +
        `reopening the gate to the user: node scripts/gate.mjs reopen gate-${g} --reason "..."`
      );
      process.exit(2);
    }
  }
}
process.exit(0);
