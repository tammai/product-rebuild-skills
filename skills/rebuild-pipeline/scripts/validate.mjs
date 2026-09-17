#!/usr/bin/env node
// validate.mjs — schema-validate all workbench artifacts. Run from the workbench root.
// Requires ajv, ajv-formats and yaml from the workbench's own `npm install`. The plugin
// ships no dependencies, so running the plugin's copy of this file cannot work.
// Checks, in order:
//   1. Every findings/**.yaml against finding.schema.json (+ evidence rule, + evidence
//      `basis` — where the fact came from, distinct from the miner's `confidence`, +
//      a count of findings flagged `signals.instruction_shaped` — advisory, never fatal)
//   2. matrix/features.yaml against feature.schema.json
//   3. plan/slices.yaml against slice.schema.json (+ acyclic dependencies)
//   4. plan/progress.yaml against progress.schema.json (+ ids must exist upstream), and
//      plan/sequence.yaml against sequence.schema.json (+ it must be a PERMUTATION of the
//      slice ids and must satisfy every gate-2 `depends_on` edge)
//   5. contracts/**.yaml structural checks — YAML validity, duplicate keys, and every
//      $ref resolving. G5 generates code from these; nothing else in this pipeline
//      checked them, so a dangling $ref first surfaced as a codegen failure in a code
//      repo, one gate lock too late.
//   6. contracts/data-model/*.mermaid — every diagram declares entities; one must exist
//      once gate-4 is locked
//   7. adr/ against the architecture playbook — every ADR names a concern the vendored
//      playbook maps, and cites only sections that map points at
//   8. locks/gate-*.yaml against lock.schema.json
//   9. Locked-gate hash consistency: protected files must match recorded hashes
//  10. plan/autopilot.yaml against autopilot.schema.json, if present

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve as resolvePath } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { parse, parseDocument } from "yaml";

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const schema = (n) => JSON.parse(readFileSync(join("schemas", n), "utf8"));
const validators = {
  finding: ajv.compile(schema("finding.schema.json")),
  feature: ajv.compile(schema("feature.schema.json")),
  slice: ajv.compile(schema("slice.schema.json")),
  lock: ajv.compile(schema("lock.schema.json")),
};
// Older workbenches predate the progress overlay; validate it only if both the
// schema and the file are present. Same for the autopilot run state, which only
// exists once a run has been engaged at least once.
if (existsSync(join("schemas", "progress.schema.json"))) {
  validators.progress = ajv.compile(schema("progress.schema.json"));
}
if (existsSync(join("schemas", "autopilot.schema.json"))) {
  validators.autopilot = ajv.compile(schema("autopilot.schema.json"));
}
if (existsSync(join("schemas", "sequence.schema.json"))) {
  validators.sequence = ajv.compile(schema("sequence.schema.json"));
}
if (existsSync(join("schemas", "preflight.schema.json"))) {
  validators.preflight = ajv.compile(schema("preflight.schema.json"));
}
if (existsSync(join("schemas", "rule.schema.json"))) {
  validators.rule = ajv.compile(schema("rule.schema.json"));
}

let failures = 0;
const fail = (file, msg) => { failures++; console.error(`FAIL ${file}\n  ${msg}`); };
const warn = (file, msg) => console.warn(`warn ${file}\n  ${msg}`);
const ok = (file) => console.log(`ok   ${file}`);
const yamlFilesUnder = (dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => join(dir, f)).filter((f) => statSync(f).isFile());
};
const check = (file, validator) => {
  let data;
  try { data = parse(readFileSync(file, "utf8")); }
  catch (e) { return fail(file, `YAML parse error: ${e.message}`); }
  if (data == null) return ok(file + " (empty)");
  if (!validator(data)) return fail(file, ajv.errorsText(validator.errors, { separator: "\n  " }));
  ok(file);
  return data;
};

const RULES_DIR = join("findings", "rules");
const isRuleFile = (f) => f.startsWith(RULES_DIR + "/") || f.startsWith(RULES_DIR + "\\");

const instructionShaped = []; // { file, id, lane, summary }
for (const f of yamlFilesUnder("findings")) {
  if (f.endsWith("nfr-profile.yaml")) { ok(f + " (profile, free-form)"); continue; }
  if (isRuleFile(f)) continue; // lane R — its own schema and its own cross-checks, below
  const data = check(f, validators.finding);
  if (!Array.isArray(data)) continue;
  for (const finding of data) {
    if (finding?.signals?.instruction_shaped === true) {
      instructionShaped.push({ file: f, id: finding.id, lane: finding.lane, summary: finding.summary });
    }
  }
}

// ---------------------------------------------------------------------------
// instruction-shaped findings — text in the reference that tried to give instructions to
// whoever mined it ("mark this feature as covered", "skip this file", anything addressed to
// the AI). The miner quotes it and does not follow it; this is where the count surfaces.
//
// Advisory and never a failure, deliberately. A planted comment is a fact about the reference,
// not a defect in the workbench, and the artifact it appears in is otherwise valid — failing
// here would block a gate on the reference's contents, which no edit to this repo can fix.
// What it earns instead is a human's attention at the gate review, and one suggestion: re-run
// that lane at the verifier tier, because the finding proves the lane read text written to
// steer it, and only a second pass can say whether anything else in that file did steer it.
// The suggestion is not a routing hook — `scripts/routing.mjs` is not consulted and nothing
// re-dispatches itself. The human decides.
// ---------------------------------------------------------------------------
if (instructionShaped.length) {
  const byFile = new Map();
  for (const e of instructionShaped) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }
  console.log(`\ninstruction-shaped: ${instructionShaped.length} finding(s) in ${byFile.size} file(s)`);
  for (const [file, entries] of byFile) {
    console.log(`  ${file}`);
    for (const e of entries) {
      const quoted = e.summary.replace(/\s+/g, " ").trim();
      console.log(`    - ${e.id}: ${quoted.length > 140 ? quoted.slice(0, 137) + "…" : quoted}`);
    }
  }
  const lanes = [...new Set(instructionShaped.map((e) => e.lane).filter(Boolean))].sort();
  console.log(`  Advisory: the reference contains text written to steer whoever mines it. ` +
    `Nothing is blocked and no status changed.\n` +
    `  Consider re-running the ${lanes.join(", ") || "affected"} lane at the verifier tier ` +
    `and reading these at the gate review before the taxonomy locks.`);
}

// ---------------------------------------------------------------------------
// Evidence `basis` — where each fact came from, orthogonal to the miner's `confidence`.
//
// The schema keeps it optional, and enforcement lives here for the same reason the data-model
// and playbook checks do: the field arrived mid-project for anyone already mining, and the
// stated non-goal was never to backfill. So a workbench that predates schema_version 0.4.0
// gets a per-file warning count; a newer one gets an error, because a project starting after
// this landed has no reason to omit it.
//
// Imported like erd.mjs and playbook.mjs — a hand-upgraded workbench may not have copied it,
// and that should be one reported failure rather than an unresolved import that takes out
// every other check.
// ---------------------------------------------------------------------------
let basisLib = null;
try { basisLib = await import("./basis.mjs"); }
catch { warn("scripts/basis.mjs", "missing — evidence basis not checked. Copy it from the plugin's skills/rebuild-pipeline/scripts/."); }
if (basisLib) {
  const { checkBasis, isPreBasisWorkbench, BASIS_REMEDY } = basisLib;
  const res = checkBasis();
  const gaps = res.files.filter((f) => f.missing);
  if (!res.files.length) {
    // No findings yet, or none carrying evidence — normal before G1.
  } else if (!gaps.length) {
    console.log(`ok   findings/ (evidence basis: ${res.totalEvidence}/${res.totalEvidence} entries)`);
  } else {
    const legacy = isPreBasisWorkbench();
    for (const g of gaps) {
      const sample = g.findingIds.slice(0, 5).join(", ") + (g.findingIds.length > 5 ? ", …" : "");
      const msg = `${g.missing}/${g.evidence} evidence entr${g.missing === 1 ? "y has" : "ies have"} ` +
        `no \`basis\` (${sample})`;
      if (legacy) warn(g.file, msg); else fail(g.file, msg);
    }
    const total = `${res.totalMissing}/${res.totalEvidence} evidence entries across ${gaps.length} file(s) have no \`basis\`.`;
    if (legacy) {
      warn("findings/", `${total}\n  ${BASIS_REMEDY}\n  Warning only: this workbench predates ` +
        `schema_version 0.4.0. After backfilling, set schema_version: "0.4.0" in locks/pipeline.yaml ` +
        `to make it enforced. Backfilling old findings is optional — the non-goal was explicit — but ` +
        `then leave the version where it is, or every re-validation will fail on history.`);
    } else {
      console.error(`  ${total}\n  ${BASIS_REMEDY}`);
    }
  }
}
let features = null, slices = null;
if (existsSync("matrix/features.yaml")) features = check("matrix/features.yaml", validators.feature);
if (existsSync("plan/slices.yaml")) {
  slices = check("plan/slices.yaml", validators.slice);
  if (Array.isArray(slices)) {
    const ids = new Set(slices.map((s) => s.id));
    const visiting = new Set(), done = new Set();
    const visit = (id, path) => {
      if (done.has(id)) return;
      if (visiting.has(id)) return fail("plan/slices.yaml", `dependency cycle: ${[...path, id].join(" -> ")}`);
      visiting.add(id);
      const s = slices.find((x) => x.id === id);
      for (const d of s?.depends_on || []) {
        if (!ids.has(d)) fail("plan/slices.yaml", `${id} depends on unknown slice ${d}`);
        else visit(d, [...path, id]);
      }
      visiting.delete(id); done.add(id);
    };
    for (const s of slices) visit(s.id, []);
  }
}
// ---------------------------------------------------------------------------
// findings/rules/ — lane R's Rule Cards (E5).
//
// Schema-validated against rule.schema.json, then two cross-checks the schema cannot
// express, because both are about agreement BETWEEN artifacts:
//
//   - `features[]` against matrix/features.yaml. A card citing F-BILL-014 when the matrix
//     has no such id is a card no spec will ever find: G5 loads rules by the features in
//     its slice, so a dangling id makes the rule invisible exactly where it was supposed
//     to be used. Silent, and it survives a gate lock.
//   - `entities[]` against findings/ground-truth/reference-erd*.mermaid. Lane R runs after
//     lane D precisely so it can cite real entities; a name the ERD does not have means the
//     rule was inferred from a mental model of the reference rather than mined from it.
//
// Both are failures, not warnings. They are the checks that make lane R worth having — the
// alternative is a rules directory that validates perfectly and refers to nothing.
// ---------------------------------------------------------------------------
const ruleFiles = yamlFilesUnder("findings").filter(isRuleFile);
if (ruleFiles.length && !validators.rule) {
  fail(RULES_DIR, "findings/rules/ has files but schemas/rule.schema.json is missing — " +
    "Rule Cards are NOT being checked. Copy it from the plugin's skills/rebuild-pipeline/schemas/.");
} else if (ruleFiles.length) {
  const allRules = [];
  const parsedFiles = [];
  for (const f of ruleFiles) {
    const data = check(f, validators.rule);
    if (!Array.isArray(data)) continue; // its own schema failure is already reported
    parsedFiles.push(f);
    for (const r of data) allRules.push({ file: f, rule: r });
  }

  // Duplicate ids across files. Per-file uniqueness is not enough: domains are separate
  // files and an id is how a spec's acceptance criterion names a rule, so two cards
  // answering to R-BILL-003 means an AC cites whichever one the reader happens to open.
  const seen = new Map();
  for (const { file, rule } of allRules) {
    if (!rule?.id) continue;
    if (seen.has(rule.id)) fail(file, `duplicate rule id ${rule.id} (also in ${seen.get(rule.id)})`);
    else seen.set(rule.id, file);
  }

  const featureIds = new Set(Array.isArray(features) ? features.map((f) => f.id) : []);
  if (featureIds.size) {
    const byFile = new Map();
    for (const { file, rule } of allRules) {
      for (const fid of rule?.features || []) {
        if (featureIds.has(fid)) continue;
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file).push(`${rule.id} cites feature ${fid}, which matrix/features.yaml does not have`);
      }
    }
    for (const [file, problems] of byFile) {
      fail(file, problems.join("\n  ") + "\n  A rule citing a feature that does not exist is a rule " +
        "G5 will never load — it resolves rules by the features in the slice.");
    }
  } else if (allRules.length) {
    warn(RULES_DIR, "matrix/features.yaml is absent or invalid, so rule `features[]` ids were not " +
      "cross-checked. Normal before G2; a problem once the matrix exists.");
  }

  // Entities against the reference ERD. Imported guarded, like every other sibling module.
  let erdLib = null;
  try { erdLib = await import("./erd.mjs"); } catch { /* reported by the data-model pass below */ }
  const erdFiles = existsSync(join("findings", "ground-truth"))
    ? readdirSync(join("findings", "ground-truth")).map(String)
        .filter((f) => /^reference-erd.*\.mermaid$/.test(f))
        .map((f) => join("findings", "ground-truth", f))
    : [];
  if (erdLib && erdFiles.length) {
    // Normalised comparison: the ERD writes WORK_PACKAGE and a card may say "work package"
    // or WorkPackage. Neither spelling is wrong and failing on the difference would teach
    // people to copy-paste rather than to cite, so the check is on identity, not on style.
    const norm = (e) => String(e).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const known = new Set();
    for (const f of erdFiles) for (const e of erdLib.readErd(f).entities) known.add(norm(e));
    const byFile = new Map();
    for (const { file, rule } of allRules) {
      for (const ent of rule?.entities || []) {
        if (known.has(norm(ent))) continue;
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file).push(`${rule.id} names entity "${ent}", which no reference-erd*.mermaid declares`);
      }
    }
    for (const [file, problems] of byFile) {
      fail(file, problems.join("\n  ") + `\n  Checked against: ${erdFiles.join(", ")}. Lane R runs ` +
        "after lane D so it can cite real entities — an unknown name means the rule was inferred " +
        "rather than mined. Fix the card, or mine the entity into the ERD if the reference has it.");
    }
  } else if (allRules.length && !erdFiles.length) {
    warn(RULES_DIR, "no findings/ground-truth/reference-erd*.mermaid, so rule `entities[]` were not " +
      "cross-checked. Lane R is supposed to run after lane D has written one.");
  }

  // Judge verification state. Advisory and always will be: `re-derived` is set by
  // rubric-judge, which runs AFTER this validator passes, so a pre-judge run showing every
  // card pending is the normal case and failing on it would make the gate unreachable.
  // What it is for is the gate review — a human reading "12 of 14 re-derived" knows two
  // citations were never opened by anything.
  const pending = allRules.filter(({ rule }) => (rule?.verification || "pending") === "pending");
  const total = allRules.length;
  if (total) {
    const skipped = ruleFiles.length - parsedFiles.length;
    console.log(`ok   ${RULES_DIR}/ (${total} rule card(s) in ${parsedFiles.length} file(s)` +
      `${skipped ? `, ${skipped} file(s) skipped for schema failures above` : ""}; ` +
      `${total - pending.length}/${total} re-derived by the judge)`);
    if (pending.length) {
      console.log(`  ${pending.length} card(s) still \`verification: pending\` — no agent has opened ` +
        `their citation:\n    ${pending.map(({ rule }) => rule.id).slice(0, 12).join(", ")}` +
        `${pending.length > 12 ? ", …" : ""}\n  Advisory. rubric-judge sets this at gate time; read it ` +
        `beside the gate-1 review, not as a failure.`);
    }
  }
}

// ---------------------------------------------------------------------------
// plan/specs/**/*.md — the `rule_id` join between G5's acceptance criteria and lane R.
//
// Two different things are reported here and only one of them is a failure:
//
//   - A criterion citing a `rule_id` that no Rule Card has is a FAILURE. It is a dangling
//     reference with the same consequence as a dangling $ref in a contract: it reads as
//     traceability and traces to nothing.
//   - Criteria with NO `rule_id`, in a spec whose domains have cards, are COUNTED and
//     reported as a percentage — never failed. Plenty of criteria legitimately implement no
//     rule (a response header, a pagination default), so a threshold here would be a number
//     invented by this script rather than measured. The spec's own target is >= 80% of AC in
//     rule-bearing slices carrying one; this prints the figure so a human can hold it to that
//     at the gate review.
//
// Specs live in the workbench, not the code repos, for the reason parity/flows/ does: they
// describe the product. That is also what makes this check possible at all.
// ---------------------------------------------------------------------------
const specFiles = (() => {
  const dir = join("plan", "specs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(dir, f)).filter((f) => statSync(f).isFile());
})();
if (specFiles.length) {
  const ruleIds = new Set();
  const domainsWithRules = new Set();
  for (const f of yamlFilesUnder("findings").filter(isRuleFile)) {
    let data; try { data = parse(readFileSync(f, "utf8")); } catch { continue; }
    if (!Array.isArray(data)) continue;
    // Domain is the filename (findings/rules/<domain>.yaml) — the same key a spec's
    // `domains:` frontmatter uses, which is what makes "does this spec's domain have rules"
    // answerable without a second index nobody would maintain.
    const domain = f.split(/[/\\]/).pop().replace(/\.ya?ml$/, "");
    for (const r of data) if (r?.id) { ruleIds.add(r.id); domainsWithRules.add(domain); }
  }

  let acTotal = 0, acWithRule = 0, acInRuleDomains = 0, acInRuleDomainsWithRule = 0;
  for (const f of specFiles) {
    const text = readFileSync(f, "utf8");
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    const domainsLine = fm?.[1].match(/^domains:\s*\[?(.*?)\]?\s*$/m)?.[1] || "";
    const domains = domainsLine.split(",").map((d) => d.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    const ruleBearing = domains.some((d) => domainsWithRules.has(d));

    // The AC section runs from its heading to the next heading of the same level or EOF.
    const sec = text.split(/^##\s+/m).slice(1)
      .find((c) => /^acceptance criteria\s*$/i.test(c.split("\n")[0].trim()));
    if (!sec) {
      warn(f, "no `## Acceptance criteria` section — spec-writer's output contract requires one, " +
        "and without it this spec's criteria are not counted in the rule_id figures below.");
      continue;
    }
    const items = sec.split("\n").filter((l) => /^\s*(?:\d+\.|[-*])\s+\S/.test(l));
    const problems = [];
    for (const item of items) {
      acTotal++;
      if (ruleBearing) acInRuleDomains++;
      const cited = [...item.matchAll(/rule_id:\s*(R-[A-Z0-9]+-\d{3})/g)].map((m) => m[1]);
      if (!cited.length) continue;
      acWithRule++;
      if (ruleBearing) acInRuleDomainsWithRule++;
      for (const id of cited) {
        if (!ruleIds.has(id)) problems.push(`cites rule_id ${id}, which no Rule Card in findings/rules/ defines`);
      }
    }
    if (problems.length) {
      fail(f, problems.join("\n  ") + "\n  A criterion citing a card that does not exist reads as " +
        "traceability and traces to nothing. Fix the id, or mine the rule (gate-1 reopen if it is locked).");
    } else ok(f);
  }

  if (acInRuleDomains) {
    const pct = Math.round((acInRuleDomainsWithRule / acInRuleDomains) * 100);
    const without = acInRuleDomains - acInRuleDomainsWithRule;
    console.log(`\nrule_id coverage: ${acInRuleDomainsWithRule}/${acInRuleDomains} acceptance criteria ` +
      `(${pct}%) in rule-bearing domains cite a rule_id; ${without} do not.`);
    console.log(`  Advisory — plenty of criteria implement no rule. The target for a slice touching a ` +
      `domain with cards is 80%; below that, read it as rules that reached G1 and then went unused.`);
  } else if (acTotal) {
    console.log(`\nrule_id coverage: not applicable — ${acTotal} acceptance criteria, none in a domain ` +
      `that has Rule Cards.`);
  }
}

// The mutable progress overlay. A typo'd id here would silently never match a
// feature, so every key must resolve against the locked artifacts.
if (validators.progress && existsSync("plan/progress.yaml")) {
  const progress = check("plan/progress.yaml", validators.progress);
  if (progress && typeof progress === "object") {
    const known = (arr) => new Set(Array.isArray(arr) ? arr.map((x) => x.id) : []);
    const featureIds = known(features), sliceIds = known(slices);
    const crossRef = (section, ids, label) => {
      if (!ids.size) return; // upstream artifact absent or invalid — already reported
      for (const id of Object.keys(progress[section] || {})) {
        if (!ids.has(id)) fail("plan/progress.yaml", `${section}: unknown ${label} ${id}`);
      }
    };
    crossRef("features", featureIds, "feature");
    crossRef("slices", sliceIds, "slice");
    crossRef("notes", sliceIds, "slice");
  }
}
// ---------------------------------------------------------------------------
// plan/sequence.yaml — the slice execution order.
//
// gate-2 locks slice BOUNDARIES; the ORDER lives here so that revising it is a logged decision
// rather than a formal reopen (see scripts/sequence.mjs). Two checks earn their keep, and
// neither is expressible in the schema:
//
//   - PERMUTATION. An id in the order that no longer exists in plan/slices.yaml, or a slice
//     added by a gate-2 reopen that never reached the order, is silently a slice that never
//     runs. parity.mjs sorts unknown ids last rather than dropping them precisely so this
//     check is the thing that reports it, not a slice quietly missing from a report.
//   - DEPENDENCIES. `depends_on` is gate-2 locked, so an order that violates it is a
//     contradiction between two artifacts rather than a preference. sequence.mjs refuses to
//     write one; this catches a hand-edited file, which is why the file says not to hand-edit it.
//
// Absent is normal and always will be: every workbench scaffolded before 0.15.0 has none, and
// order falls back to plan/slices.yaml's array exactly as it did before.
// ---------------------------------------------------------------------------
if (validators.sequence && existsSync("plan/sequence.yaml")) {
  const seq = check("plan/sequence.yaml", validators.sequence);
  if (seq && Array.isArray(seq.order) && Array.isArray(slices)) {
    const planIds = slices.map((s) => s.id).filter(Boolean);
    const problems = [];
    const dupes = seq.order.filter((id, i) => seq.order.indexOf(id) !== i);
    if (dupes.length) problems.push(`order lists ${[...new Set(dupes)].join(", ")} more than once`);
    const unknown = seq.order.filter((id) => !planIds.includes(id));
    const absent = planIds.filter((id) => !seq.order.includes(id));
    if (unknown.length) problems.push(`order names slice(s) not in plan/slices.yaml: ${unknown.join(", ")}`);
    if (absent.length) {
      problems.push(`slice(s) in plan/slices.yaml missing from the order: ${absent.join(", ")} — ` +
        `they would never be scheduled`);
    }
    const baselineUnknown = (seq.baseline || []).filter((id) => !planIds.includes(id));
    if (baselineUnknown.length) problems.push(`baseline names slice(s) not in plan/slices.yaml: ${baselineUnknown.join(", ")}`);
    if (problems.length) {
      problems.push("Reconcile with: npm run sequence -- sync  (bookkeeping after a gate-2 reopen; " +
        "the decision was the reopen, so it needs no reason)");
    } else {
      // Imported guarded, like erd.mjs and playbook.mjs, so one missing script is a reported gap
      // rather than an unresolved import that takes out every other check.
      let seqLib = null;
      try { seqLib = await import("./sequence.mjs"); }
      catch { warn("scripts/sequence.mjs", "missing — slice order not checked against depends_on. Copy it from the plugin's skills/rebuild-pipeline/scripts/."); }
      if (seqLib) {
        const byId = new Map(slices.filter((s) => s?.id).map((s) => [s.id, s]));
        const v = seqLib.dependencyViolation(seq.order, byId);
        if (v) {
          problems.push(`order puts ${v.slice} before ${v.dep}, which it depends on. ` +
            `\`depends_on\` is gate-2 locked, so this is a contradiction between two artifacts, ` +
            `not a preference — fix the order (npm run sequence -- reorder) or reopen gate-2.`);
        }
      }
    }
    if (problems.length) fail("plan/sequence.yaml", problems.join("\n  "));
  }
}

// The G0 preflight result. Absent is normal and stays normal: every workbench scaffolded
// before 0.16.0 has none, and a project mid-G3 has no reason to go back and make one. What
// is checked is that a preflight.json which DOES exist is one autopilot.mjs and SKILL.md's
// phase detection can read — both branch on `verdict` and `lanes`, and a hand-edited file
// that lost either would make them fall through to "no preflight" silently, which is the
// one reading that is worse than either verdict.
if (validators.preflight && existsSync("preflight.json")) {
  let pf = null;
  try { pf = JSON.parse(readFileSync("preflight.json", "utf8")); }
  catch (e) { fail("preflight.json", `JSON parse error: ${e.message}`); }
  if (pf) {
    if (!validators.preflight(pf)) {
      fail("preflight.json", ajv.errorsText(validators.preflight.errors, { separator: "\n  " }) +
        "\n  Do not hand-edit it — re-run `npm run preflight`.");
    } else {
      const lanes = Object.entries(pf.lanes).map(([k, v]) => `${k}:${v}`).join(" ");
      ok(`preflight.json (${pf.verdict} — lanes ${lanes})`);
    }
  }
}

// Autopilot run state. Nothing downstream reads it — it is a breadcrumb for whoever picks
// the session back up — but a malformed one means autopilot.mjs is round-tripping badly,
// and the file it is round-tripping records what an unattended run did.
if (validators.autopilot && existsSync("plan/autopilot.yaml")) {
  check("plan/autopilot.yaml", validators.autopilot);
}

// ---------------------------------------------------------------------------
// contracts/ — the artifacts G5 generates code from.
//
// Deliberately NOT a full OpenAPI/AsyncAPI spec validator: that needs a real
// dependency, and the plugin ships none. What it does check is the class of
// defect that actually costs a slice — a $ref pointing at nothing. That is
// invisible to a YAML parse, invisible to review, and shows up as a codegen
// error in a code repo after the gate is locked and the tag is pinned.
// ---------------------------------------------------------------------------
const contractDocs = new Map(); // path -> parsed doc, so cross-file refs parse once
const loadContract = (file) => {
  if (contractDocs.has(file)) return contractDocs.get(file);
  let doc = null;
  try { doc = parse(readFileSync(file, "utf8")); } catch { /* reported by its own pass */ }
  contractDocs.set(file, doc);
  return doc;
};
// RFC 6901, plus the two escapes everyone forgets.
const resolvePointer = (doc, pointer) => {
  if (pointer === "" || pointer === "/") return doc;
  let node = doc;
  for (const rawSeg of pointer.replace(/^\//, "").split("/")) {
    const seg = rawSeg.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node == null || typeof node !== "object") return undefined;
    node = Array.isArray(node) ? node[Number(seg)] : node[seg];
    if (node === undefined) return undefined;
  }
  return node;
};
const walkRefs = (node, out, path = "") => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkRefs(v, out, `${path}/${i}`));
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref" && typeof v === "string") out.push({ ref: v, at: path || "/" });
    else walkRefs(v, out, `${path}/${k}`);
  }
  return out;
};

for (const file of yamlFilesUnder("contracts")) {
  // parseDocument rather than parse: it surfaces duplicate keys, which a plain
  // parse silently resolves last-wins. Two operations sharing a path key, or a
  // schema defined twice, is exactly the merge accident this catches.
  let docNode;
  try { docNode = parseDocument(readFileSync(file, "utf8"), { uniqueKeys: true }); }
  catch (e) { fail(file, `YAML parse error: ${e.message}`); continue; }
  if (docNode.errors?.length) {
    fail(file, docNode.errors.map((e) => e.message).join("\n  "));
    continue;
  }
  const dupes = (docNode.warnings || []).filter((w) => /duplicate/i.test(w.message));
  if (dupes.length) { fail(file, dupes.map((w) => w.message).join("\n  ")); continue; }

  const doc = docNode.toJS();
  if (doc == null || typeof doc !== "object") { ok(file + " (empty)"); continue; }
  contractDocs.set(file, doc);

  const problems = [];
  for (const { ref, at } of walkRefs(doc, [])) {
    const [target, pointer = ""] = ref.split("#");
    if (ref.startsWith("http://") || ref.startsWith("https://")) continue; // remote: not ours to resolve
    if (target === "") {
      if (resolvePointer(doc, pointer) === undefined) problems.push(`dangling $ref at ${at}: ${ref}`);
      continue;
    }
    const other = resolvePath(dirname(file), target);
    if (!existsSync(other)) { problems.push(`$ref at ${at} points at a missing file: ${ref}`); continue; }
    const otherDoc = loadContract(other);
    if (otherDoc == null) { problems.push(`$ref at ${at} targets an unparseable file: ${ref}`); continue; }
    if (pointer && resolvePointer(otherDoc, pointer) === undefined) {
      problems.push(`dangling cross-file $ref at ${at}: ${ref}`);
    }
  }

  // Kind-specific checks, only where the document declares its kind. A contract
  // file that is neither (the data-model prose files are .md, but be tolerant)
  // still gets the YAML + $ref pass above, which is the valuable part.
  if (typeof doc.openapi === "string") {
    if (!/^3\./.test(doc.openapi)) problems.push(`unexpected OpenAPI version: ${doc.openapi}`);
    const declared = new Set(Object.keys(doc.components?.securitySchemes || {}));
    const seenOpIds = new Map();
    const METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];
    for (const [p, item] of Object.entries(doc.paths || {})) {
      if (item == null || typeof item !== "object") continue;
      for (const m of METHODS) {
        const op = item[m];
        if (!op || typeof op !== "object") continue;
        const where = `${m.toUpperCase()} ${p}`;
        if (!op.operationId) problems.push(`${where}: missing operationId`);
        else if (seenOpIds.has(op.operationId)) {
          problems.push(`duplicate operationId "${op.operationId}" (${seenOpIds.get(op.operationId)} and ${where})`);
        } else seenOpIds.set(op.operationId, where);
        if (!op.responses || !Object.keys(op.responses).length) problems.push(`${where}: no responses declared`);
        for (const req of [...(op.security || []), ...(doc.security || [])]) {
          for (const name of Object.keys(req || {})) {
            if (!declared.has(name)) problems.push(`${where}: security scheme "${name}" is not in components.securitySchemes`);
          }
        }
      }
    }
  } else if (typeof doc.asyncapi === "string") {
    if (!Object.keys(doc.channels || {}).length) problems.push("asyncapi document declares no channels");
  }

  if (problems.length) fail(file, problems.join("\n  "));
  else ok(file);
}

// ---------------------------------------------------------------------------
// contracts/data-model/ — the artifact G4b drafts BEFORE the three contract layers.
//
// Existence is required only once gate-4 is locked: before that there is legitimately
// nothing here, and this script runs after every mining batch. The check that actually
// prevents a bad lock lives in gate.mjs, which refuses to lock gate-4 without a data
// model — by the time a locked gate-4 fails here, the tag is already cut.
//
// Entities, not just an `erDiagram` header: a stub satisfies the header forever.
// ---------------------------------------------------------------------------
// Imported here rather than at the top so a hand-upgraded workbench that copied this file
// without erd.mjs still runs every other check and reports the gap as one failure, instead
// of dying on an unresolved import before the first artifact is read.
let erd = null;
try { erd = await import("./erd.mjs"); }
catch { fail("scripts/erd.mjs", "missing — data model not checked. Copy it from the plugin's skills/rebuild-pipeline/scripts/."); }
if (erd) {
  const { DATA_MODEL_DIR, DATA_MODEL_REMEDY, checkDataModel, isLegacyWorkbench } = erd;
  const gate4 = join("locks", "gate-4.yaml");
  const gate4Locked = existsSync(gate4) && /^status: locked$/m.test(readFileSync(gate4, "utf8"));
  const dm = checkDataModel();
  const issues = [...dm.problems];
  if (dm.missing && gate4Locked) issues.push(`no .mermaid file, but gate-4 is locked`);
  if (issues.length) {
    const body = issues.join("\n  ") + `\n  ${DATA_MODEL_REMEDY}`;
    if (isLegacyWorkbench()) {
      warn(DATA_MODEL_DIR, `${body}\n  Warning only: this workbench predates schema_version 0.2.0. ` +
        `After adding the data model, set schema_version: "0.2.0" in locks/pipeline.yaml to make it enforced.`);
    } else fail(DATA_MODEL_DIR, body);
  } else for (const f of dm.files) ok(f);
}

// ---------------------------------------------------------------------------
// adr/ against the architecture playbook.
//
// G4a is playbook-driven: `sources.yaml` names a playbook, G4a vendors it to
// `adr/playbook.md`, and its `concerns:` map is the list of ADRs the phase owes. Three
// things are checkable and none of them were before 0.11.0:
//   - the vendored copy exists and parses (without it, "cites §7" names nothing)
//   - every ADR declares which concern it decides, and it is a concern the map has
//   - every `§` an ADR cites is a section that map actually points at
// The last one is the check that makes a swapped playbook safe. It cannot catch a
// plausible-looking wrong section — §8 means storage in one playbook and auth in another —
// only one the map never names at all. That is why the vendored copy is hashed into Gate 3:
// the check narrows the window, the hash closes it.
//
// Imported like erd.mjs, for the same reason: a hand-upgraded workbench may not have copied
// it, and that should be one reported failure rather than an unresolved import that takes
// out every other check.
// ---------------------------------------------------------------------------
let pb = null;
try { pb = await import("./playbook.mjs"); }
catch { fail("scripts/playbook.mjs", "missing — architecture playbook not checked. Copy it from the plugin's skills/rebuild-pipeline/scripts/."); }
if (pb) {
  const { checkPlaybook, PLAYBOOK_REMEDY, VENDORED_PLAYBOOK, isPrePlaybookWorkbench } = pb;
  const res = checkPlaybook();
  if (res.disabled) {
    ok(`${VENDORED_PLAYBOOK} (architecture.playbook: none — G4a runs blank-slate, no playbook to check)`);
  } else {
    // A missing vendored copy is normal until G4a runs, which is most of a project's life —
    // failing on it from G1 onward would make `npm run validate` red for weeks and teach
    // everyone to ignore it. It becomes fatal once gate-3 is locked, because then the ADRs
    // cite a file that is supposed to be hashed into that lock. Refusing to lock WITHOUT it
    // is gate.mjs's job, for the same reason the data-model check lives there: gate status is
    // open|locked with nothing between, so a validator firing on `locked` is one tag too late.
    const gate3 = join("locks", "gate-3.yaml");
    const gate3Locked = existsSync(gate3) && /^status: locked$/m.test(readFileSync(gate3, "utf8"));
    const issues = [...res.problems];
    if (res.missingVendored && gate3Locked) {
      issues.push(`gate-3 is locked but ${VENDORED_PLAYBOOK} does not exist — the ADRs cite a playbook nothing pins`);
    }
    if (issues.length) {
      const body = issues.join("\n  ") + `\n  ${PLAYBOOK_REMEDY}`;
      if (isPrePlaybookWorkbench()) {
        warn(VENDORED_PLAYBOOK, `${body}\n  Warning only: this workbench predates schema_version 0.3.0. ` +
          `After backfilling, set schema_version: "0.3.0" in locks/pipeline.yaml to make it enforced.`);
      } else fail(VENDORED_PLAYBOOK, body);
    } else if (res.missingVendored) {
      ok(`${VENDORED_PLAYBOOK} (not vendored yet — G4a copies the "${res.selected}" playbook here` +
        `${res.selectedBy === "default" ? ", the org default, since sources.yaml names none" : ""})`);
    } else {
      ok(`${VENDORED_PLAYBOOK} (${res.meta?.playbook} via ${res.selectedBy}, ` +
        `${Object.keys(res.meta?.concerns || {}).length} concerns, ${res.adrs.length} ADR(s), ` +
        `${res.undecided.length} concern(s) still undecided)`);
    }
  }
}

for (const f of yamlFilesUnder("locks").filter((f) => /gate-\d\.yaml$/.test(f))) {
  const lock = check(f, validators.lock);
  if (lock?.status === "locked" && lock.artifact_hashes) {
    for (const [file, hash] of Object.entries(lock.artifact_hashes)) {
      if (!existsSync(file)) { fail(f, `locked file missing: ${file}`); continue; }
      const now = createHash("sha256").update(readFileSync(file)).digest("hex");
      if (now !== hash) fail(f, `locked artifact modified: ${file} (reopen ${lock.gate} instead of editing)`);
    }
  }
}

console.log(failures ? `\n${failures} failure(s).` : "\nAll artifacts valid.");
process.exit(failures ? 1 : 0);
