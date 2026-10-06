#!/usr/bin/env node
// rules-recall.mjs — eval for E16: how much of a known rule set does lane R find?
//
//   node <plugin>/skills/rebuild-pipeline/eval/rules-recall.mjs findings/rules/billing.yaml
//   node <plugin>/skills/rebuild-pipeline/eval/rules-recall.mjs <cards.yaml> --record --model mid --note "baseline"
//   node <plugin>/skills/rebuild-pipeline/eval/rules-recall.mjs --self-test
//
// Lane R's precision is checked in every project: rubric-judge opens each transcribed citation
// and sets `verification: re-derived`. Its recall never was. The exit criterion in g1-mining.md
// counts routes that have *a* card, so a route with five rules and one card passes, and a brief
// change could halve what the miner finds without anything turning red. This scores a lane R
// output against fixtures/rules-recall/gold.yaml, a rule set written alongside its source, so
// "did the brief change help" becomes two numbers compared across releases.
//
// It is a script, not a rubric line, because the comparison has to be identical every time: a
// judge reading the cards would score this release's run by a different hand than the last.
// No model calls. Dispatching the miner is the manual half; see the fixture's README.md.
//
// It decides nothing. Exit 0 whatever the score, 1 only on bad input or a failed --self-test:
// a fixture is a measuring stick, and wiring a threshold into it would make the number the
// target rather than the reading.
//
// Run it from inside a workbench (after `npm install`): it borrows the workbench's `yaml`
// dependency rather than shipping its own, the same way validate.mjs does.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const OPTS_WITH_VALUE = new Set(["--fixture", "--model", "--note"]);
const files = args.filter((a, i) => !a.startsWith("--") && !OPTS_WITH_VALUE.has(args[i - 1]));

// The plugin repo has no node_modules; a workbench does. Fails loudly when neither resolves,
// because a scorer that silently scored nothing would read as a recall of zero.
const loadYaml = async () => {
  try { return (await import("yaml")).parse; } catch { /* fall through to the cwd */ }
  try { return createRequire(join(process.cwd(), "package.json"))("yaml").parse; } catch { /* below */ }
  console.error("rules-recall: cannot load the `yaml` package. Run from inside a workbench after " +
    "`npm install` — the scorer borrows its dependency.");
  process.exit(1);
};

// The LOCAL date, like every dated file in eval/runs and parity/ — see localDate() in
// scripts/acsuite.mjs. Copied, not imported: the eval must run from a workbench whose vendored
// acsuite may be older. If you change one, change both.
const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// A miner may cite `reference-src/app/x.rb`, `./app/x.rb`, or a path from wherever it mounted
// the source. The gold path is relative to reference-src/, so compare on the suffix rather than
// fail a correct citation on where the miner happened to stand.
const normPath = (p) => {
  const s = String(p).replace(/\\/g, "/");
  const cut = s.lastIndexOf("reference-src/");
  return (cut >= 0 ? s.slice(cut + "reference-src/".length) : s).replace(/^\.?\//, "");
};
const samePath = (cardPath, goldPath) => {
  const c = normPath(cardPath);
  return c === goldPath || c.endsWith(`/${goldPath}`);
};

const textOf = (card) => [card.given, card.when, card.then].filter(Boolean).join(" \n ").toLowerCase();
const missingValues = (card, rule) =>
  (rule.values || []).filter((group) => !group.some((alt) => textOf(card).includes(String(alt).toLowerCase())));

/**
 * Score cards against gold. Pure, so --self-test exercises exactly what a real run does.
 *
 * Located: one evidence entry with a `line` falls inside one of a rule's locations. Only entries
 * with a line count — a file-level citation could be anything in the file, and crediting it
 * would reward the summarising that rule.schema.json's `line` requirement exists to stop.
 * Matched: located AND the card's kind is one of the rule's kinds. A located card with the wrong
 * kind is a near miss: the miner found the code but filed the rule under a different meaning,
 * which is a different failure from not finding it and gets its own list.
 */
export const score = (gold, cards) => {
  const rules = gold.rules;
  const byRule = new Map(rules.map((r) => [r.id, { rule: r, cards: [] }]));
  const unmatched = [], nearMisses = [], alsoLocated = [];
  let matchedCards = 0;

  for (const card of cards) {
    const lines = (card.evidence || []).filter((e) => e?.path && Number.isInteger(e.line));
    const located = rules.filter((r) => r.locations.some((loc) =>
      lines.some((e) => samePath(e.path, loc.path) && e.line >= loc.lines[0] && e.line <= loc.lines[1])));
    if (!located.length) { unmatched.push(card); continue; }
    const kindOk = located.filter((r) => r.kinds.includes(card.kind));
    if (!kindOk.length) {
      nearMisses.push({ card, rules: located.map((r) => r.id), expected: [...new Set(located.flatMap((r) => r.kinds))] });
      continue;
    }
    // A card located on several rules counts for ONE, and the rest are listed, not credited:
    // one card standing for two rules is usually two rules folded into one. Which one is decided
    // by the card's own text — the rule whose values it names most — then by a rule no card has
    // claimed yet, then by gold order. Gold order alone credited two cards citing the same line
    // (one about the currency default, one about the starting status) to the same rule, and
    // scored the rule the second card described as missed.
    const named = (r) => (r.values || []).length - missingValues(card, r).length;
    const pick = [...kindOk].sort((a, b) =>
      named(b) - named(a) ||
      (byRule.get(a.id).cards.length ? 1 : 0) - (byRule.get(b.id).cards.length ? 1 : 0) ||
      rules.indexOf(a) - rules.indexOf(b))[0];
    matchedCards++;
    byRule.get(pick.id).cards.push(card);
    if (kindOk.length > 1) alsoLocated.push({ card, rules: kindOk.filter((r) => r !== pick).map((r) => r.id) });
  }

  const results = rules.map((r) => {
    const { cards: hits } = byRule.get(r.id);
    const strictHit = hits.find((c) => !missingValues(c, r).length);
    return {
      id: r.id, kind: r.kinds[0], path_kind: r.path_kind, hard: r.hard, rule: r.rule,
      matched: hits.map((c) => c.id),
      strict: Boolean(strictHit),
      missing_values: hits.length && !strictHit ? missingValues(hits[0], r).map((g) => g[0]) : [],
    };
  });

  const ratio = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);
  const slice = (key) => Object.fromEntries([...new Set(results.map((x) => x[key]))].map((k) => {
    const group = results.filter((x) => x[key] === k);
    return [k, { total: group.length, matched: group.filter((x) => x.matched.length).length,
      recall: ratio(group.filter((x) => x.matched.length).length, group.length) }];
  }));

  const found = results.filter((x) => x.matched.length).length;
  return {
    metrics: {
      gold: rules.length,
      cards: cards.length,
      recall: ratio(found, rules.length),
      strict_recall: ratio(results.filter((x) => x.strict).length, rules.length),
      precision: ratio(matchedCards, cards.length),
      near_misses: nearMisses.length,
      unmatched: unmatched.length,
      by_kind: slice("kind"),
      by_path_kind: slice("path_kind"),
    },
    results, nearMisses, unmatched, alsoLocated,
  };
};

const pct = (x) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);

const render = ({ metrics: m, results, nearMisses, unmatched, alsoLocated }) => {
  const out = [];
  out.push(`Lane R recall: ${pct(m.recall)} (${results.filter((r) => r.matched.length).length}/${m.gold} gold rules), ` +
    `strict ${pct(m.strict_recall)}, precision ${pct(m.precision)} of ${m.cards} card(s)`);
  out.push("");
  out.push("By kind:      " + Object.entries(m.by_kind).map(([k, v]) => `${k} ${v.matched}/${v.total}`).join(", "));
  out.push("By path kind: " + Object.entries(m.by_path_kind).map(([k, v]) => `${k} ${v.matched}/${v.total}`).join(", "));

  const missed = results.filter((r) => !r.matched.length);
  if (missed.length) {
    out.push("", `Missed (${missed.length}):`);
    for (const r of missed) out.push(`  ${r.id} ${r.kind}/${r.path_kind} — ${r.rule}${r.hard ? `\n         hard: ${r.hard}` : ""}`);
  }
  const weak = results.filter((r) => r.matched.length && !r.strict);
  if (weak.length) {
    out.push("", `Found, but no card names the values a test would assert on (${weak.length}):`);
    for (const r of weak) out.push(`  ${r.id} via ${r.matched.join(", ")} — missing: ${r.missing_values.join(", ")}`);
  }
  if (nearMisses.length) {
    out.push("", `Near misses — right code, different kind (${nearMisses.length}):`);
    for (const n of nearMisses) out.push(`  ${n.card.id} (${n.card.kind}) at ${n.rules.join(", ")}, expected ${n.expected.join(" or ")}`);
  }
  if (alsoLocated.length) {
    out.push("", "Cards located on more than one rule (credited to one only; the others listed):");
    for (const a of alsoLocated) out.push(`  ${a.card.id} also at ${a.rules.join(", ")}`);
  }
  if (unmatched.length) {
    out.push("", `Cards matching no gold rule (${unmatched.length}) — a rule the gold set lacks, or a citation off its line:`);
    for (const c of unmatched) out.push(`  ${c.id ?? "(no id)"} (${c.kind}) — ${String(c.then ?? "").slice(0, 140)}`);
  }
  return out.join("\n");
};

// --- self-test ----------------------------------------------------------------------------------
// A scorer bug would read as a miner regression, so the scorer proves itself on inputs whose
// answer is known. The perfect cards are built from gold.yaml in memory rather than shipped as a
// file: a second copy of the answer is a second thing to keep in step with the source.
const selfTest = (gold) => {
  let failures = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
    if (!ok) { failures++; if (detail) console.log(`      ${detail}`); }
  };
  const cardFor = (r, i, over = {}) => ({
    id: `R-BILL-${String(i + 1).padStart(3, "0")}`, kind: r.kinds[0],
    given: "", when: "", then: (r.values || []).map((g) => g[0]).join(" "),
    evidence: [{ path: `reference-src/${r.locations[0].path}`, commit: "0000000", line: r.locations[0].lines[0], basis: "transcribed" }],
    features: ["F-BILL-001"], confidence: "high", ...over,
  });

  const perfect = score(gold, gold.rules.map((r, i) => cardFor(r, i)));
  check("gold-as-cards scores 100% recall", perfect.metrics.recall === 1, JSON.stringify(perfect.results.filter((x) => !x.matched.length).map((x) => x.id)));
  check("gold-as-cards scores 100% strict recall", perfect.metrics.strict_recall === 1);
  check("gold-as-cards scores 100% precision", perfect.metrics.precision === 1, `${perfect.metrics.precision}`);

  const empty = score(gold, []);
  check("no cards: recall 0, precision n/a, no crash", empty.metrics.recall === 0 && empty.metrics.precision === null);

  const r0 = gold.rules[0];
  const otherKind = ["calculation", "validation", "eligibility", "state-transition", "derivation"].find((k) => !r0.kinds.includes(k));
  const misKinded = score(gold, [cardFor(r0, 0, { kind: otherKind })]);
  check("right line, wrong kind: a near miss, not a match", misKinded.metrics.near_misses === 1 && misKinded.metrics.recall === 0);

  const offLine = score(gold, [cardFor(r0, 0, { evidence: [{ path: r0.locations[0].path, commit: "0000000", line: 9999, basis: "transcribed" }] })]);
  check("a line outside every range matches nothing", offLine.metrics.unmatched === 1 && offLine.metrics.recall === 0);

  const fileOnly = score(gold, [cardFor(r0, 0, { evidence: [{ path: r0.locations[0].path, commit: "0000000", basis: "inferred" }] })]);
  check("a file-level citation with no line is not credited", fileOnly.metrics.unmatched === 1);

  const vague = score(gold, [cardFor(r0, 0, { then: "the amount is computed" })]);
  check("a match whose then names no values counts for recall, not strict recall",
    vague.metrics.recall > 0 && vague.metrics.strict_recall === 0);

  const dotted = score(gold, [cardFor(r0, 0, { evidence: [{ path: `./${r0.locations[0].path}`, commit: "0000000", line: r0.locations[0].lines[0], basis: "transcribed" }] })]);
  check("a ./-relative path matches the same rule", dotted.metrics.recall > 0);

  console.log(failures ? `\n${failures} self-test failure(s).` : "\nself-test passed.");
  return failures ? 1 : 0;
};

// --- main ---------------------------------------------------------------------------------------
const parse = await loadYaml();
const fixtureDir = resolve(opt("--fixture") || join(HERE, "fixtures", "rules-recall"));
const gold = parse(readFileSync(join(fixtureDir, "gold.yaml"), "utf8"));

if (flag("--self-test")) process.exit(selfTest(gold));

if (!files.length) {
  console.error("usage: rules-recall.mjs <lane-R output .yaml>... [--json] [--record] [--model <tier>] [--note <text>]\n" +
    "       rules-recall.mjs --self-test");
  process.exit(1);
}

const cards = [];
for (const f of files) {
  if (!existsSync(f)) { console.error(`rules-recall: no such file ${f}`); process.exit(1); }
  const data = parse(readFileSync(f, "utf8"));
  if (!Array.isArray(data)) { console.error(`rules-recall: ${f} is not an array of Rule Cards`); process.exit(1); }
  cards.push(...data);
}

const result = score(gold, cards);
console.log(flag("--json") ? JSON.stringify(result.metrics, null, 2) : render(result));

if (flag("--record")) {
  let pluginVersion = null;
  try { pluginVersion = JSON.parse(readFileSync(join(HERE, "..", "..", "..", ".claude-plugin", "plugin.json"), "utf8")).version; } catch { /* outside the plugin repo */ }
  const dir = join(HERE, "runs", localDate());
  const file = join(dir, "rules-recall.json");
  mkdirSync(dir, { recursive: true });
  const log = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  log.push({ at: new Date().toISOString(), plugin_version: pluginVersion, model: opt("--model") ?? null,
    note: opt("--note") ?? null, inputs: files, metrics: result.metrics,
    missed: result.results.filter((r) => !r.matched.length).map((r) => r.id) });
  writeFileSync(file, JSON.stringify(log, null, 2) + "\n");
  console.log(`\nrecorded → ${file}`);
}
