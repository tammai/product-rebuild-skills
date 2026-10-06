#!/usr/bin/env node
// acsuite.mjs — read the AC suite's own JUnit output. Imported by parity.mjs,
// slice-review.mjs, equiv.mjs and lanes-check.mjs; runs nothing on its own.
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

// CRLF to LF on every text read. With git's core.autocrlf=true (the Windows default) the working
// copy is CRLF, and a pattern with a literal `\n` (`^slices:\n`, `^---\n`) silently matches
// nothing — read as "no such block" rather than an error. Same helper in every script that
// parses text; copied, not imported, because each is vendored and must run alone. See
// playbook.mjs's readText for the incident.
const readText = (p) => readFileSync(p, "utf8").replace(/\r\n?/g, "\n");

/**
 * Today on the LOCAL calendar, as YYYY-MM-DD — the date every dated file in parity/ is named by.
 *
 * It used to be `new Date().toISOString().slice(0, 10)`, which is the UTC date, while the lanes
 * name their JUnit files by the local one. East of UTC those disagree every local morning: at
 * 04:00 in UTC+7 a parity run overwrote the previous day's committed report, and slice-review
 * read the previous slice's JUnit as "today". A date that names or looks up a file uses this;
 * log timestamps stay UTC instants, because they name nothing.
 */
export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const acJunitPath = (date, root = ".") => join(root, "parity", `${date}-ac.xml`);

/**
 * The rerun of the joint run's failures (g5-build.md, "Test cadence within a slice"), and the
 * run records both runs leave beside their JUnit. `acJunitFiles` below matches `-ac.xml$` only,
 * so a rerun file is never mistaken for a joint run — keep it that way.
 */
export const acRerunPath = (date, root = ".") => join(root, "parity", `${date}-ac-rerun.xml`);
export const runMetaPath = (date, { rerun = false } = {}, root = ".") =>
  join(root, "parity", `${date}-ac${rerun ? "-rerun" : ""}.meta.json`);

/**
 * Read a run record: `{ started, repos: { <name>: { path, sha, dirty } } }`, written by
 * `lanes-check.mjs stamp` right before the run starts. JUnit has no standard field for the
 * commit it ran against, which is the one fact needed to say what a rerun pass means.
 * Returns null when absent and { unreadable } when present but not usable — never a guess.
 */
export const readRunMeta = (path) => {
  if (!existsSync(path)) return null;
  try {
    const m = JSON.parse(readFileSync(path, "utf8"));
    if (!m || typeof m.repos !== "object") return { unreadable: "no `repos` object" };
    return m;
  } catch (e) { return { unreadable: e.message }; }
};

/**
 * The joint run plus its rerun, counted once — the ONE place a pass rate is decided, so
 * parity.mjs and slice-review.mjs cannot state two different numbers for the same slice.
 *
 * A criterion counts as PASS if it passed in the joint run, or failed there and passed in the
 * rerun. But a green rerun means one of two different things, and they are never reported as one:
 *
 *   - "flaky"        the same commits ran both times. The test failed and then passed on the same
 *                    code; that is a finding about the test, not a pass to be banked quietly.
 *   - "code-changed" commits landed between the runs. Only the failed specs re-ran against the new
 *                    code, so nothing checked what the fix did to the tests that passed earlier.
 *   - "unverified"   a run record is missing or unreadable, or a tree was dirty when it was
 *                    stamped, so which code ran cannot be said. Never silently a PASS.
 *
 * Without a rerun this returns the joint run's own numbers, so callers need no second path.
 */
export const countWithRerun = (joint, rerun = null, jointMeta = null, rerunMeta = null) => {
  if (!joint || joint.unreadable) return null;
  const base = {
    total: joint.total, passed: joint.passed, failed: joint.failed, skipped: joint.skipped,
    stillFailing: joint.failures.map((c) => c.name), rerunPasses: [], notRerun: [], extra: [],
    changed: [], rerun: null, cases: joint.cases,
  };
  if (!rerun) return base;
  if (rerun.unreadable) return { ...base, rerun: { unreadable: rerun.unreadable } };

  const failedNames = new Set(joint.failures.map((c) => c.name));
  const rerunState = new Map(rerun.cases.map((c) => [c.name, c.state]));

  // Which code each run saw. Any difference, dirt, or missing record decides the label for
  // every rerun pass at once: the two runs are one comparison, not one per test.
  let label = "flaky";
  const changed = [];
  const usable = (m) => m && !m.unreadable;
  if (!usable(jointMeta) || !usable(rerunMeta)) label = "unverified";
  else {
    const names = new Set([...Object.keys(jointMeta.repos), ...Object.keys(rerunMeta.repos)]);
    for (const n of names) {
      const a = jointMeta.repos[n], b = rerunMeta.repos[n];
      if (!a || !b || a.dirty || b.dirty) { label = "unverified"; continue; }
      if (a.sha !== b.sha) changed.push({ repo: n, path: b.path || a.path, from: a.sha, to: b.sha });
    }
    if (label !== "unverified" && changed.length) label = "code-changed";
  }

  const rerunPasses = [], stillFailing = [], notRerun = [];
  for (const name of failedNames) {
    const st = rerunState.get(name);
    if (st === undefined) notRerun.push(name);
    else if (st === "passed") rerunPasses.push({ name, label });
    else stillFailing.push(name);
  }
  const extra = rerun.cases.filter((c) => !failedNames.has(c.name)).map((c) => c.name);
  // The joint run's cases with rerun passes applied — what per-rule and per-feature tables group
  // on, so a rule is not reported red in one table and counted green in the headline above it.
  const passedOnRerun = new Set(rerunPasses.map((p) => p.name));
  const cases = joint.cases.map((c) => (passedOnRerun.has(c.name) ? { ...c, state: "passed", onRerun: label } : c));
  return {
    ...base,
    passed: joint.passed + rerunPasses.length,
    failed: joint.failed - rerunPasses.length,
    stillFailing: [...stillFailing, ...notRerun],
    rerunPasses, notRerun, extra, changed, label, cases,
    rerun: { path: rerun.path, total: rerun.total },
  };
};

const RERUN_MEANING = {
  "flaky": "the same commits ran both times — each of these failed and then passed on the same " +
    "code. That is a flaky acceptance test, and it goes into plan/progress.yaml `notes:` on the slice.",
  "code-changed": "commits landed between the runs, and only the failed specs re-ran against " +
    "them. The joint run's other passes predate those commits; nothing has checked what the fix " +
    "did to them.",
  "unverified": "a run record is missing or unreadable, or a tree was dirty when it was stamped, " +
    "so which code each run saw cannot be said. `node scripts/lanes-check.mjs stamp` before the " +
    "joint run (`stamp --rerun` before the rerun) records it.",
};

/**
 * The headline and the rerun block, as markdown lines — shared so both reports say the same
 * thing in the same words. The joint run's own totals always appear; the rerun sits beside them
 * and never replaces them.
 */
export const describeCounted = (c, jointPath) => {
  const rate = c.total ? Math.round((c.passed / c.total) * 100) : 0;
  const flaky = c.rerunPasses.length && c.label === "flaky" ? `, ${c.rerunPasses.length} of them flaky` : "";
  const skips = describeSkips(c.cases);
  const headline = `${c.passed}/${c.total} passed (${rate}%)${flaky}` +
    (c.failed ? `, ${c.failed} failed` : "") + (c.skipped ? `, ${c.skipped} skipped` : "") +
    (skips.notGreen ? " — NOT GREEN (skips)" : "");
  const lines = [];
  if (!c.rerun) return { headline, lines: skips.lines, notGreen: skips.notGreen };
  if (c.rerun.unreadable) {
    lines.push(`- A rerun file exists but could not be read as JUnit (${c.rerun.unreadable}). ` +
      `The joint run's numbers stand alone; no failure counts as re-run.`);
    return { headline, lines: [...lines, ...skips.lines], notGreen: skips.notGreen };
  }
  const jointPassed = c.passed - c.rerunPasses.length;
  lines.push(`- **Rerun of the joint run's failures.** Joint run: ${jointPassed}/${c.total} passed ` +
    `(\`${jointPath}\`); rerun: ${c.rerun.total} test(s) (\`${c.rerun.path}\`).`);
  if (c.rerunPasses.length) {
    lines.push(`  - **Passed on rerun — ${c.label}** (${c.rerunPasses.length}): ${RERUN_MEANING[c.label]}`);
    for (const p of c.rerunPasses) lines.push(`    - ${p.name}`);
    if (c.label === "code-changed") {
      for (const ch of c.changed) lines.push(`    - ${ch.repo}: \`${ch.from.slice(0, 12)}..${ch.to.slice(0, 12)}\``);
    }
  }
  if (c.stillFailing.length - c.notRerun.length > 0) {
    lines.push(`  - Still failing after the rerun: ${c.stillFailing.filter((n) => !c.notRerun.includes(n)).join(" · ")}`);
  }
  if (c.notRerun.length) lines.push(`  - Failed in the joint run and not re-run: ${c.notRerun.join(" · ")}`);
  if (c.extra.length) {
    lines.push(`  - ⚠️ The rerun contains ${c.extra.length} test(s) that did not fail in the joint run ` +
      `(${c.extra.slice(0, 3).join(", ")}${c.extra.length > 3 ? ", …" : ""}). They change no count here; ` +
      `a rerun re-runs only the failures.`);
  }
  return { headline, lines: [...lines, ...skips.lines], notGreen: skips.notGreen };
};

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

// Why a case was skipped: the <skipped message="..."> attribute, else the element's text. Go's
// junit reporters, Jest and Playwright each use one or the other.
const unescapeXml = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");
const skipReason = (body) => {
  const m = /<skipped\b([^>]*?)(\/>|>([\s\S]*?)<\/skipped>)/.exec(body);
  const attr = m && (/\bmessage="([^"]*)"/.exec(m[1]) || [])[1];
  const text = (attr || m?.[3] || "").replace(/<!\[CDATA\[|\]\]>/g, "").trim().split("\n")[0].trim();
  return text ? unescapeXml(text).slice(0, 200) : "(no reason given)";
};

/**
 * When a run with skips is still not green — the joint-run rule in g5-build.md: green means no
 * failures, no errors, skips within SKIP_BOUND, and no skip caused by an unset environment
 * variable.
 *
 * A joint run once reported 0 failures with 670 of 1209 tests skipped, because the integration
 * database settings never reached the test processes. Each report already said "a skipped AC is
 * not a passing one", and the run still read as green, because nothing said it was not.
 *
 * SKIP_BOUND is 10%: the AC suite has one test per criterion, so a legitimate skip (a test for a
 * platform this machine is not) is rare, and a broken environment skips whole packages at once.
 * An env-var skip is never legitimate in the joint run, whatever the ratio: the criterion was not
 * tested, and the fix is the run's environment, not the test.
 */
export const SKIP_BOUND = 0.1;
const ENV_SKIP = /\b(env(ironment)?\s+var(iable)?s?|env\s+not\s+set)\b|process\.env\.|os\.Getenv|\$\{?[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bset\s+[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b[^.]*\b(not\s+set|unset|empty|missing|undefined|required)\b|\b(not\s+set|unset|missing|requires?)\b[^.]*\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/i;
export const isEnvSkip = (reason) => ENV_SKIP.test(reason || "");
export const describeSkips = (cases) => {
  const skipped = (cases || []).filter((c) => c.state === "skipped");
  if (!skipped.length) return { notGreen: false, lines: [] };
  const ratio = skipped.length / cases.length;
  const env = skipped.filter((c) => isEnvSkip(c.reason));
  const lines = [];
  if (ratio > SKIP_BOUND) {
    lines.push(`- ⚠️ **NOT GREEN: ${skipped.length} of ${cases.length} tests skipped (${Math.round(ratio * 100)}%)**, ` +
      `above the ${SKIP_BOUND * 100}% bound. A run that skipped this much did not test what it reports on; ` +
      `find the shared cause below and run again.`);
  }
  if (env.length) {
    lines.push(`- ⚠️ **NOT GREEN: ${env.length} skipped because an environment variable was unset.** ` +
      `Those criteria were not tested and none counts as passed. Fix the run's environment ` +
      `(a \`NAME=value\` line in run-phases.mjs's phases.txt reaches every later phase) and run again.`);
  }
  const byReason = new Map();
  for (const c of skipped) byReason.set(c.reason, (byReason.get(c.reason) || 0) + 1);
  const top = [...byReason.entries()].sort((a, b) => b[1] - a[1]);
  lines.push(`- Skipped, by reason (${skipped.length}):`);
  for (const [reason, n] of top.slice(0, 8)) lines.push(`  - ${n} × ${reason}${isEnvSkip(reason) ? " — unset environment variable" : ""}`);
  if (top.length > 8) lines.push(`  - … and ${top.length - 8} more reason(s)`);
  return { notGreen: ratio > SKIP_BOUND || env.length > 0, lines };
};

/** Parse one JUnit file. Returns { unreadable } rather than throwing or zeroing. */
export const readAcSuite = (path) => {
  if (!existsSync(path)) return null;
  let xml;
  try { xml = readText(path); }
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
    return state === "skipped"
      ? { name, classname, caseName, state, reason: skipReason(body) }
      : { name, classname, caseName, state };
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
    try { data = parseYaml(readText(join(dir, f))); } catch { continue; }
    if (!Array.isArray(data)) continue;
    const domain = f.replace(/\.ya?ml$/, "");
    for (const r of data) if (r?.id) out.push({ id: r.id, domain, kind: r.kind, features: r.features || [] });
  }
  return out;
};
