#!/usr/bin/env node
// upgrade.mjs — re-copy scripts and schemas from the installed plugin into this workbench.
// Run from the workbench root.
// Usage:
//   node scripts/upgrade.mjs                     # dry run: what would change, and nothing else
//   node scripts/upgrade.mjs --apply             # copy the safe ones; refuse locally modified
//   node scripts/upgrade.mjs --apply --force scripts/gate.mjs,schemas/rule.schema.json
//   node scripts/upgrade.mjs --diff scripts/gate.mjs   # full diff for one file
//   node scripts/upgrade.mjs --keep scripts/parity.mjs # record: keep OUR version of this one
//   node scripts/upgrade.mjs --plugin <path>     # override where the plugin lives
//   node scripts/upgrade.mjs --auto [--plugin <path>]  # session start: apply the safe ones if
//                                                      # now is a safe moment, commit, one line
//
// Zero-dependency, like every other script a hand-upgraded workbench might run before
// `npm install` — which is most likely exactly when someone runs this one.
//
// WHY A WORKBENCH NEEDS UPGRADING AT ALL
//
// rebuild-init.mjs vendors the schemas and tooling scripts INTO each workbench at scaffold
// time, deliberately: a workbench is a self-contained, versioned copy, and a project mid-G4 is
// not improved by its tooling changing underneath it. The cost is that a workbench scaffolded
// before a release never receives that release's new files, so a reference doc telling you to
// run `npm run preflight` names a script that does not exist. Until now the answer was a `cp`
// line in docs/PLAYBOOK.md per release, which does not scale past about two.
//
// THE HARD PART IS NOT COPYING, IT IS KNOWING WHAT YOU WOULD DESTROY
//
// Some workbenches have LOCAL EDITS to their vendored scripts — a project-specific check bolted
// onto validate.mjs, a parity report with an extra section. A blind re-copy silently deletes
// that work, and it deletes it from the one repo whose whole purpose is holding decisions that
// cannot be reproduced. So this script never overwrites a file it cannot prove is untouched.
//
// Proof comes from `locks/tooling.json`, a manifest of sha256 hashes written by rebuild-init.mjs
// at scaffold time and rewritten here after every apply. A file whose hash matches the manifest
// is a pristine vendored copy and safe to replace. A file whose hash does not is LOCALLY
// MODIFIED and is refused, with the diff, until a human says otherwise with --force.
//
// A workbench scaffolded before the manifest existed has no baseline at all. That case is
// treated as unknown-provenance rather than as unmodified: every differing file is refused the
// same way, because "I cannot tell whether you wrote this" and "you wrote this" deserve the
// same caution and only one of them is safe to guess at.
//
// A REFUSAL MUST NOT DECAY INTO AN OVERWRITE
//
// The first version of this script recorded a refused file's CURRENT hash into the baseline,
// reasoning that a decision to keep a local edit should not be re-litigated every release. That
// was exactly backwards: on the next run the file matched its baseline and differed from the
// plugin, which is the definition of `stale` here — so `--apply` copied over it and the local
// edit was destroyed silently, one release after being deliberately protected. Refusing loudly
// and then quietly overwriting later is worse than never refusing at all.
//
// So a refused file's baseline is left ALONE and it keeps reporting as modified until a human
// acts. `--keep` is the way to act without losing the edit: it records the local version in a
// separate `kept:` map, and a kept file is reported every run, never copied, and never counted
// as up to date. The nag becomes one quiet line instead of a wall of text, which was the real
// problem the bad design was trying to solve.
//
// FILES DEPEND ON EACH OTHER, AND A FORCED UPGRADE CAN BREAK THE ONES IT LEAVES
//
// Every file is classified on its own, but scripts import each other. A 0.22.0 → 0.31.0 upgrade
// forced the plugin's acsuite.mjs over a kept slice-review.mjs that called an export the new
// acsuite no longer had, and slice-review crashed (`acLib.pickRun is not a function`). So the
// set of scripts as it will be AFTER this run is checked for imports that no longer resolve,
// and an --apply runs validate and gate status before and after, and says when either got worse.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

// CRLF to LF on every text read. With git's core.autocrlf=true (the Windows default) the working
// copy is CRLF, and a pattern with a literal `\n` (`^slices:\n`, `^---\n`) silently matches
// nothing — read as "no such block" rather than an error. Same helper in every script that
// parses text; copied, not imported, because each is vendored and must run alone. See
// playbook.mjs's readText for the incident.
const readText = (p) => readFileSync(p, "utf8").replace(/\r\n?/g, "\n");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argAfter = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : undefined; };
// Paths the user names, in the manifest's form. `rel` is built with join(), so the manifest holds
// `scripts\gate.mjs` on Windows and `--force scripts/gate.mjs` was refused as "not a vendored
// file". Keys stay native rather than moving to "/" so an existing Windows manifest still matches.
const native = (p) => join(...p.split(/[\\/]/).filter(Boolean));
const pathList = (flag) => (argAfter(flag) || "").split(",").map((x) => x.trim()).filter(Boolean).map(native);

if (!existsSync(join("locks", "pipeline.yaml"))) {
  console.error("No locks/pipeline.yaml here — run from the workbench root.");
  process.exit(1);
}

// --- where the plugin lives -----------------------------------------------------------
// --plugin wins, then the .rebuild-plugin marker rebuild-init.mjs writes at scaffold time,
// then the environment variable the skill runs under. Marker before env on purpose: a
// workbench can outlive the session that made it, and a stale env var pointing at a plugin
// copy that was since moved would upgrade from the wrong source without saying so.
const markerPath = ".rebuild-plugin";
const fromMarker = existsSync(markerPath)
  ? readText(markerPath).split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"))
  : null;
// An installed plugin lives in a per-version cache directory (…/plugins/cache/<market>/<name>/
// <version>/), and the marker rebuild-init.mjs wrote points at whichever version scaffolded the
// workbench. Read literally, that marker pins upgrades to the old version forever: the plugin
// updates, the marker does not, and every run reports "up to date" against a copy nobody runs.
// So a marker or env path inside the cache follows to the newest installed version beside it.
// An explicit --plugin is taken as given.
const newestCached = (p) => {
  if (!p) return p;
  const m = resolve(p).match(/^(.*[\/\\]plugins[\/\\]cache[\/\\].+)[\/\\](\d+\.\d+\.\d+)[\/\\]?$/);
  if (!m) return p;
  const cmp = (a, b) => a.split(".").map(Number).reduce((d, n, i) => d || n - b.split(".").map(Number)[i], 0);
  let best = m[2];
  try {
    for (const v of readdirSync(m[1])) {
      if (/^\d+\.\d+\.\d+$/.test(v) && existsSync(join(m[1], v, "skills", "rebuild-pipeline")) &&
          cmp(v, best) > 0) best = v;
    }
  } catch { return p; }
  return join(m[1], best);
};
const pluginRoot = argAfter("--plugin") || newestCached(fromMarker || process.env.CLAUDE_PLUGIN_ROOT) || null;
if (!pluginRoot) {
  console.error(
    "Cannot find the plugin. This workbench has no `.rebuild-plugin` marker (it was scaffolded\n" +
    "before 0.17.0) and CLAUDE_PLUGIN_ROOT is not set. Pass it explicitly, and write the marker\n" +
    "so this is a one-time problem:\n" +
    "  node scripts/upgrade.mjs --plugin /path/to/product-rebuild-skills\n" +
    "  echo /path/to/product-rebuild-skills > .rebuild-plugin");
  process.exit(1);
}
const SRC = join(pluginRoot, "skills", "rebuild-pipeline");
if (!existsSync(join(SRC, "scripts")) || !existsSync(join(SRC, "schemas"))) {
  console.error(`Not a product-rebuild-skills plugin root: ${pluginRoot}\n` +
    `  Expected ${join(SRC, "scripts")} and ${join(SRC, "schemas")}.`);
  process.exit(1);
}

const pluginVersion = (() => {
  const p = join(pluginRoot, ".claude-plugin", "plugin.json");
  try { return JSON.parse(readFileSync(p, "utf8")).version || "unknown"; } catch { return "unknown"; }
})();

// --- what is vendored ------------------------------------------------------------------
// Everything the plugin ships under scripts/ and schemas/, minus rebuild-init.mjs — that one
// scaffolds workbenches and is never run from inside one. Enumerating the source rather than
// carrying a hard-coded list is what keeps a future script from being forgotten here, which
// is the failure this whole file exists to stop repeating.
const VENDORED = [
  ...readdirSync(join(SRC, "scripts")).filter((f) => f.endsWith(".mjs") && f !== "rebuild-init.mjs")
    .map((f) => ({ rel: join("scripts", f), src: join(SRC, "scripts", f) })),
  ...readdirSync(join(SRC, "schemas")).filter((f) => f.endsWith(".json"))
    .map((f) => ({ rel: join("schemas", f), src: join(SRC, "schemas", f) })),
];

const MANIFEST = join("locks", "tooling.json");
const MANIFEST_COMMENT =
  "Provenance of the vendored scripts/ and schemas/. `files` is the hash each file had when it " +
  "was last vendored, which is how upgrade.mjs tells a stale copy from one edited here. `kept` " +
  "records files whose local version a human chose to hold: reported every run, never copied " +
  "over. Written by rebuild-init.mjs and upgrade.mjs. Do not hand-edit.";
const manifest = (() => {
  try { return JSON.parse(readFileSync(MANIFEST, "utf8")); } catch { return null; }
})();
const baseline = manifest?.files || {};
const kept = manifest?.kept || {};
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
// A file's hash as it is on disk AND with CRLF turned to LF. With core.autocrlf=true, a vendored
// copy re-checked-out from git is CRLF while its recorded hash is of the plugin's LF bytes, so a
// pristine copy read as `modified` on every clone. Either form matches, which keeps hashes
// recorded before this change (some of them CRLF, for `kept`) valid.
const hex = (buf) => createHash("sha256").update(buf).digest("hex");
const toLF = (buf) => Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
const shas = (p) => { const buf = readFileSync(p); return new Set([hex(buf), hex(toLF(buf))]); };
const lfSha = (p) => hex(toLF(readFileSync(p)));

// --- classify --------------------------------------------------------------------------
const rows = [];
for (const { rel, src } of VENDORED) {
  const srcHash = sha(src);
  if (!existsSync(rel)) { rows.push({ rel, src, srcHash, state: "new" }); continue; }
  const mine = shas(rel);
  if (mine.has(srcHash)) { rows.push({ rel, src, srcHash, state: "current" }); continue; }
  // `kept` is checked FIRST and against the live hash: a file the human chose to keep, still
  // exactly as they left it, is its own state. Edited again since the decision, it drops back
  // to `modified` — the decision covered that version of the file, not the path forever.
  if (mine.has(kept[rel])) { rows.push({ rel, src, srcHash, state: "kept" }); continue; }
  const recorded = baseline[rel];
  if (!recorded) rows.push({ rel, src, srcHash, state: "unknown" });
  else if (mine.has(recorded)) rows.push({ rel, src, srcHash, state: "stale" });
  else rows.push({ rel, src, srcHash, state: "modified" });
}

// --- pairs: a script and the schema for the file it writes move together ----------------
// scripts/autopilot.mjs writes plan/autopilot.yaml, which validate.mjs checks against
// schemas/autopilot.schema.json. Copy the new script and refuse its old schema (or the reverse)
// and the workbench fails validation on the next write — found in a real dry run, where the
// script was `stale` and the schema `unknown`. So when one half of a pair is refused and not
// forced, the safe half is HELD rather than copied, until the pair can move as one.
const forcedEarly = new Set(pathList("--force"));
const isSafe = (r) => r.state === "new" || r.state === "stale";
const isBlocked = (r) => ["modified", "unknown", "kept"].includes(r.state) && !forcedEarly.has(r.rel);
for (const r of rows) {
  const m = r.rel.match(/^scripts[\/\\](.+)\.mjs$/);
  if (!m) continue;
  const mate = rows.find((x) => x.rel === join("schemas", `${m[1]}.schema.json`));
  if (!mate) continue;
  for (const [a, b] of [[r, mate], [mate, r]]) {
    if (isSafe(a) && isBlocked(b)) { a.state = "held"; a.mate = b.rel; }
  }
}

const of = (s) => rows.filter((r) => r.state === s);
const diffOf = (rel, src) => {
  try {
    execFileSync("diff", ["-u", rel, src], { encoding: "utf8" });
    return "";
  } catch (e) { return String(e.stdout || "").split("\n").slice(2).join("\n"); }
};
const diffStat = (rel, src) => {
  const d = diffOf(rel, src);
  if (!d) return "no textual difference";
  const plus = (d.match(/^\+/gm) || []).length, minus = (d.match(/^-/gm) || []).length;
  return `+${plus} -${minus} lines`;
};

// --- --diff <file>: the full thing, for one file ---------------------------------------
if (has("--diff")) {
  const want = native(argAfter("--diff") || "");
  const row = rows.find((r) => r.rel === want || r.rel.endsWith(`/${want}`) || r.rel.endsWith(`\\${want}`));
  if (!row) { console.error(`Not a vendored file: ${want}`); process.exit(1); }
  if (row.state === "new") { console.log(`${row.rel} does not exist here yet — nothing to diff.`); process.exit(0); }
  console.log(`--- ${row.rel} (this workbench)\n+++ ${row.src} (plugin ${pluginVersion})\n`);
  console.log(diffOf(row.rel, row.src) || "(identical)");
  process.exit(0);
}

// --- report ----------------------------------------------------------------------------
// --auto prints none of this: it runs at every session start, and its output lands in the
// orchestrator's context, where a page of file lists is paid for on every later turn.
const auto = has("--auto");
const log = auto ? () => {} : (...a) => console.log(...a);
if (!auto) {
console.log(`Workbench tooling vs plugin ${pluginVersion}`);
console.log(`  plugin: ${resolve(pluginRoot)}${fromMarker && !argAfter("--plugin") ? "  (from .rebuild-plugin)" : ""}`);
console.log(`  baseline: ${manifest ? `${MANIFEST} (written for plugin ${manifest.plugin_version || "?"})`
  : "none — this workbench predates locks/tooling.json, so local edits cannot be told from staleness"}\n`);

const show = (state, label, note) => {
  const list = of(state);
  if (!list.length) return;
  console.log(`${label} (${list.length})`);
  for (const r of list) {
    console.log(`  ${r.rel}${state === "new" ? "" : `  [${diffStat(r.rel, r.src)}]`}`);
  }
  if (note) console.log(`  ${note}`);
  console.log("");
};
show("new", "NEW — not in this workbench yet");
show("stale", "STALE — vendored copy, unmodified, plugin has a newer one");
show("modified", "LOCALLY MODIFIED — refused",
  "These differ from BOTH the plugin and the hash recorded when they were last vendored,\n" +
  "  which means someone edited them here. Read the diff before deciding:\n" +
  "    node scripts/upgrade.mjs --diff <path>\n" +
  "  Then either port your change onto the plugin's version, or force this one file:\n" +
  "    node scripts/upgrade.mjs --apply --force <path>");
show("kept", "KEPT — your version, by recorded decision",
  "Never copied over, and never counted as up to date: the plugin's version has moved on and\n" +
  "  yours has not. Take the plugin's with --apply --force <path>, or edit yours and re-run\n" +
  "  --keep to re-record it.");
show("unknown", "UNKNOWN PROVENANCE — refused",
  "Different from the plugin, with no recorded hash to compare against (this workbench was\n" +
  "  scaffolded before locks/tooling.json). It may be an old vendored copy or your own edit —\n" +
  "  this script cannot tell, and guessing wrong deletes work. Same remedy as above.");
if (of("held").length) {
  console.log(`HELD — safe to copy, but its pair is refused (${of("held").length})`);
  for (const r of of("held")) console.log(`  ${r.rel}  (waits for ${r.mate})`);
  console.log("  A script and the schema for the file it writes move together. Settle the refused\n" +
    "  half (--force, or port your edit), and both copy on the next --apply.\n");
}
if (of("current").length) console.log(`UP TO DATE (${of("current").length})\n`);
}

const forced = new Set(pathList("--force"));
const safe = [...of("new"), ...of("stale")];
const refused = [...of("modified"), ...of("unknown"), ...of("kept"), ...of("held")];
const forcedRows = refused.filter((r) => forced.has(r.rel));
const unknownForce = [...forced].filter((f) => !rows.some((r) => r.rel === f));
if (unknownForce.length) {
  console.error(`--force names path(s) that are not vendored files: ${unknownForce.join(", ")}`);
  process.exit(1);
}

// --- imports that will not resolve after this run ---------------------------------------
// The scripts as they will be once this run copies what it copies, local ones included, and every
// name one of them takes from a sibling that the sibling will no longer export. Regex-read, like
// everything else here: the three import shapes these scripts use are `import { a } from "./x.mjs"`,
// `const { a } = await import("./x.mjs")`, and `lib = await import("./x.mjs")` followed by
// `lib.a` / `lib?.a` / `const { a } = lib`. A name a script feature-detects (`lib.a ? … : …`)
// is still listed — in a mixed set that is worth a look, and a pristine set has none.
const willCopy = new Set([...safe, ...forcedRows].map((r) => r.rel));
const after = new Map();
for (const f of existsSync("scripts") ? readdirSync("scripts") : []) {
  if (f.endsWith(".mjs")) after.set(f, { text: readText(join("scripts", f)), from: "this workbench" });
}
for (const r of rows) {
  const m = r.rel.match(/^scripts[\/\\](.+\.mjs)$/);
  if (m && willCopy.has(r.rel)) after.set(m[1], { text: readText(r.src), from: `plugin ${pluginVersion}` });
}
const ID = "[A-Za-z_$][\\w$]*";
const exportsOf = (t) => new Set([
  ...[...t.matchAll(new RegExp(`^export\\s+(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+(${ID})`, "gm"))].map((m) => m[1]),
  ...[...t.matchAll(/^export\s*\{([^}]*)\}/gm)].flatMap((m) => m[1].split(",").map((x) => x.trim().split(/\s+as\s+/).pop())),
]);
const namesFrom = (t, mod) => {
  const src = `["']\\./${mod.replace(/\./g, "\\.")}["']`;
  const keys = (list, sep) => list.split(",").map((x) => x.trim().split(sep)[0].replace(/^\.\.\./, "")).filter(Boolean);
  const names = new Set();
  for (const m of t.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*${src}`, "g"))) keys(m[1], /\s+as\s+/).forEach((n) => names.add(n));
  for (const m of t.matchAll(new RegExp(`\\{([^{}]*)\\}\\s*=\\s*await\\s+import\\(\\s*${src}`, "g"))) keys(m[1], /\s*:\s*/).forEach((n) => names.add(n));
  for (const m of t.matchAll(new RegExp(`(${ID})\\s*=\\s*await\\s+import\\(\\s*${src}`, "g"))) {
    // The lookbehind skips the variable's name inside a path or a message ("./erd.mjs").
    for (const u of t.matchAll(new RegExp(`(?<![\\w$./\`'"-])${m[1]}\\??\\.(${ID})`, "g"))) if (u[1] !== "mjs") names.add(u[1]);
    // `const { a } = lib;` only — not `const { a } = lib.fn()`, whose keys belong to fn's result.
    for (const u of t.matchAll(new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${m[1]}(?![\\w$.?(\\[])`, "g"))) keys(u[1], /\s*:\s*/).forEach((n) => names.add(n));
  }
  return names;
};
const brokenImports = [];
for (const [importer, a] of after) {
  for (const [mod, b] of after) {
    if (mod === importer) continue;
    const exported = exportsOf(b.text);
    for (const name of namesFrom(a.text, mod)) {
      if (!exported.has(name)) brokenImports.push({ importer, mod, name, a: a.from, b: b.from });
    }
  }
}
// Only the ones this run causes block --auto; one already broken before it is not its to fix.
const causedHere = brokenImports.filter((x) => x.a !== "this workbench" || x.b !== "this workbench");
if (brokenImports.length && !auto) {
  console.log(`BROKEN IMPORTS after this run (${brokenImports.length})`);
  for (const x of brokenImports) {
    console.log(`  ${x.importer} (${x.a}) uses \`${x.name}\` from ${x.mod} (${x.b}), which does not export it`);
  }
  console.log("  Copying one half of a pair of scripts that call each other breaks the other half at\n" +
    "  run time, not here. Settle them as a set: port your edit onto the plugin's version, or force\n" +
    "  both files.\n");
}

// --- --keep: record a deliberate decision to hold our own version ----------------------
if (has("--keep")) {
  const want = pathList("--keep");
  const bad = want.filter((w) => !rows.some((r) => r.rel === w));
  if (!want.length || bad.length) {
    console.error(bad.length ? `--keep names path(s) that are not vendored files: ${bad.join(", ")}`
      : "--keep needs at least one path, e.g. --keep scripts/parity.mjs");
    process.exit(1);
  }
  const nextKept = { ...kept };
  // The LF hash, so the decision survives the file being re-checked-out as CRLF.
  for (const w of want) nextKept[w] = lfSha(w);
  mkdirSync("locks", { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify({
    ...(manifest || {}), comment: MANIFEST_COMMENT, plugin_version: manifest?.plugin_version || pluginVersion,
    updated: new Date().toISOString(), files: baseline, kept: nextKept,
  }, null, 2) + "\n");
  console.log(`Recorded as KEPT: ${want.join(", ")}.`);
  console.log("These are now reported every run and never copied over. Editing one again drops it " +
    "back to `modified` — the decision covers the version you have, not the path forever.");
  process.exit(0);
}

// --- --auto: the session-start path -----------------------------------------------------
// Applies only the files this script can prove are pristine, and only at a moment when tooling
// changing underneath the work cannot hurt: no slice in progress, no engaged autopilot run, a
// clean tree (so the upgrade lands as its own commit and `gate.mjs lock` is not left facing a
// dirty one). Anything else defers to a later session start. It never forces and never keeps;
// refused files are named in one line for a human to settle.
if (auto) {
  if (forced.size || has("--keep")) { console.error("--auto takes neither --force nor --keep."); process.exit(1); }
  const refusedLine = refused.length
    ? ` ${refused.length} refused (${refused.map((r) => r.rel.split(/[\\/]/).pop()).join(", ")}) — run \`node scripts/upgrade.mjs\` to see why.`
    : "";
  if (!safe.length) {
    console.log(`TOOLING  up to date with plugin ${pluginVersion}.${refusedLine}`);
    process.exit(0);
  }
  const why = [];
  try {
    if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) why.push("uncommitted changes");
  } catch { why.push("git unavailable"); }
  const prog = existsSync(join("plan", "progress.yaml")) ? readText(join("plan", "progress.yaml")) : "";
  const inProg = (prog.match(/^\s+(S\d+):\s*in-progress\s*$/m) || [])[1];
  if (inProg) why.push(`${inProg} in progress`);
  const ap = existsSync(join("plan", "autopilot.yaml")) ? readText(join("plan", "autopilot.yaml")) : "";
  if (/^status: engaged$/m.test(ap)) why.push("autopilot engaged");
  if (causedHere.length) why.push(`it would break ${causedHere.length} import(s) between scripts`);
  if (why.length) {
    console.log(`TOOLING  ${safe.length} update(s) from plugin ${pluginVersion} deferred — ${why.join(", ")}. ` +
      `Applies at a session start with none of those true.${refusedLine}`);
    process.exit(0);
  }
}

if (!has("--apply") && !auto) {
  console.log(safe.length || forcedRows.length
    ? `Dry run. ${safe.length} file(s) would be copied. Re-run with --apply.`
    : "Dry run. Nothing to copy.");
  if (refused.length) console.log(`${refused.length} file(s) would be REFUSED (see above).`);
  process.exit(0);
}

// --- apply ------------------------------------------------------------------------------
// What validate and gate status say, taken before and after copying. A script that cannot read
// this workbench's data any more (a schema that rejects a status the workbench uses, a parser
// that misreads its files) shows up here as a worse answer from the same command, which is the
// only comparison that does not need to know what changed.
const health = () => {
  const run = (...a) => {
    try { return { ok: true, out: execFileSync(process.execPath, a, { encoding: "utf8", stdio: "pipe" }) }; }
    catch (e) { return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}` }; }
  };
  const v = existsSync("node_modules") && existsSync(join("scripts", "validate.mjs"))
    ? run(join("scripts", "validate.mjs")).ok : null;
  const g = run(join("scripts", "gate.mjs"), "status");
  const phase = g.ok
    ? (g.out.match(/^(?:Current phase: .*|All gates locked.*)$/m) || ["(no phase line)"])[0]
    : `gate.mjs status failed: ${(g.out.trim().split("\n")[0] || "no output")}`;
  return { validate: v, phase };
};
const before = health();
const existedBefore = new Set([...safe, ...forcedRows].filter((r) => existsSync(r.rel)).map((r) => r.rel));
const copied = [];
for (const r of [...safe, ...forcedRows]) {
  mkdirSync(dirname(r.rel), { recursive: true });
  copyFileSync(r.src, r.rel);
  copied.push(r);
  log(`copied  ${r.rel}${forced.has(r.rel) ? "  (FORCED — your version is gone; git has it if it was committed)" : ""}`);
}

// Rewrite the baseline for the files this run actually vendored, and for those ONLY.
//
// A refused file keeps whatever baseline it had. Recording its current hash instead would make
// today's local edit tomorrow's baseline, so the next run would classify it `stale` — clean
// vendored copy, behind the plugin — and `--apply` would copy straight over the edit that was
// deliberately protected one release earlier. A refusal that decays into a silent overwrite is
// worse than no refusal at all, which is why `--keep` exists as the explicit way to settle one.
const files = { ...baseline };
for (const r of copied) files[r.rel] = r.srcHash;
for (const { rel } of VENDORED) if (!existsSync(rel)) delete files[rel];
mkdirSync("locks", { recursive: true });
writeFileSync(MANIFEST, JSON.stringify({
  comment: MANIFEST_COMMENT,
  plugin_version: pluginVersion,
  updated: new Date().toISOString(),
  files,
  kept,
}, null, 2) + "\n");

if (auto) {
  // One commit, so a regression bisects to it and `git revert` undoes the whole upgrade.
  let committed = false;
  try {
    execFileSync("git", ["add", "--", ...copied.map((r) => r.rel), MANIFEST], { stdio: "pipe" });
    execFileSync("git", ["commit", "-qm", `tooling: upgrade vendored scripts/schemas to plugin ${pluginVersion}`], { stdio: "pipe" });
    committed = true;
  } catch { /* reported below */ }
  const now = health();
  const valid = now.validate === null ? "not run (no node_modules)"
    : now.validate ? "passes"
    : before.validate ? "FAILS, and passed before this upgrade — `git revert HEAD` undoes it; run `npm run validate` to see why"
    : "FAILS (failed before this upgrade too) — run `npm run validate` and read it before any other work";
  const phaseNote = now.phase !== before.phase
    ? ` gate status changed: "${before.phase}" → "${now.phase}" — check which is right before any other work.` : "";
  const refusedLine = refused.length
    ? ` ${refused.length} refused (${refused.map((r) => r.rel.split(/[\\/]/).pop()).join(", ")}) — run \`node scripts/upgrade.mjs\` to see why.`
    : "";
  console.log(`TOOLING  upgraded ${copied.length} file(s) to plugin ${pluginVersion}` +
    (committed ? ", committed" : " — NOT committed, commit it before anything else") +
    `; validate ${valid}.${phaseNote}${refusedLine}`);
  process.exit(0);
}

console.log(`\n${copied.length} file(s) copied from plugin ${pluginVersion}. Baseline rewritten: ${MANIFEST}.`);
const stillRefused = refused.filter((r) => !forced.has(r.rel) && r.state !== "kept");
if (stillRefused.length) {
  console.log(`${stillRefused.length} file(s) left alone: ${stillRefused.map((r) => r.rel).join(", ")}.`);
  console.log("Their baseline is unchanged, so they will be refused again next run — that is the " +
    "point. To settle one: port your change onto the plugin's version and re-run, take the " +
    "plugin's with `--apply --force <path>`, or hold yours on the record with `--keep <path>`.");
}

const now = health();
const worse = [];
if (before.validate && now.validate === false) worse.push("validate passed before this run and FAILS now (npm run validate)");
if (now.phase !== before.phase) worse.push(`gate status said "${before.phase}" and now says "${now.phase}"`);
if (worse.length) {
  console.log(`\nWARNING — this upgrade changed what the workbench reports:\n${worse.map((w) => `  - ${w}`).join("\n")}`);
  console.log("  A changed phase can be a fix (a parser that now reads the file correctly) or a break;\n" +
    "  read both before deciding. To undo the whole run, if these files were committed before it:");
  const restore = copied.filter((r) => existedBefore.has(r.rel)).map((r) => r.rel);
  const added = copied.filter((r) => !existedBefore.has(r.rel)).map((r) => r.rel);
  if (restore.length) console.log(`    git checkout -- ${[...restore, MANIFEST].join(" ")}`);
  else console.log(`    git checkout -- ${MANIFEST}`);
  if (added.length) console.log(`    and delete the file(s) this run added: ${added.join(", ")}`);
} else if (now.validate === null) {
  console.log("validate not run (no node_modules) — run `npm install && npm run validate` before anything else.");
} else {
  console.log(`validate ${now.validate ? "passes" : "fails, as it did before this run"}; gate status unchanged.`);
}
console.log("Commit this in one go: a half-upgraded workbench is the state nothing else in the pipeline expects.");
