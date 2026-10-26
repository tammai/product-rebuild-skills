#!/usr/bin/env node
// v1-fence.mjs (eval) — 0.33.1: do 0.x's guards leave a 1.x workbench alone?
//
//   node skills/rebuild-pipeline/eval/v1-fence.mjs
//
// 1.x is a different plugin, `product-rebuild`, so the two can be enabled side by side. The workbench
// marker `rebuild_major: 1` is what each plugin reads to tell its own workbenches from the other's.
// This checks the 0.x side: gate-guard blocks an edit to a locked file in a workbench with no marker,
// and does nothing in one that carries it; repo-hooks.mjs forwards nothing for a 1.x workbench's repos.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hooks", "scripts");
let failures = 0;
const check = (name, ok, d = "") => { console.log(`${ok ? "ok  " : "FAIL"}  ${name}`); if (!ok) { failures++; if (d) console.log("      " + d); } };

const make = (marker) => {
  const proj = mkdtempSync(join(tmpdir(), "v1-fence-"));
  const wb = join(proj, "p-workbench");
  mkdirSync(join(wb, "locks"), { recursive: true });
  mkdirSync(join(wb, "matrix"));
  writeFileSync(join(wb, "locks", "pipeline.yaml"), `project: x\nschema_version: "0.4.0"\n${marker ? "rebuild_major: 1\n" : ""}`);
  writeFileSync(join(wb, "locks", "gate-1.yaml"), "gate: gate-1\nstatus: locked\nprotects:\n  - matrix\n");
  // A listed code repo whose own settings.json registers a hook that blocks every Write.
  const repo = join(proj, "app");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(wb, "repos.yaml"), "repos:\n  - name: app\n    path: ../app\n");
  writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo blocked >&2; exit 2" }] }] } }));
  return { proj, wb, repo };
};
const gate = ({ wb }) => spawnSync("node", [join(HOOKS, "gate-guard.mjs")], {
  input: JSON.stringify({ cwd: wb, tool_name: "Write", tool_input: { file_path: join(wb, "matrix", "features.yaml"), content: "x" } }), encoding: "utf8" });
const forward = ({ proj, repo }) => spawnSync("node", [join(HOOKS, "repo-hooks.mjs")], {
  input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: proj, tool_name: "Write", tool_input: { file_path: join(repo, "a.go"), content: "x" } }),
  encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: proj } });

check("a 0.x workbench's locked file is still protected", gate(make(false)).status === 2);
check("a 1.x workbench is left alone (the other plugin's guards govern it)", gate(make(true)).status === 0);
check("a 0.x workbench's repo still gets its own hooks forwarded", forward(make(false)).status === 2);
check("a 1.x workbench's repo gets nothing forwarded", forward(make(true)).status === 0);
console.log(failures ? `\n${failures} failure(s).` : "\nall passed");
process.exit(failures ? 1 : 0);
