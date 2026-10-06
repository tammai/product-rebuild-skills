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

// --- Windows: the shell a hook command runs in, and paths written MSYS-style ------------------
// Both take `platform` (and the env/exists they read) as arguments rather than reading
// process.platform, so eval/repo-hooks.mjs can check the win32 branch on a POSIX host.

// The shell repo-hooks.mjs runs a forwarded hook command in. Hook commands are shell lines
// (`node "${CLAUDE_PROJECT_DIR}/..."`), and Claude Code itself runs them in Git Bash on Windows,
// so the forwarder must too. Issue #3: a hard-coded `/bin/sh` is ENOENT on Windows, and since a
// guard that did not complete is a block, every tool call aimed at a guarded repo was rejected.
// Order on win32: CLAUDE_CODE_GIT_BASH_PATH (the variable Claude Code reads for the same
// purpose), then Git for Windows' usual installs, then plain `sh` resolved on PATH. When none
// exists the spawn still fails with ENOENT and the forwarder blocks, naming this variable.
export const hookShell = (platform, env = process.env, exists = existsSync) => {
  if (platform !== "win32") return "/bin/sh";
  const roots = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"],
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")].filter(Boolean);
  const candidates = [env.CLAUDE_CODE_GIT_BASH_PATH,
    ...roots.flatMap((r) => ["bin\\bash.exe", "bin\\sh.exe", "usr\\bin\\sh.exe"].map((s) => `${r}\\Git\\${s}`))];
  return candidates.find((c) => c && exists(c)) || "sh";
};

// A path as Node on this platform reads it. On win32 a Bash command written for Git Bash names
// directories MSYS-style (`cd /c/Users/x/app`), which `resolve()` turns into `C:\c\Users\x\app`
// — no repo there, so the forwarder ran nothing and the guards were skipped by spelling alone
// (issue #3). `/c/...` and `/cygdrive/c/...` become `C:/...`; `~` becomes the home directory,
// since HOME is often unset outside Git Bash. Other platforms get only the `~` expansion.
export const nativePath = (p, platform, home) => {
  let s = p.replace(/^~(?=[\\/]|$)/, home || "~");
  if (platform === "win32") s = s.replace(/^\/(?:cygdrive\/)?([a-zA-Z])(?:\/|$)/, (_, d) => `${d.toUpperCase()}:/`);
  return s;
};
