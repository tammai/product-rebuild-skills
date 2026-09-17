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
let slices = (readYaml("plan/slices.yaml", []) || [])
  .map((s) => ({ ...s, status: sliceProgress[s.id] || s.status || "pending" }));

// Slice ORDER lives in plan/sequence.yaml, not in this array. plan/slices.yaml is hashed whole
// by gate-2, so its array order could only be revised by a formal reopen — which is why the
// sequence became an overlay (see sequence.mjs's header). Reading it here keeps the "Slice
// progress" section in the order actually being executed rather than the order Gate 2 first
// wrote. Imported guarded, like erd.mjs and playbook.mjs: a workbench that predates the overlay
// has no such file and no such script, and must keep reporting exactly as it did.
let sequenceLib = null;
try { sequenceLib = await import("./sequence.mjs"); } catch { /* pre-0.15.0 workbench */ }
if (sequenceLib) {
  const { order, present } = sequenceLib.readSequence();
  if (present) {
    const rank = new Map(order.map((id, i) => [id, i]));
    // Anything absent from the overlay sorts last rather than vanishing: a non-permutation is
    // validate.mjs's failure to report, and silently dropping a slice from the report is the
    // one behaviour that would hide it.
    slices = [...slices].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  }
}

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
// The parsing itself lives in acsuite.mjs (shared with slice-review.mjs, which needs a richer
// read of the same file) — including why it is not a real XML parser, and why anything it cannot
// read is reported as unreadable rather than counted as zero failures.
//
// This report reads TODAY's file only, never the newest on disk: it is dated, and borrowing
// another day's numbers would put a pass rate under a heading that did not produce it.
// ---------------------------------------------------------------------------
const AC_JUNIT = `parity/${date}-ac.xml`;
// The reader itself lives in acsuite.mjs, shared with slice-review.mjs. Imported guarded, like
// erd.mjs and playbook.mjs: a hand-upgraded workbench that copied this file without it loses
// the AC section with a warning rather than dying on an unresolved import. Losing the section
// is safe here precisely because AC_TITLE then stays out of OWNED below, so a previously
// generated one is preserved instead of erased.
let acLib = null;
try { acLib = await import("./acsuite.mjs"); }
catch {
  console.warn("note: scripts/acsuite.mjs is missing — no AC pass rate in this report. " +
    "Copy it from the plugin's skills/rebuild-pipeline/scripts/. Do not read its absence as a pass.");
}
const ac = acLib ? acLib.readAcSuite(AC_JUNIT) : null;
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
// Rules table — per-Rule-Card pass/fail, from the same JUnit run as the AC rate above.
//
// The question coverage could never answer. Coverage counts FEATURES: how much of the
// reference this rebuild has built. A feature can be fully built, marked covered, and
// subtly wrong — the invoice total rounds before tax instead of after, the state machine
// allows a transition the reference forbade. Those are Rule Cards (lane R, G1), and until
// an AC cited one there was nothing to report against.
//
// Rendered only when findings/rules/ is non-empty: a project that never ran lane R gets no
// empty table, for the same reason parity says which parity mechanisms apply rather than
// showing blank columns.
// ---------------------------------------------------------------------------
const RULES_TITLE = "Rules (lane R)";
let rulesSection = "";
if (acLib?.readRuleCards) {
  const cards = acLib.readRuleCards(".", parse);
  if (cards.length) {
    if (!ac || ac.unreadable) {
      rulesSection = `\n## ${RULES_TITLE}\n\n${cards.length} Rule Card(s) on disk, but ` +
        `${ac?.unreadable ? `\`${AC_JUNIT}\` could not be read` : `no \`${AC_JUNIT}\` for today`} — ` +
        `no rule can be reported green or red. Do not read this as a pass.\n`;
    } else {
      const { byRule, untested, green, red, skippedOnly } = acLib.groupByRule(ac.cases, cards.map((c) => c.id));
      const byDomain = new Map();
      for (const c of cards) {
        if (!byDomain.has(c.domain)) byDomain.set(c.domain, []);
        byDomain.get(c.domain).push(c);
      }
      const rows = [...byDomain.entries()].sort().map(([domain, list]) => {
        const g = list.filter((c) => green.includes(c.id)).length;
        const r = list.filter((c) => red.includes(c.id)).length;
        const u = list.filter((c) => untested.includes(c.id)).length;
        return `| ${domain} | ${g} of ${list.length} | ${r} | ${u} |`;
      });
      const detail = [];
      if (red.length) {
        detail.push("", "Red:", ...red.map((id) => {
          const g = byRule.get(id);
          const card = cards.find((c) => c.id === id);
          return `- ${id} (${card?.kind || "?"}, ${card?.domain || "?"}) — ${g.failed} of ${g.total} test(s) failing`;
        }));
      }
      if (skippedOnly.length) {
        detail.push("", `Skipped only (neither green nor red — a skipped AC is not a passing one): ` +
          `${skippedOnly.join(", ")}`);
      }
      if (untested.length) {
        detail.push("", `**Untested: ${untested.length}** — ${untested.join(", ")}.`,
          `A rule is joined to the suite by its id appearing in a test NAME (g5-build.md step 1). ` +
          `A rule with no test and a rule whose test forgot to name it are indistinguishable here, ` +
          `and both mean the same thing: nothing on disk demonstrates the rule holds.`);
      }
      rulesSection = `\n## ${RULES_TITLE}\n\n` +
        `${green.length} of ${cards.length} Rule Cards green, ${red.length} red, ` +
        `${untested.length} untested. Source: \`${AC_JUNIT}\`.\n\n` +
        `| Domain | Green | Red | Untested |\n|---|---|---|---|\n${rows.join("\n")}\n` +
        `${detail.join("\n")}\n`;
    }
  }
}

// ---------------------------------------------------------------------------
// Equivalence (lane E8) — does the rebuild produce what the OLD system produced?
//
// The AC suite asks whether the rebuild does what the spec says. Coverage asks how much of the
// reference exists. Neither asks whether `POST /invoices` returns the same totals the old system
// returned, and for a rebuild of your own legacy system that is the question the project is
// actually about.
//
// THREE NUMBERS, NOT ONE. Recorded, replayed, green. A trace that exists and was never replayed
// is not a pass and not a failure — it is evidence nobody checked, and it is invisible in the
// JUnit because the JUnit contains only what ran. Reporting "6/6 green" over a directory holding
// eight traces is the exact overclaim this section exists to prevent.
//
// WHEN THE LANE DOES NOT APPLY, SAY SO. A third-party reference cannot have an equivalence lane
// — there is no legal or practical way to replay traffic against a product you do not operate.
// An absent section and an empty column read identically to someone scanning the report, and
// only one of them means "this was checked and there is nothing".
// ---------------------------------------------------------------------------
const EQUIV_TITLE = "Equivalence (vs the legacy system)";
let equivSection = "";
if (acLib?.readEquivTraces) {
  const refKind = (() => {
    const t = existsSync("sources.yaml") ? readFileSync("sources.yaml", "utf8") : "";
    const b = t.match(/^reference:\n((?:(?:[ \t]+.*)?\n)*)/m);
    return (b?.[1].match(/^\s+kind:\s*(.*)$/m) || [])[1]?.trim().split(/\s+#/)[0].replace(/^["']|["']$/g, "") || "";
  })();
  const traces = acLib.readEquivTraces(".");
  const EQUIV_JUNIT = `parity/${date}-equiv.xml`;
  const eq = acLib.readAcSuite(EQUIV_JUNIT);

  if (refKind !== "own-code" && !traces.length) {
    equivSection = `\n## ${EQUIV_TITLE}\n\nDoes not apply: \`reference.kind\` is ` +
      `\`${refKind || "(unset)"}\`, not \`own-code\`. Replaying recorded traffic against a product ` +
      `you do not operate is neither legal nor practical, so parity for this project rests on the ` +
      `AC suite and the coverage figures above. This line exists so an absent section is not read ` +
      `as an unchecked one.\n`;
  } else if (traces.length) {
    const byFeature = new Map();
    for (const t of traces) {
      if (!byFeature.has(t.feature)) byFeature.set(t.feature, { recorded: [], replayed: 0, green: 0, red: [] });
      byFeature.get(t.feature).recorded.push(t.name);
    }
    let replayedTotal = 0, greenTotal = 0;
    const redCases = [];
    const ruleLines = [];
    if (eq && !eq.unreadable) {
      const { groupByRule, readRuleCards } = acLib;
      for (const c of eq.cases) {
        // classname carries "<feature-id> <rule-id>…" — equiv.mjs writes it that way precisely
        // so this join needs no second index.
        const feature = (c.classname || "").split(/\s+/)[0];
        const g = byFeature.get(feature);
        replayedTotal++;
        if (c.state === "passed") greenTotal++;
        if (g) {
          g.replayed++;
          if (c.state === "passed") g.green++; else g.red.push(c.caseName || c.name);
        }
        if (c.state !== "passed") redCases.push(c);
      }
      // Per Rule Card, where a trace cites one — the same grouping the AC rules table uses.
      if (readRuleCards && groupByRule) {
        const cards = readRuleCards(".", parse);
        if (cards.length) {
          const { byRule, green, red } = groupByRule(eq.cases, cards.map((c) => c.id));
          if (byRule.size) {
            ruleLines.push("", `Per Rule Card: ${green.length} green, ${red.length} red, ` +
              `${cards.length - byRule.size} card(s) cited by no trace.`);
            if (red.length) ruleLines.push(`Red rules: ${red.join(", ")}.`);
          }
        }
      }
    }
    const rows = [...byFeature.entries()].sort().map(([f, g]) =>
      `| ${f} | ${g.recorded.length} | ${g.replayed} | ${g.green} | ${g.red.length ? g.red.join(", ") : "—"} |`);
    const header = eq?.unreadable
      ? `\`${EQUIV_JUNIT}\` exists but could not be read as JUnit (${eq.unreadable}). Replay ` +
        `results NOT reported — do not read their absence as a pass.`
      : eq
        ? `${traces.length} trace(s) recorded, ${replayedTotal} replayed, ${greenTotal} green. ` +
          `Source: \`${EQUIV_JUNIT}\`.`
        : `${traces.length} trace(s) recorded; **no \`${EQUIV_JUNIT}\` for today**, so none of them ` +
          `has been replayed against the current build. Recorded is not green — run ` +
          `\`npm run equiv -- replay --all\`.`;
    const unreplayed = traces.length - replayedTotal;
    const detail = [];
    if (eq && !eq.unreadable && unreplayed > 0) {
      detail.push("", `**${unreplayed} recorded trace(s) were not replayed** in this run. They are ` +
        `neither green nor red — nothing has checked them against the current build.`);
    }
    if (redCases.length) {
      detail.push("", "Red:", ...redCases.map((c) => `- ${c.name}`),
        "", "A red trace is a real difference between the old system and the rebuild. Either the " +
        "rebuild is wrong, or the difference is intended — and if it is intended it goes on the " +
        "record: `npm run equiv -- accept \"<trace>\" --reason \"...\"`. `gate.mjs lock gate-5` " +
        "refuses while the newest run has a failure no decision names.");
    }
    equivSection = `\n## ${EQUIV_TITLE}\n\n${header}\n\n` +
      `| Feature | Recorded | Replayed | Green | Red |\n|---|---|---|---|---|\n${rows.join("\n")}\n` +
      `${ruleLines.join("\n")}${detail.join("\n")}\n`;
  }
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
  ...(rulesSection ? [RULES_TITLE] : []),
  ...(equivSection ? [EQUIV_TITLE] : []),
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
${overlayWarning}${acSection}${rulesSection}${equivSection}${basisSection}
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
const ruleNote = rulesSection.match(/^(\d+) of (\d+) Rule Cards green/m)
  ? ` Rules ${rulesSection.match(/^(\d+) of (\d+) Rule Cards green/m).slice(1, 3).join("/")} green.` : "";
const equivNote = equivSection.match(/^(\d+) trace\(s\) recorded, (\d+) replayed, (\d+) green/m);
console.log(`Wrote ${path} — coverage ${pct}%.${acNote}${ruleNote}${equivNote ? ` Equivalence ${equivNote[3]}/${equivNote[1]} green.` : ""}${preserved ? " Hand-written sections preserved." : ""}`);
