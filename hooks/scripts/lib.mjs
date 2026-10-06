// lib.mjs — shared prelude for the PreToolUse guards. Every guard reads the hook payload,
// resolves the target file, and walks up to the workbench root (marker: locks/pipeline.yaml).
// Each of those used to be copy-pasted; one copy to fix is the point of this file.
// Every helper fails open: it exits 0 itself when the edit is not one the guards care about.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

export const readPayload = () => {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return process.exit(0); }
};

// Returns { payload, abs, root } or exits 0 when there is no target or no workbench above it.
export const locate = () => {
  const payload = readPayload();
  const target = payload?.tool_input?.file_path || payload?.tool_input?.path;
  if (!target) process.exit(0);
  const abs = resolve(payload?.cwd || process.cwd(), target);
  let root = dirname(abs);
  while (root !== dirname(root)) {
    if (existsSync(join(root, "locks", "pipeline.yaml"))) break;
    root = dirname(root);
  }
  if (!existsSync(join(root, "locks", "pipeline.yaml"))) process.exit(0); // not in a workbench
  return { payload, abs, root };
};

// The paths a lock file protects: the `  - x` items of the top-level `protects:` block only,
// not any other indented list in the file (e.g. `history:` entries).
// CRLF is normalised here rather than at each caller: a lock file checked out with
// core.autocrlf=true never matches `^protects:[ \t]*\n`, and an empty list means gate-guard
// lets every edit through to a locked gate.
export const parseProtects = (text) => {
  const block = text.replace(/\r\n?/g, "\n").match(/^protects:[ \t]*\n((?:[ \t]+.*\n?)*)/m);
  if (!block) return [];
  return [...block[1].matchAll(/^  - (.+)$/gm)].map((m) => m[1].trim());
};
