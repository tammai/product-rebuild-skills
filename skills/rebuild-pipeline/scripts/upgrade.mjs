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

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argAfter = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : undefined; };

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
  ? readFileSync(markerPath, "utf8").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"))
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

// --- classify --------------------------------------------------------------------------
const rows = [];
for (const { rel, src } of VENDORED) {
  const srcHash = sha(src);
  if (!existsSync(rel)) { rows.push({ rel, src, srcHash, state: "new" }); continue; }
  const mine = sha(rel);
  if (mine === srcHash) { rows.push({ rel, src, srcHash, state: "current" }); continue; }
  // `kept` is checked FIRST and against the live hash: a file the human chose to keep, still
  // exactly as they left it, is its own state. Edited again since the decision, it drops back
  // to `modified` — the decision covered that version of the file, not the path forever.
  if (kept[rel] === mine) { rows.push({ rel, src, srcHash, state: "kept" }); continue; }
  const recorded = baseline[rel];
  if (!recorded) rows.push({ rel, src, srcHash, state: "unknown" });
  else if (recorded === mine) rows.push({ rel, src, srcHash, state: "stale" });
  else rows.push({ rel, src, srcHash, state: "modified" });
}

// --- pairs: a script and the schema for the file it writes move together ----------------
// scripts/autopilot.mjs writes plan/autopilot.yaml, which validate.mjs checks against
// schemas/autopilot.schema.json. Copy the new script and refuse its old schema (or the reverse)
// and the workbench fails validation on the next write — found in a real dry run, where the
// script was `stale` and the schema `unknown`. So when one half of a pair is refused and not
// forced, the safe half is HELD rather than copied, until the pair can move as one.
const forcedEarly = new Set((argAfter("--force") || "").split(",").map((s) => s.trim()).filter(Boolean));
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
  const want = argAfter("--diff");
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

const forced = new Set((argAfter("--force") || "").split(",").map((s) => s.trim()).filter(Boolean));
const safe = [...of("new"), ...of("stale")];
const refused = [...of("modified"), ...of("unknown"), ...of("kept"), ...of("held")];
const forcedRows = refused.filter((r) => forced.has(r.rel));
const unknownForce = [...forced].filter((f) => !rows.some((r) => r.rel === f));
if (unknownForce.length) {
  console.error(`--force names path(s) that are not vendored files: ${unknownForce.join(", ")}`);
  process.exit(1);
}

// --- --keep: record a deliberate decision to hold our own version ----------------------
if (has("--keep")) {
  const want = (argAfter("--keep") || "").split(",").map((x) => x.trim()).filter(Boolean);
  const bad = want.filter((w) => !rows.some((r) => r.rel === w));
  if (!want.length || bad.length) {
    console.error(bad.length ? `--keep names path(s) that are not vendored files: ${bad.join(", ")}`
      : "--keep needs at least one path, e.g. --keep scripts/parity.mjs");
    process.exit(1);
  }
  const nextKept = { ...kept };
  for (const w of want) nextKept[w] = sha(w);
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
  const prog = existsSync(join("plan", "progress.yaml")) ? readFileSync(join("plan", "progress.yaml"), "utf8") : "";
  const inProg = (prog.match(/^\s+(S\d+):\s*in-progress\s*$/m) || [])[1];
  if (inProg) why.push(`${inProg} in progress`);
  const ap = existsSync(join("plan", "autopilot.yaml")) ? readFileSync(join("plan", "autopilot.yaml"), "utf8") : "";
  if (/^status: engaged$/m.test(ap)) why.push("autopilot engaged");
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
  let valid = "not run (no node_modules)";
  if (existsSync("node_modules")) {
    try { execFileSync("node", [join("scripts", "validate.mjs")], { stdio: "pipe" }); valid = "passes"; }
    catch { valid = "FAILS — run `npm run validate` and read it before any other work"; }
  }
  const refusedLine = refused.length
    ? ` ${refused.length} refused (${refused.map((r) => r.rel.split(/[\\/]/).pop()).join(", ")}) — run \`node scripts/upgrade.mjs\` to see why.`
    : "";
  console.log(`TOOLING  upgraded ${copied.length} file(s) to plugin ${pluginVersion}` +
    (committed ? ", committed" : " — NOT committed, commit it before anything else") +
    `; validate ${valid}.${refusedLine}`);
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
console.log("Re-run `npm run validate` before doing anything else, and commit this in one go: " +
  "a half-upgraded workbench is the state nothing else in the pipeline expects.");
