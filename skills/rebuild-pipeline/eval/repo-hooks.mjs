#!/usr/bin/env node
// repo-hooks.mjs (eval) — E17a, 0.29.0: does hooks/scripts/repo-hooks.mjs run a code repo's own
// hooks for a pipeline session that started in the project's parent directory, and only then?
//
//   node skills/rebuild-pipeline/eval/repo-hooks.mjs
//
// Builds <project>/ holding a workbench (repos.yaml listing ../app) and a code repo `app` whose
// .claude/settings.json registers stub hooks: one blocks Write, one asks on Edit, one crashes on
// NotebookEdit, one blocks Bash, one adds context after Bash. Hook payloads go straight to the
// forwarder on stdin, as Claude Code would send them, so no model call is needed. The fact the
// forwarder rests on — a parent-rooted session never loads a nested repo's hooks — was verified
// end to end on 2026-10-06 and is recorded in the forwarder's header comment.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hooks", "scripts", "repo-hooks.mjs");
const project = mkdtempSync(join(tmpdir(), "repo-hooks-eval-"));
const w = (rel, text) => { mkdirSync(dirname(join(project, rel)), { recursive: true }); writeFileSync(join(project, rel), text); };
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });

w("proj-workbench/locks/pipeline.yaml", "schema_version: \"0.4.0\"\n");
w("proj-workbench/repos.yaml", "repos:\n  - name: app\n    path: ../app\n");
const stub = (name, body) => w(`app/.claude/guards/${name}`, `#!/bin/sh\n${body}\n`);
stub("block-write.sh", "cat > /dev/null; echo \"write blocked by app's guard\" >&2; exit 2");
stub("ask-edit.sh", "cat > /dev/null; echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"confirm this edit\"}}'");
stub("crash.sh", "cat > /dev/null; echo boom >&2; exit 1");
stub("block-bash.sh", "cat > /dev/null; echo \"bash blocked by app's guard\" >&2; exit 2");
stub("context-bash.sh", "cat > /dev/null; echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"scanned\"}}'");
stub("record-dir.sh", "cat > /dev/null; echo \"$CLAUDE_PROJECT_DIR\" > \"$CLAUDE_PROJECT_DIR/.seen-project-dir\"");
const cmd = (s) => ({ type: "command", command: `sh "\${CLAUDE_PROJECT_DIR}/.claude/guards/${s}"` });
w("app/.claude/settings.json", JSON.stringify({ hooks: {
  PreToolUse: [
    { matcher: "Write", hooks: [cmd("block-write.sh")] },
    { matcher: "Edit|MultiEdit", hooks: [cmd("ask-edit.sh"), cmd("record-dir.sh")] },
    { matcher: "NotebookEdit", hooks: [cmd("crash.sh")] },
    { matcher: "Bash", hooks: [cmd("block-bash.sh")] },
  ],
  PostToolUse: [{ matcher: "Bash", hooks: [cmd("context-bash.sh")] }],
  SessionStart: [{ hooks: [cmd("block-write.sh")] }],
} }, null, 2));
git(project, "init", "-q");          // the project dir itself is not what matters; app is
mkdirSync(join(project, "app"), { recursive: true });
git(join(project, "app"), "init", "-q");
mkdirSync(join(project, "other"));
git(join(project, "other"), "init", "-q");
w("other/.claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "exit 2" }] }] } }));
// Two lane worktrees: one cut after the registrations were committed (the normal case), one cut
// from a commit that predates them, so its checkout has no .claude/ and must fall back.
git(join(project, "app"), "-c", "user.email=e@x", "-c", "user.name=e", "commit", "-q", "--allow-empty", "-m", "before guards");
git(join(project, "app"), "worktree", "add", "-q", "-b", "slice/S0-old", join(project, "app-S0-old"));
git(join(project, "app"), "add", "-A");
git(join(project, "app"), "-c", "user.email=e@x", "-c", "user.name=e", "commit", "-q", "-m", "guards");
git(join(project, "app"), "worktree", "add", "-q", "-b", "slice/S1-api", join(project, "app-S1-api"));

const run = (event, tool, toolInput, sessionRoot = project) => {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: event, tool_name: tool, cwd: sessionRoot, session_id: "eval", tool_input: toolInput }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: sessionRoot }, encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) { failures++; if (detail) console.log(`      ${String(detail).replace(/\n/g, "\n      ")}`); }
};

let r = run("PreToolUse", "Write", { file_path: join(project, "app", "src", "new", "main.go"), content: "x" });
check("a Write into a listed repo runs its guard and blocks", r.code === 2 && /write blocked by app's guard/.test(r.err), JSON.stringify(r));

r = run("PreToolUse", "Write", { file_path: join(project, "app-S1-api", "main.go"), content: "x" });
check("a lane worktree counts through its main repo", r.code === 2 && /write blocked/.test(r.err), JSON.stringify(r));

r = run("PreToolUse", "Write", { file_path: join(project, "app-S0-old", "main.go"), content: "x" });
check("a worktree with no registrations of its own falls back to the main checkout's", r.code === 2 && /write blocked/.test(r.err), JSON.stringify(r));

r = run("PreToolUse", "Write", { file_path: join(project, "other", "main.go"), content: "x" });
check("a repo repos.yaml does not list runs nothing", r.code === 0, JSON.stringify(r));

r = run("PreToolUse", "Write", { file_path: join(project, "app", "main.go"), content: "x" }, join(project, "app"));
check("a session started in the repo forwards nothing (Claude Code loaded it already)", r.code === 0 && !r.err, JSON.stringify(r));

r = run("PreToolUse", "Edit", { file_path: join(project, "app", "main.go"), old_string: "a", new_string: "b" });
const ask = (() => { try { return JSON.parse(r.out).hookSpecificOutput; } catch { return null; } })();
check("an ask is passed through as an ask", r.code === 0 && ask?.permissionDecision === "ask" && /confirm this edit/.test(ask.permissionDecisionReason), JSON.stringify(r));
check("hooks run with CLAUDE_PROJECT_DIR set to the repo", existsSync(join(project, "app", ".seen-project-dir")));

r = run("PreToolUse", "NotebookEdit", { notebook_path: join(project, "app", "n.ipynb"), new_source: "x" });
check("a guard that crashes is a block, never a pass", r.code === 2 && /did not complete \(exit 1\)/.test(r.err) && /boom/.test(r.err), JSON.stringify(r));

r = run("PreToolUse", "Bash", { command: `cd ${join(project, "app")} && go test ./...` });
check("Bash with a leading cd runs the repo's Bash guard", r.code === 2 && /bash blocked/.test(r.err), JSON.stringify(r));

r = run("PreToolUse", "Bash", { command: `git -C ${join(project, "app")} status` });
check("Bash with git -C runs the repo's Bash guard", r.code === 2, JSON.stringify(r));

r = run("PreToolUse", "Bash", { command: "go test ./..." });
check("Bash naming no directory runs nothing", r.code === 0, JSON.stringify(r));

r = run("PostToolUse", "Bash", { command: `cd ${join(project, "app")} && ls` });
const post = (() => { try { return JSON.parse(r.out).hookSpecificOutput; } catch { return null; } })();
check("PostToolUse context is passed through", r.code === 0 && post?.additionalContext === "scanned", JSON.stringify(r));

r = run("SessionStart", undefined, {});
check("SessionStart is never forwarded", r.code === 0, JSON.stringify(r));

r = run("PreToolUse", "Read", { file_path: join(project, "app", "main.go") });
check("a tool the repo registers nothing for runs nothing", r.code === 0 && !r.err, JSON.stringify(r));

console.log(failures ? `\n${failures} failure(s). Project left at ${project}` : "\nall passed");
process.exit(failures ? 1 : 0);
