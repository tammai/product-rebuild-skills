#!/usr/bin/env node
// slice-review.mjs — the between-slices standing report. Run from the workbench root.
// Usage:
//   node scripts/slice-review.mjs [<Sn>]      # defaults to the most recently shipped slice
//
// Writes plan/slice-reviews/<Sn>.md and prints a summary. ADVISORY: it locks nothing, blocks
// nothing, and starting the next slice without it is allowed. Its job is to make "where do we
// stand" answerable at a slice boundary without anyone reconstructing it from scrollback.
//
// WHY IT IS GENERATED AND NOT WRITTEN
//
// Everything here comes off disk: plan/progress.yaml, plan/sequence.yaml, the AC suite's JUnit
// output, matrix/features.yaml. None of it is composed. A slice review an agent writes is a
// summary of what that agent believes it did, which is the failure `verifier`, `rubric-judge`
// and g5-build.md's "a verification script names only what it RAN" all exist to prevent — and a
// slice review is exactly the artifact that outlives the session that produced it. So the
// script states facts and cites their source; judgement goes in the conversation on top of it,
// and anything it could not establish says so rather than going quiet.
//
// WHAT IT ADDS THAT PARITY DOES NOT
//
// parity.mjs answers "how much of the REFERENCE do we cover" — a coverage diff against the
// matrix. Two questions it does not answer, and nothing else did either:
//   - Does the whole product still run? Every per-slice deploy criterion asserts only that
//     slice's features, so "did S3 break S1" had no home. Comparing this AC run against the
//     previous one, by test name, gives it one.
//   - Where does that put us on the roadmap? Position in the execution order, what is next,
//     what is now orderable — the input to the between-slices reorder conversation.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const REVIEW_DIR = "plan/slice-reviews";
const SHIPPED = new Set(["done", "deployed"]);

if (!existsSync(join("locks", "pipeline.yaml"))) {
  console.error("No locks/pipeline.yaml here — run from the workbench root.");
  process.exit(1);
}
const readYaml = (p, fallback) => {
  if (!existsSync(p)) return fallback;
  try { return parse(readFileSync(p, "utf8")) ?? fallback; } catch { return fallback; }
};

// Late-added sibling modules are imported guarded, the same way validate.mjs handles erd.mjs
// and playbook.mjs: a hand-upgraded workbench that copied this file without them should lose
// one section with an explanation, not die on an unresolved import before writing anything.
let seqLib = null, acLib = null;
try { seqLib = await import("./sequence.mjs"); } catch { /* reported in the report */ }
try { acLib = await import("./acsuite.mjs"); } catch { /* reported in the report */ }

const slices = readYaml("plan/slices.yaml", []) || [];
if (!slices.length) {
  console.error("plan/slices.yaml has no slices — nothing to review. This runs at a slice boundary, after G3.");
  process.exit(1);
}
const byId = new Map(slices.filter((s) => s?.id).map((s) => [s.id, s]));
const progress = readYaml("plan/progress.yaml", {}) || {};
const sliceProgress = progress.slices || {};
const featureProgress = progress.features || {};
const notes = progress.notes || {};
const statusOf = (id) => sliceProgress[id] || byId.get(id)?.status || "pending";

const order = seqLib ? seqLib.readSequence().order : slices.map((s) => s.id);
const orderSource = seqLib?.readSequence().present ? "plan/sequence.yaml" : "plan/slices.yaml (positional)";

const wanted = process.argv[2];
const shippedInOrder = order.filter((id) => SHIPPED.has(statusOf(id)));
const sliceId = wanted || shippedInOrder[shippedInOrder.length - 1];
if (!sliceId) {
  console.error("No slice has shipped yet, and none was named. Usage: npm run slice-review -- <Sn>");
  process.exit(1);
}
if (!byId.has(sliceId)) { console.error(`${sliceId} is not in plan/slices.yaml.`); process.exit(1); }
const slice = byId.get(sliceId);
const sliceStatus = statusOf(sliceId);
const date = new Date().toISOString().slice(0, 10);

// Facts are collected as data, then rendered twice — once as markdown, once for the terminal.
// The terminal summary used to be produced by pattern-matching the markdown it had just built,
// which dropped exactly the lines worth reading: a "1 regression(s)" header survived and the
// regression's name, one line below it, did not.
const md = { run: [], shipped: [], pressure: [] };  // markdown blocks
const term = { run: [], pressure: [] };             // terminal lines
const press = (head, detail) => { term.pressure.push(head); md.pressure.push(detail ?? `- ${head}`); };

// --- 1. does it run? -----------------------------------------------------
// The cumulative question. Not "did this slice's tests pass" — every deploy criterion already
// asserted that — but "is everything built so far still passing", and if not, what broke.
const matrix = readYaml("matrix/features.yaml", []) || [];
const featureIds = matrix.map((f) => f?.id).filter(Boolean);
let runHeadline = "NOT ESTABLISHED — see the report";
if (!acLib) {
  md.run.push("- `scripts/acsuite.mjs` is missing from this workbench, so the AC suite was not read. " +
    "Copy it from the plugin's `skills/rebuild-pipeline/scripts/`. **Do not read its absence as a pass.**");
  term.run.push("scripts/acsuite.mjs missing — the suite was not read. Not a pass.");
} else {
  const files = acLib.acJunitFiles();
  const curr = files.length ? acLib.readAcSuite(files[0].path) : null;
  if (!files.length) {
    md.run.push("- No `parity/<date>-ac.xml` on disk, so **no AC result is reported here at all**. " +
      "This is not a pass and not a failure — nothing ran, or nothing was recorded. " +
      "See `g6-parity.md` step 1 for the command that produces it.");
    term.run.push("No AC JUnit file on disk. Nothing ran, or nothing was recorded — not a pass.");
  } else if (curr?.unreadable) {
    md.run.push(`- \`${files[0].path}\` exists but could not be read as JUnit (${curr.unreadable}). ` +
      `Pass rate NOT reported — do not read its absence as a pass.`);
    term.run.push(`${files[0].path} is not readable as JUnit (${curr.unreadable}). Not a pass.`);
  } else {
    const rate = curr.total ? Math.round((curr.passed / curr.total) * 100) : 0;
    const ageDays = Math.round((Date.parse(date) - Date.parse(files[0].date)) / 86400000);
    runHeadline = `${curr.passed}/${curr.total} passed (${rate}%)` +
      (curr.failed ? `, ${curr.failed} failed` : "") + (curr.skipped ? `, ${curr.skipped} skipped` : "");
    md.run.push(`- **AC suite ${curr.passed}/${curr.total} passed (${rate}%)**, ${curr.failed} failed` +
      (curr.skipped ? `, ${curr.skipped} skipped — a skipped AC is not a passing one` : "") +
      `. Source: \`${files[0].path}\`` +
      (ageDays > 0 ? ` — **${ageDays} day(s) old**; re-run the suite if anything shipped since.` : " (today)."));
    if (ageDays > 0) term.run.push(`Suite ran ${ageDays} day(s) ago (${files[0].date}) — re-run if anything shipped since.`);

    const { byFeature, ungrouped } = acLib.groupByFeature(curr.cases, featureIds);
    const perSlice = order.filter((id) => SHIPPED.has(statusOf(id))).map((id) => {
      const agg = (byId.get(id)?.features || []).reduce((acc, f) => {
        const g = byFeature.get(f);
        if (g) { acc.passed += g.passed; acc.total += g.total; acc.seen = true; }
        return acc;
      }, { passed: 0, total: 0, seen: false });
      return agg.seen ? `${id} ${agg.passed}/${agg.total}` : `${id} —`;
    });
    if (perSlice.length) {
      md.run.push(`- Per shipped slice: ${perSlice.join(" · ")} ` +
        `(\`—\` means no test case in this run joined to any of that slice's features)`);
      term.run.push(`Per slice: ${perSlice.join(" · ")}`);
    }
    if (ungrouped.length) {
      md.run.push(`- ${ungrouped.length} test case(s) did not join to any feature id, so they are ` +
        `counted in the total but in no slice above (${ungrouped.slice(0, 3).map((c) => c.name).join(", ")}` +
        `${ungrouped.length > 3 ? ", …" : ""}). The join is by feature id appearing in the JUnit ` +
        `classname or test name; a missing row reads exactly like a feature with no tests, which is ` +
        `why this line exists.`);
      term.run.push(`${ungrouped.length} test case(s) joined to no feature — in the total, in no slice row.`);
    }

    const prev = files[1] ? acLib.readAcSuite(files[1].path) : null;
    const cmp = acLib.compareRuns(prev, curr);
    if (!cmp) {
      md.run.push(`- No previous AC run to compare against, so **regressions cannot be reported** — ` +
        `this is the first recorded run, or the earlier file is unreadable.`);
      term.run.push("No previous run to compare against — regressions could not be checked.");
    } else if (cmp.regressed.length) {
      md.run.push(`- **${cmp.regressed.length} regression(s) since \`${files[1].date}\`** — passing then, not passing now:`);
      for (const r of cmp.regressed) md.run.push(`  - ${r.name} (now ${r.now})`);
      term.run.push(`REGRESSED since ${files[1].date}: ${cmp.regressed.map((r) => r.name).join(" · ")}`);
    } else {
      md.run.push(`- No regressions since \`${files[1].date}\`: every test passing then is passing now.`);
      term.run.push(`No regressions since ${files[1].date}.`);
    }
    if (cmp?.recovered.length) md.run.push(`- ${cmp.recovered.length} test(s) recovered since \`${files[1].date}\`.`);
    if (cmp?.removed.length) {
      md.run.push(`- ${cmp.removed.length} test(s) present in \`${files[1].date}\` are absent now ` +
        `(${cmp.removed.slice(0, 3).join(", ")}${cmp.removed.length > 3 ? ", …" : ""}) — a rename or a ` +
        `deletion, not counted as a regression either way. Worth a look if you did neither.`);
      term.run.push(`${cmp.removed.length} test(s) present on ${files[1].date} are gone — rename, or deletion?`);
    }
    // Failures already named as regressions are not repeated — listing the same test twice
    // under two headings is how a reader learns to skim past both. What is worth separating is
    // the failure that is NOT a regression: it was already failing last run, so nobody is going
    // to notice it from a delta, and it has now survived a whole slice.
    const standing = curr.failures.filter((f) => !cmp?.regressed.some((r) => r.name === f.name));
    if (standing.length) {
      md.run.push(cmp
        ? `- Also failing, and already failing on \`${files[1].date}\` — no delta will surface these again:`
        : `- Failing now:`);
      for (const f of standing) md.run.push(`  - ${f.name}`);
      term.run.push(`${cmp ? "Still failing" : "Failing"}: ${standing.map((f) => f.name).join(" · ")}`);
    }
  }
}

// --- 2. what shipped -----------------------------------------------------
const featureName = new Map(matrix.filter((f) => f?.id).map((f) => [f.id, f.name || ""]));
const sliceFeatures = slice.features || [];
const unrecorded = sliceFeatures.filter((id) => !featureProgress[id]);
md.shipped = sliceFeatures.map((id) =>
  `- ${id} ${featureName.get(id) || "(not in matrix/features.yaml)"} — **${featureProgress[id] || "no progress entry"}**` +
  (featureProgress[id] ? "" : " *(falls back to the gate-1 mining status, which is about the REFERENCE)*"));

// --- 3. standing ---------------------------------------------------------
//
// COVERAGE IS COUNTED FROM plan/progress.yaml ONLY, and that is the whole point of this block.
//
// parity.mjs computes coverage with matrix/features.yaml's `status:` filling every gap, because
// its job is a diff against the reference. But that field is GATE-1 MINING OUTPUT — how well the
// REFERENCE covered each feature — and it shares the words `covered`, `partial` and `missing`
// with this rebuild's progress vocabulary, so a matrix full of mined `covered` reads as a
// finished rebuild before a line of code exists. parity.mjs warns about that for features inside
// a shipped slice; features outside one are not covered by the warning at all.
//
// A standing report cannot inherit that ambiguity: "where do we stand" has one honest
// denominator. So only an explicit progress entry counts here, the number is labelled
// `recorded covered`, and the count of features with no entry is printed beside it so the gap
// between this figure and parity's is visible rather than surprising.
const recordedCovered = matrix.filter((f) => featureProgress[f?.id] === "covered").length;
const noEntry = matrix.filter((f) => !featureProgress[f?.id]).length;
const pct = matrix.length ? Math.round((recordedCovered / matrix.length) * 100) : 0;
const shippedSlices = order.filter((id) => SHIPPED.has(statusOf(id)));
const pos = order.indexOf(sliceId);
const pendingAfter = order.slice(pos + 1).filter((id) => !SHIPPED.has(statusOf(id)));
const next = pendingAfter[0];

// --- 4. pressure ---------------------------------------------------------
if (notes[sliceId]) {
  const note = String(notes[sliceId]).trim();
  press(`Recorded during this slice: ${note}`,
    `- **Recorded during this slice** (\`plan/progress.yaml\` \`notes:\`):\n  > ${note.replace(/\n/g, "\n  > ")}`);
}
if (sliceStatus === "deployed") {
  press(`Slice is \`deployed\`, not \`done\` — a done_means clause is knowingly unmet. Which one, and is it coming back?`,
    "- Slice is `deployed`, not `done` — a `done_means` clause is knowingly unmet. It still counts " +
    "as shipped for creep detection, which is what `deployed` is for; say here which clause and " +
    "whether it is coming back.");
}
if (seqLib) {
  const a = seqLib.analyse();
  const orderable = a.ready.filter((id) => id !== next);
  if (orderable.length) {
    press(`Orderable now (deps already shipped, scheduled later): ${orderable.map((id) => `${id} ${byId.get(id)?.name || ""}`.trim()).join(" · ")}`,
      `- **Orderable now** (dependencies already shipped, currently scheduled later): ` +
      `${orderable.map((id) => `${id} ${byId.get(id)?.name || ""}`.trim()).join(" · ")}. ` +
      `Moving one is \`npm run sequence -- reorder <Sn> --before ${next || "<Sm>"} --reason "..."\` — ` +
      `a logged decision, not a gate-2 reopen.`);
  }
  if (a.present && a.baseline.join(",") !== a.order.join(",")) {
    press(`Order has diverged from the gate-2 baseline — see ${seqLib.DECISION_LOG}`,
      `- Execution order has diverged from the gate-2 baseline.\n` +
      `  - Baseline: ${a.baseline.join(" → ")}\n  - Now: ${a.order.join(" → ")}\n` +
      `  - Every move and its reason: \`${seqLib.DECISION_LOG}\``);
  }
  if (a.stranded.length) {
    press(`⚠ ${a.stranded.join(", ")} still pending but positioned before shipped work`,
      `- ⚠ ${a.stranded.join(", ")} still pending but positioned before shipped work — the plan was ` +
      `overtaken in practice. Reorder into the tail, or record why they stay put.`);
  }
} else {
  press("scripts/sequence.mjs missing — roadmap position and reorder candidates not computed",
    "- `scripts/sequence.mjs` is missing, so roadmap position and reorder candidates were not " +
    "computed. Copy it from the plugin's `skills/rebuild-pipeline/scripts/`.");
}
const doneSliceFeatures = new Set(shippedSlices.flatMap((id) => byId.get(id)?.features || []));
const unrecordedGlobal = [...doneSliceFeatures].filter((id) => !featureProgress[id]);
if (unrecordedGlobal.length) {
  const sample = unrecordedGlobal.slice(0, 5).join(", ") + (unrecordedGlobal.length > 5 ? ", …" : "");
  press(`⚠ ${unrecordedGlobal.length} feature(s) in a shipped slice have no progress entry: ${sample}`,
    `- ⚠ **${unrecordedGlobal.length} feature(s) in a shipped slice have no \`plan/progress.yaml\` ` +
    `entry**, so they are not counted as covered above and parity.mjs falls back to their gate-1 ` +
    `mining status instead. Record them under \`features:\`: ${sample}`);
}
const parityReports = existsSync("parity")
  ? readdirSync("parity").filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse()
  : [];
press(parityReports.length
  ? `Creep, partial features and upstream candidates: see parity/${parityReports[0]}`
  : "No parity report on disk yet — creep and upstream candidates not looked at (npm run parity)",
  parityReports.length
    ? `- Scope creep, partial features and upstream candidates are not recomputed here — they are ` +
      `\`parity.mjs\`'s sections. Latest: \`parity/${parityReports[0]}\`.`
    : `- No parity report on disk yet (\`npm run parity\`), so creep and upstream candidates were ` +
      `not looked at for this boundary.`);

// --- write ---------------------------------------------------------------
const bar = (n, m) => { const w = 14, on = m ? Math.round((n / m) * w) : 0; return "█".repeat(on) + "░".repeat(w - on); };
mkdirSync(REVIEW_DIR, { recursive: true });
const path = join(REVIEW_DIR, `${sliceId}.md`);
writeFileSync(path, `# Slice review — ${sliceId} ${slice.name}

Generated ${date} by \`scripts/slice-review.mjs\` from \`plan/progress.yaml\`, \`${orderSource}\`,
\`matrix/features.yaml\` and the AC suite's JUnit output. Nothing here is composed; judgement
goes in the conversation on top of it.

**Advisory.** This locks nothing and blocks nothing. Slice boundaries are where the plan can
still change cheaply, which is the only reason to stop and look.

Status: **${sliceStatus}** · position ${pos + 1} of ${order.length} in the execution order.

> done_means: ${slice.done_means || "(not stated)"}

## 1. Does it run?

The cumulative question — not "did this slice's tests pass", which its deploy criterion already
asserted, but "is everything built so far still passing".

${md.run.join("\n")}

## 2. What shipped

${md.shipped.length ? md.shipped.join("\n") : "- this slice lists no features"}
${unrecorded.length ? `\n${unrecorded.length} of them have no \`plan/progress.yaml\` entry. Record them under \`features:\` — until then they count as uncovered here and fall back to mining status in the parity report.\n` : ""}${(slice.learning_goals || []).length ? `\nLearning goals: ${slice.learning_goals.join(" · ")}\n` : ""}
## 3. Where that puts us

\`\`\`
${bar(shippedSlices.length, order.length)}  ${shippedSlices.length} of ${order.length} slices shipped
${bar(recordedCovered, matrix.length)}  ${recordedCovered} of ${matrix.length} features recorded covered (${pct}%)
\`\`\`

Coverage here counts **only explicit \`plan/progress.yaml\` entries**${noEntry ? `; ${noEntry} of ${matrix.length} matrix features have none yet` : ""}.
\`parity.mjs\` reports a different figure over the same matrix because it fills gaps with
\`matrix/features.yaml\`'s \`status:\`, which is gate-1 mining output — how well the *reference*
covered each feature. Both are correct for their own question; this one is about the rebuild.

Order (${orderSource}):

${order.map((id) => `${id === sliceId ? "→" : " "} ${id} ${byId.get(id)?.name || ""} — ${statusOf(id)}`).join("\n")}

Next: **${next ? `${next} ${byId.get(next)?.name || ""}` : "nothing pending — every slice has shipped"}**

## 4. Pressure on the plan

${md.pressure.join("\n")}

## The decision

Accept this slice and start ${next || "GP"}, or name what has to come back first. Either way it
is yours — nothing here enforces it. If the plan should change, do it now, at the boundary:
slice *order* is \`npm run sequence -- reorder\` (logged, cheap); what is IN a slice is still a
gate-2 reopen (\`npm run gate -- reopen gate-2 --reason "..."\`).
`);

// --- terminal summary ----------------------------------------------------
// Rendered from the same collected facts as the markdown, not by pattern-matching it.
const INDENT = " ".repeat(12), WIDTH = 88;
const wrap = (s, first, cont = INDENT) => {
  const lines = []; let line = "";
  for (const w of String(s).split(/\s+/)) {
    if (line && (line + " " + w).length > WIDTH) { lines.push(line); line = ""; }
    line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? first + l : cont + l)).join("\n");
};
const head = `── SLICE REVIEW · ${sliceId} ${slice.name} `;
console.log(`\n${head}${"─".repeat(Math.max(3, 74 - head.length))}\n`);
console.log(wrap(runHeadline, "  Runs?     "));
for (const l of term.run) console.log(wrap(l, INDENT));
console.log(`\n  Shipped   ${sliceFeatures.length} feature(s) · slice is ${sliceStatus}`);
console.log(`\n  Standing  ${bar(shippedSlices.length, order.length)}  ${shippedSlices.length}/${order.length} slices shipped`);
console.log(`${INDENT}${bar(recordedCovered, matrix.length)}  ${recordedCovered}/${matrix.length} features recorded covered (${pct}%)`);
console.log(wrap(`Next: ${next ? `${next} ${byId.get(next)?.name || ""}` : "nothing pending"}`, INDENT));
if (pendingAfter.length > 1) console.log(wrap(`Then: ${pendingAfter.slice(1).join(" · ")}`, INDENT));
if (term.pressure.length) {
  console.log(`\n  Pressure`);
  for (const p of term.pressure) console.log(wrap(p, INDENT + "· ", INDENT + "  "));
}
console.log(`\nWrote ${path} — advisory; it locks nothing.`);
