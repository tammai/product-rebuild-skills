#!/usr/bin/env node
// parity.mjs — G6 parity report. Run from the workbench root.
// Diffs matrix feature statuses and writes parity/<date>.md.
//
// Progress lives in plan/progress.yaml, NOT in the gate-locked artifacts. Both
// matrix/features.yaml (gate-1) and plan/slices.yaml (gate-2) carry a `status:`
// field, but their locks hash the whole file — so recording slice completion there
// meant a formal gate reopen for bookkeeping, and rewrote the hash that dependent
// submodule pins consume, once per slice. Gates protect decisions; progress is not
// a decision. This script overlays progress.yaml onto the locked files: an entry
// there wins, anything absent falls back to the locked `status:`.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { parse } from "yaml";

if (!existsSync("matrix/features.yaml")) {
  console.error("No matrix/features.yaml here — run from the workbench root.");
  process.exit(1);
}
const readYaml = (p, fallback) => (existsSync(p) ? parse(readFileSync(p, "utf8")) ?? fallback : fallback);

const progress = readYaml("plan/progress.yaml", {}) || {};
const featureProgress = progress.features || {};
const sliceProgress = progress.slices || {};
const notes = progress.notes || {};

const features = (readYaml("matrix/features.yaml", []) || [])
  .map((f) => ({ ...f, status: featureProgress[f.id] || f.status || "planned" }));
const slices = (readYaml("plan/slices.yaml", []) || [])
  .map((s) => ({ ...s, status: sliceProgress[s.id] || s.status || "pending" }));

const by = (s) => features.filter((f) => f.status === s);
const buckets = {
  covered: by("covered"), partial: by("partial"),
  missing: by("missing"), planned: by("planned"),
  upstream: by("upstream-candidate"),
};
// `deployed` counts too: a slice that shipped should have its features recorded,
// even when a done_means clause is knowingly unmet and it never reaches `done`.
const shipped = new Set(["done", "deployed"]);
const doneSliceFeatures = new Set(slices.filter((s) => shipped.has(s.status)).flatMap((s) => s.features));
const suspicious = features.filter((f) => doneSliceFeatures.has(f.id) && f.status === "planned");
if (!existsSync("plan/progress.yaml")) {
  console.warn("note: no plan/progress.yaml — reporting locked statuses only, so a built slice will read as planned.");
}

// THE OVERLAY'S SHARP EDGE: a shipped slice whose features carry no progress entry.
//
// `slices:` and `features:` are populated independently, and filling in only the first is the
// natural thing to do — it is what a slice close needs. But then every feature in that slice falls
// through to matrix/features.yaml's `status:`, which is GATE-1 MINING OUTPUT: how well the
// REFERENCE product covered each feature, not how far this rebuild has got. Those two vocabularies
// share the words `covered`, `partial` and `missing`, so nothing looks wrong.
//
// Observed: a ten-slice project reported 23% coverage, with features it had built and verified
// listed as `missing` because the reference lacked them. The number was wrong in BOTH directions
// at once — mined `covered` for unbuilt features inflated it, mined `missing` for built ones
// deflated it — which is why it cannot be spotted by sanity-checking the total.
const unrecorded = [...doneSliceFeatures].filter((id) => !featureProgress[id]);
let overlayWarning = "";
if (unrecorded.length) {
  const sample = unrecorded.slice(0, 5).join(", ") + (unrecorded.length > 5 ? ", …" : "");
  overlayWarning = `> **${unrecorded.length} feature(s) in a shipped slice have no \`plan/progress.yaml\` entry**, so the `
    + `figures below fall back to \`matrix/features.yaml\` — which records how well the REFERENCE `
    + `covered each feature (gate-1 mining), not this rebuild's progress. Record them under `
    + `\`features:\` before reading these numbers as coverage: ${sample}\n`;
  console.warn(`warning: ${unrecorded.length} feature(s) in a shipped slice have no progress entry `
    + `(${sample}).\n  Their status falls back to matrix/features.yaml, which is MINING output — how `
    + `well the reference covered each feature, not how far this rebuild has got. The report says so too.`);
}

const date = new Date().toISOString().slice(0, 10);
const pct = features.length ? Math.round((buckets.covered.length / features.length) * 100) : 0;
const list = (arr) => arr.length ? arr.map((f) => `- ${f.id} ${f.name}`).join("\n") : "- none";

// A G6 run is part generated, part hand-written: the AC suite result and the
// upstream re-mine are authored by a human or the orchestrator. Re-running on the
// same date must not silently eat them, so keep every `## ` section this script
// does not own.
const OWNED = [
  "Missing (in a done slice but not covered — investigate)",
  "Partial",
  "Upstream candidates (from re-mining — decide at next slice boundary)",
  "Slice progress",
];
const path = `parity/${date}.md`;
let preserved = "";
if (existsSync(path)) {
  const kept = readFileSync(path, "utf8")
    .split(/\n(?=## )/)
    .filter((chunk) => chunk.startsWith("## ") && !OWNED.includes(chunk.slice(3).split("\n")[0].trim()));
  if (kept.length) preserved = "\n" + kept.join("\n").trimEnd() + "\n";
}

mkdirSync("parity", { recursive: true });
writeFileSync(path, `# Parity report — ${date}

Coverage: ${buckets.covered.length}/${features.length} covered (${pct}%), ${buckets.partial.length} partial, ${buckets.missing.length} missing, ${buckets.planned.length} planned.

${overlayWarning}

## Missing (in a done slice but not covered — investigate)
${list(suspicious)}

## Partial
${list(buckets.partial)}

## Upstream candidates (from re-mining — decide at next slice boundary)
${list(buckets.upstream)}

## Slice progress
${slices.map((s) => `- ${s.id} ${s.name}: ${s.status}${notes[s.id] ? `\n  - ${notes[s.id].trim().replace(/\n/g, "\n    ")}` : ""}`).join("\n") || "- no slice plan yet"}
${preserved}`);
console.log(`Wrote ${path} — coverage ${pct}%.${preserved ? " Hand-written sections preserved." : ""}`);
