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

import { readFileSync, existsSync, readdirSync } from "node:fs";
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
