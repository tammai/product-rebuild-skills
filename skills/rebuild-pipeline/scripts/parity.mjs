#!/usr/bin/env node
// parity.mjs — G6 parity report. Run from the workbench root.
// Diffs matrix feature statuses and writes parity/<date>.md, and — when the AC suite left a
// JUnit file at parity/<date>-ac.xml — the AC pass rate that suite actually produced.
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
  overlayWarning = `\n> **${unrecorded.length} feature(s) in a shipped slice have no \`plan/progress.yaml\` entry**, so the `
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

// ---------------------------------------------------------------------------
// AC pass rate, from the AC suite's own JUnit output — not from a hand-written summary.
//
// g6-parity.md step 1 runs `maestro test parity/flows --format junit --output
// parity/<date>-ac.xml`. Reading that file here rather than asking a human to transcribe the
// result is the same rule g5-build.md states for verification scripts: an artifact a human
// reads afterwards must name only what actually ran. A transcribed pass rate is exactly the
// banner that survives after the run that produced it is forgotten.
//
// Deliberately not an XML parser (the plugin ships no dependencies, and the workbench's three
// are for schema validation). JUnit's shape is fixed enough that counting <testcase> elements
// and the ones carrying a <failure>/<error> child is reliable; anything it cannot read is
// reported as unreadable rather than silently counted as zero failures.
// ---------------------------------------------------------------------------
const AC_JUNIT = `parity/${date}-ac.xml`;
const readAcSuite = () => {
  if (!existsSync(AC_JUNIT)) return null;
  let xml;
  try { xml = readFileSync(AC_JUNIT, "utf8"); }
  catch (e) { return { unreadable: e.message }; }
  // Split on the opening tag so each chunk is one test case plus whatever it contained.
  const chunks = xml.split(/<testcase\b/).slice(1);
  if (!chunks.length) return { unreadable: "no <testcase> elements" };
  const cases = chunks.map((chunk) => {
    // Everything up to this case's end — self-closing, or the matching </testcase>.
    const end = chunk.indexOf("</testcase>");
    const body = end === -1 ? chunk.split(/<testcase\b/)[0] : chunk.slice(0, end);
    const attr = (n) => (body.match(new RegExp(`\\b${n}="([^"]*)"`)) || [])[1] || "";
    const name = [attr("classname"), attr("name")].filter(Boolean).join(" › ") || "(unnamed)";
    if (/<skipped\b/.test(body)) return { name, state: "skipped" };
    if (/<(failure|error)\b/.test(body)) return { name, state: "failed" };
    return { name, state: "passed" };
  });
  const count = (st) => cases.filter((c) => c.state === st).length;
  return {
    total: cases.length, passed: count("passed"), failed: count("failed"),
    skipped: count("skipped"), failures: cases.filter((c) => c.state === "failed"),
  };
};
const ac = readAcSuite();
// The section is owned only when there is a JUnit file to own it from. Without one, the title
// stays out of OWNED so a previously generated section — or a hand-written `## AC suite` for a
// project whose AC suite is not Maestro — is preserved by the merge below instead of erased.
const AC_TITLE = "AC suite (Maestro JUnit)";
let acSection = "";
if (ac?.unreadable) {
  acSection = `\n## ${AC_TITLE}\n\n- \`${AC_JUNIT}\` exists but could not be read as JUnit ` +
    `(${ac.unreadable}). Pass rate NOT reported — do not read its absence as a pass.\n`;
  console.warn(`warning: ${AC_JUNIT} is not readable as JUnit (${ac.unreadable}) — no AC pass rate in the report.`);
} else if (ac) {
  const rate = ac.total ? Math.round((ac.passed / ac.total) * 100) : 0;
  const failed = ac.failures.length
    ? "\n\nFailed:\n" + ac.failures.map((c) => `- ${c.name}`).join("\n")
    : "";
  const skipped = ac.skipped ? ` ${ac.skipped} skipped — a skipped AC is not a passing one.` : "";
  acSection = `\n## ${AC_TITLE}\n\nAC pass rate: ${ac.passed}/${ac.total} (${rate}%), ` +
    `${ac.failed} failed.${skipped} Source: \`${AC_JUNIT}\`.${failed}\n`;
}

// ---------------------------------------------------------------------------
// Weakest parity claims: features whose evidence is ALL `inferred`.
//
// `basis` (findings/**.yaml, evidence entries) records where a fact came from — transcribed
// from source at the pinned commit, observed at runtime, or inferred from docs/changelogs/API
// responses. A feature standing entirely on inferred evidence is one nobody read out of the
// source and nobody watched happen; the parity number counts it exactly like the rest, which
// is precisely why it is worth naming separately.
//
// The join from a feature to its findings is best-effort and the report says so — see
// basis.mjs's featureBasis(). A feature that joins to nothing is reported as unjoined rather
// than as clean, because a zero produced by a failed join is indistinguishable from a zero
// produced by good evidence.
// ---------------------------------------------------------------------------
let basisSection = "";
try {
  const { featureBasis } = await import("./basis.mjs");
  const { inferredOnly, unjoined } = featureBasis()(features);
  if (inferredOnly.length || (unjoined.length && unjoined.length < features.length)) {
    const lines = [];
    if (inferredOnly.length) {
      lines.push(`Inferred-only features: ${inferredOnly.length} — every piece of evidence behind ` +
        `${inferredOnly.length === 1 ? "this feature" : "these features"} is \`basis: inferred\` ` +
        `(docs, changelogs, API responses, reasoning). Nothing was transcribed from source and ` +
        `nothing was observed running. These are the weakest parity claims in this report.`);
      lines.push("", ...inferredOnly.map((f) => `- ${f.id} ${f.name}`));
    }
    if (unjoined.length) {
      lines.push("", `${unjoined.length} feature(s) could not be joined to any finding, so their ` +
        `basis is unknown rather than sound — this line exists so the count above is read with ` +
        `its denominator.`);
    }
    basisSection = `\n## Evidence basis\n\n${lines.join("\n")}\n`;
  }
} catch { /* basis.mjs absent in a hand-upgraded workbench — validate.mjs reports that */ }

// A G6 run is part generated, part hand-written: the AC suite result and the
// upstream re-mine are authored by a human or the orchestrator. Re-running on the
// same date must not silently eat them, so keep every `## ` section this script
// does not own.
const OWNED = [
  "Missing (in a done slice but not covered — investigate)",
  "Partial",
  "Upstream candidates (from re-mining — decide at next slice boundary)",
  "Slice progress",
  ...(acSection ? [AC_TITLE] : []),
  ...(basisSection ? ["Evidence basis"] : []),
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
${overlayWarning}${acSection}${basisSection}
## Missing (in a done slice but not covered — investigate)
${list(suspicious)}

## Partial
${list(buckets.partial)}

## Upstream candidates (from re-mining — decide at next slice boundary)
${list(buckets.upstream)}

## Slice progress
${slices.map((s) => `- ${s.id} ${s.name}: ${s.status}${notes[s.id] ? `\n  - ${notes[s.id].trim().replace(/\n/g, "\n    ")}` : ""}`).join("\n") || "- no slice plan yet"}
${preserved}`);
const acNote = ac && !ac.unreadable ? ` AC ${ac.passed}/${ac.total} passed.` : "";
console.log(`Wrote ${path} — coverage ${pct}%.${acNote}${preserved ? " Hand-written sections preserved." : ""}`);
