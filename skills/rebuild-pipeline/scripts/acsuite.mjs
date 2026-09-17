#!/usr/bin/env node
// acsuite.mjs — read the AC suite's own JUnit output. Imported by parity.mjs and
// slice-review.mjs; runs nothing on its own.
//
// The rule this exists to serve is g5-build.md's: an artifact a human reads afterwards must
// name only what actually RAN. A transcribed pass rate is exactly the banner that survives
// after the run that produced it is forgotten, so both consumers read the XML rather than a
// summary — and anything unreadable is reported as unreadable, never counted as zero failures.
//
// Deliberately not an XML parser. The plugin ships no dependencies and the workbench's three
// are for schema validation; JUnit's shape is fixed enough that counting <testcase> elements
// and the ones carrying a <failure>/<error>/<skipped> child is reliable.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const acJunitPath = (date, root = ".") => join(root, "parity", `${date}-ac.xml`);

/**
 * Every AC JUnit file on disk, newest first, as { path, date }.
 *
 * parity.mjs reads TODAY's file only — its report is dated and must not borrow another day's
 * numbers. A slice review is written at a slice boundary, which is rarely the same day the
 * suite last ran, so it takes the newest and says how old it is. Two different correct answers
 * to "which run", which is why this returns the list rather than picking.
 */
export const acJunitFiles = (root = ".") => {
  const dir = join(root, "parity");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^(\d{4}-\d{2}-\d{2})-ac\.xml$/.exec(f))
    .filter(Boolean)
    .map((m) => ({ date: m[1], path: join(dir, m[0]) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
};

/**
 * Every EQUIVALENCE JUnit file on disk, newest first — `parity/<date>-equiv.xml`, written by
 * `equiv replay`.
 *
 * Same shape as acJunitFiles and read by the same readAcSuite, because it is the same format
 * answering a different question: the AC suite asks whether the rebuild does what the spec
 * says, the equivalence suite asks whether it produces what the OLD system produced. Keeping
 * one reader is what lets parity.mjs and slice-review.mjs treat them alike — a trace that
 * regressed since the last boundary is found by exactly the code that finds a regressed AC.
 */
export const equivJunitPath = (date, root = ".") => join(root, "parity", `${date}-equiv.xml`);
export const equivJunitFiles = (root = ".") => {
  const dir = join(root, "parity");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^(\d{4}-\d{2}-\d{2})-equiv\.xml$/.exec(f))
    .filter(Boolean)
    .map((m) => ({ date: m[1], path: join(dir, m[0]) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
};

/**
 * Traces on disk, per feature — what was RECORDED, as opposed to what was replayed.
 *
 * The two counts have to be separate and both have to be reported. A trace that exists and was
 * never replayed is not a pass and is not a failure; it is evidence nobody has checked, and it
 * is invisible in the JUnit precisely because the JUnit only contains what ran. "8 recorded, 6
 * replayed, 6 green" is the honest line; "6/6 green" over the same directory is not.
 */
export const readEquivTraces = (root = ".") => {
  const dir = join(root, "parity", "equiv");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const feature of readdirSync(dir)) {
    const fdir = join(dir, feature);
    let isDir = false;
    try { isDir = statSync(fdir).isDirectory(); } catch { /* not a directory */ }
    if (!isDir) continue;
    for (const f of readdirSync(fdir).filter((f) => f.endsWith(".trace.yaml"))) {
      out.push({ feature, name: f.replace(/\.trace\.yaml$/, ""), path: join(fdir, f) });
    }
  }
  return out.sort((a, b) => (a.feature + a.name).localeCompare(b.feature + b.name));
};

/** Parse one JUnit file. Returns { unreadable } rather than throwing or zeroing. */
export const readAcSuite = (path) => {
  if (!existsSync(path)) return null;
  let xml;
  try { xml = readFileSync(path, "utf8"); }
  catch (e) { return { unreadable: e.message }; }
  // Split on the opening tag so each chunk is one test case plus whatever it contained.
  const chunks = xml.split(/<testcase\b/).slice(1);
  if (!chunks.length) return { unreadable: "no <testcase> elements" };
  const cases = chunks.map((chunk) => {
    // Everything up to this case's end — self-closing, or the matching </testcase>.
    const end = chunk.indexOf("</testcase>");
    const body = end === -1 ? chunk.split(/<testcase\b/)[0] : chunk.slice(0, end);
    const attr = (n) => (body.match(new RegExp(`\\b${n}="([^"]*)"`)) || [])[1] || "";
    const classname = attr("classname"), caseName = attr("name");
    const name = [classname, caseName].filter(Boolean).join(" › ") || "(unnamed)";
    const state = /<skipped\b/.test(body) ? "skipped"
      : /<(failure|error)\b/.test(body) ? "failed" : "passed";
    return { name, classname, caseName, state };
  });
  const count = (st) => cases.filter((c) => c.state === st).length;
  return {
    path, total: cases.length, passed: count("passed"), failed: count("failed"),
    skipped: count("skipped"), cases, failures: cases.filter((c) => c.state === "failed"),
  };
};

/**
 * Group cases by feature id, best-effort, and say how much did not group.
 *
 * Maestro is run as `maestro test parity/flows`, and flows live at
 * parity/flows/<feature-id>/<criterion>.yaml — so the feature id is normally in the classname
 * or the path-shaped test name. "Normally" is doing real work in that sentence, which is why
 * `ungrouped` is returned and reported rather than dropped: a feature id that fails to match
 * would otherwise silently vanish from a per-slice breakdown, and a missing row reads exactly
 * like a feature with no tests.
 */
export const groupByFeature = (cases, featureIds) => {
  const ids = [...featureIds].sort((a, b) => b.length - a.length); // longest first: F-API-0011 before F-API-001
  const byFeature = new Map();
  const ungrouped = [];
  for (const c of cases) {
    const hay = `${c.classname} ${c.caseName} ${c.name}`;
    const hit = ids.find((id) => hay.includes(id));
    if (!hit) { ungrouped.push(c); continue; }
    if (!byFeature.has(hit)) byFeature.set(hit, { passed: 0, failed: 0, skipped: 0, total: 0 });
    const g = byFeature.get(hit);
    g[c.state]++; g.total++;
  }
  return { byFeature, ungrouped };
};

/**
 * What changed between two runs, by test name.
 *
 * This is the cumulative-regression signal nothing in the pipeline had. Every per-slice deploy
 * criterion asserts only that slice's own features, so "did S3 break S1" had no answer — the AC
 * pass rate is a single number and a number that moves does not say which way or which test.
 * Comparing by name against the previous run does, and both files are already on disk.
 *
 * Names that appear in only one run are reported as added/removed rather than as changes: a
 * renamed flow is not a regression, and counting it as one is how a report gets ignored.
 */
export const compareRuns = (prev, curr) => {
  if (!prev || prev.unreadable || !curr || curr.unreadable) return null;
  const state = (suite) => new Map(suite.cases.map((c) => [c.name, c.state]));
  const before = state(prev), after = state(curr);
  const regressed = [], recovered = [], added = [], removed = [];
  for (const [name, now] of after) {
    if (!before.has(name)) { added.push(name); continue; }
    const was = before.get(name);
    if (was === "passed" && now !== "passed") regressed.push({ name, now });
    else if (was !== "passed" && now === "passed") recovered.push(name);
  }
  for (const name of before.keys()) if (!after.has(name)) removed.push(name);
  return { regressed, recovered, added, removed };
};

/**
 * Group cases by Rule Card id, and say which rules no test named.
 *
 * The same best-effort join as groupByFeature, on a different key and for a different
 * question. A feature answers "is this thing built"; a rule answers "does it behave the way
 * the reference behaved" — which is the question parity could not previously ask, because
 * coverage counts features and a feature can be fully built, marked covered, and subtly
 * wrong: the total rounds before tax instead of after, the state machine allows a transition
 * the reference forbade.
 *
 * The join works because g5-build.md step 1 requires the rule id in the test NAME: an AC
 * carrying `rule_id: R-BILL-002` maps 1:1 to a test, and that test names the id. Nothing
 * enforces it at runtime — JUnit carries names, not metadata — so `untested` is returned
 * rather than inferred. A rule with no test and a rule whose test forgot to name it look
 * identical here, and calling both "untested" is the honest reading: in both cases nothing
 * on disk demonstrates the rule holds.
 *
 * `green` counts only rules where every test naming them passed. One failing test among four
 * makes the rule red, because a rule is one behavior — there is no partial credit for a
 * calculation that is right in three cases out of four.
 */
export const groupByRule = (cases, ruleIds) => {
  const ids = [...ruleIds].sort((a, b) => b.length - a.length); // longest first: R-API-0011 before R-API-001
  const byRule = new Map();
  for (const c of cases) {
    const hay = `${c.classname} ${c.caseName} ${c.name}`;
    for (const id of ids) {
      if (!hay.includes(id)) continue;
      if (!byRule.has(id)) byRule.set(id, { passed: 0, failed: 0, skipped: 0, total: 0, cases: [] });
      const g = byRule.get(id);
      g[c.state]++; g.total++; g.cases.push(c);
      break; // longest match wins; a test names one rule
    }
  }
  const untested = [...ruleIds].filter((id) => !byRule.has(id));
  const green = [...byRule.entries()].filter(([, g]) => g.total && g.passed === g.total).map(([id]) => id);
  const red = [...byRule.entries()].filter(([, g]) => g.failed > 0).map(([id]) => id);
  // A rule whose only tests were skipped is neither green nor red — a skipped AC is not a
  // passing one, and reporting it as red would blame the rule for a suite that did not run.
  const skippedOnly = [...byRule.entries()]
    .filter(([, g]) => g.total && !g.failed && g.passed === 0).map(([id]) => id);
  return { byRule, untested, green, red, skippedOnly };
};

/**
 * Every Rule Card id on disk, with its domain and kind. Zero rules = lane R never ran, which
 * is why parity.mjs renders no rules table at all rather than an empty one.
 *
 * Takes the YAML parser as an argument instead of importing it: this module is imported by
 * parity.mjs and slice-review.mjs, which already have the workbench's `yaml` dependency, and
 * staying dependency-free here keeps it importable from anywhere else that does not.
 */
export const readRuleCards = (root = ".", parseYaml) => {
  const dir = join(root, "findings", "rules");
  if (!existsSync(dir) || !parseYaml) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    let data;
    try { data = parseYaml(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    if (!Array.isArray(data)) continue;
    const domain = f.replace(/\.ya?ml$/, "");
    for (const r of data) if (r?.id) out.push({ id: r.id, domain, kind: r.kind, features: r.features || [] });
  }
  return out;
};
