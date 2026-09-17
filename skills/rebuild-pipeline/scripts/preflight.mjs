#!/usr/bin/env node
// preflight.mjs — prove the reference builds and runs BEFORE G1 dispatches miners.
// Run from the workbench root, as the last action of G0.
// Usage:
//   node scripts/preflight.mjs [--checkout <path>] [--run-build] [--run-tests] [--json]
//
// Writes PREFLIGHT.md (what a human reads) and preflight.json (what autopilot.mjs and
// SKILL.md's phase detection read). Exit 0 on Ready / Ready-with-gaps, 1 on Not-ready.
//
// Zero-dependency, same fixed YAML subset as gate.mjs, pause-check.mjs and autopilot.mjs.
// It has to be: this runs at the end of G0, and `npm install` in the workbench is not
// guaranteed to have happened yet — the scaffold's own next-steps line puts it after the
// G0 interview. A preflight that needs the workbench's node_modules could not run at the
// one moment it exists for.
//
// WHY THIS EXISTS. G0's exit criteria said "confirm the user can run the reference
// locally" and nothing verified it, so the miners started on a promise. Every lane-D
// finding cites `path + pinned_commit`; if the checkout on disk is at a different commit,
// every one of those citations is wrong, and nothing downstream can tell — the hashes are
// of the finding, not of the thing it describes.
//
// ---------------------------------------------------------------------------
// WHY THE BUILD IS DETECTED AND NOT RUN BY DEFAULT
//
// The spec says this check "runs the build command from the reference's CI definition".
// It detects it always; it EXECUTES it only under --run-build / --run-tests, for two
// reasons that are not budget:
//
//   1. A build command lifted from an untrusted reference's CI is arbitrary code from the
//      same source E7 just finished hardening the miners against. Reading a planted
//      comment is the small version of this problem; running a planted `run:` step is the
//      large one. That decision belongs to a human, once, not to every invocation.
//   2. Idempotency is an acceptance criterion — two runs on an unchanged tree must produce
//      an identical preflight.json. A build is the least idempotent thing in a repository.
//
// Not executing is recorded as a gap, named in PREFLIGHT.md with the exact command to run,
// so it reads as "unproven", never as "passed". Ready-with-gaps is the honest verdict for
// a reference whose build nobody has watched succeed.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const argAfter = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};
const has = (flag) => args.includes(flag);

if (!existsSync(join("locks", "pipeline.yaml"))) {
  console.error("No locks/pipeline.yaml here — run from the workbench root.");
  process.exit(1);
}

// --- sources.yaml, fixed subset -------------------------------------------------------
const sourcesText = existsSync("sources.yaml") ? readFileSync("sources.yaml", "utf8") : "";
const stripQuotes = (v) => (v || "").trim().replace(/^["'](.*)["']$/, "$1");
// A `key:` whose value lives in the two-space-indented block under it.
const blockField = (block, key) => {
  const m = sourcesText.match(new RegExp(`^${block}:\\n((?:(?:[ \\t]+.*)?\\n)*)`, "m"));
  if (!m) return "";
  const f = m[1].match(new RegExp(`^\\s+${key}:\\s*(.*)$`, "m"));
  return stripQuotes((f?.[1] || "").split(/\s+#/)[0]);
};
const listUnder = (key) => {
  const m = sourcesText.match(new RegExp(`^${key}:\\n((?:(?:[ \\t]+.*)?\\n)*)`, "m"));
  if (!m) return [];
  return [...m[1].matchAll(/^\s+- (.*)$/gm)]
    .map((x) => stripQuotes(x[1].split(/\s+#/)[0])).filter(Boolean);
};

const ref = {
  name: blockField("reference", "name"),
  repo: blockField("reference", "repo"),
  pinned_commit: blockField("reference", "pinned_commit"),
  kind: blockField("reference", "kind"),
  checkout: blockField("reference", "checkout"),
};
const allowed = listUnder("allowed");

// --- where the reference checkout is --------------------------------------------------
// --checkout wins; then sources.yaml's optional `reference.checkout:`; then the two places
// the pipeline's own instructions put it. Guessing wrong is not a risk worth taking here —
// a guess that lands on the wrong repo would compare HEAD against an unrelated commit and
// report Not-ready for a reason that is not true. So the candidates are narrow, and when
// none of them is a git repo the check fails loudly with the flag to pass.
const checkoutCandidates = [
  argAfter("--checkout"), ref.checkout,
  "reference", join("..", "reference"),
  ref.name ? join("..", ref.name) : null,
].filter(Boolean);
const checkout = checkoutCandidates.find((c) => existsSync(join(c, ".git"))) || null;

const git = (cwd, ...a) => {
  try { return execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
};
const onPath = (bin) => {
  try { execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }); return true; }
  catch { return false; }
};

// --- checks ---------------------------------------------------------------------------
// status: "pass" | "gap" | "fail" | "skip". Only "fail" makes the run Not-ready.
const checks = [];
const add = (id, title, status, detail, effect) => checks.push({ id, title, status, detail, effect });

// 1. Reference source is at pinned_commit.
//    Not-ready, and it is the one check that has to be: every lane-D finding cites this
//    commit, so mining a different tree writes citations that are wrong at the moment they
//    are written and stay wrong through a gate lock that hashes them.
if (!checkout) {
  add("pinned-commit", "Reference source is at pinned_commit", "fail",
    `No reference checkout found. Looked for a .git in: ${checkoutCandidates.join(", ") || "(nothing to look for — sources.yaml names no reference)"}.`,
    "Pass --checkout <path>, or add `checkout:` under `reference:` in sources.yaml.");
} else if (!ref.pinned_commit) {
  add("pinned-commit", "Reference source is at pinned_commit", "fail",
    `sources.yaml has no reference.pinned_commit. The checkout at ${checkout} is at ${git(checkout, "rev-parse", "HEAD") || "an unreadable HEAD"}.`,
    "Fill reference.pinned_commit in sources.yaml — every lane-D citation is written against it.");
} else {
  const head = git(checkout, "rev-parse", "HEAD");
  const short = (h) => (h || "").slice(0, Math.max(7, ref.pinned_commit.length));
  if (!head) {
    add("pinned-commit", "Reference source is at pinned_commit", "fail",
      `Could not read HEAD in ${checkout}.`, "Is it a git checkout? `git -C <checkout> status`.");
  } else if (short(head) !== short(ref.pinned_commit)) {
    add("pinned-commit", "Reference source is at pinned_commit", "fail",
      `${checkout} is at ${head.slice(0, 12)}, sources.yaml pins ${ref.pinned_commit}.`,
      `Lane-D evidence would cite the wrong commit. Fix one of the two: ` +
      `\`git -C ${checkout} checkout ${ref.pinned_commit}\`, or re-pin sources.yaml to ${head.slice(0, 12)}.`);
  } else {
    const dirty = git(checkout, "status", "--porcelain");
    if (dirty) {
      add("pinned-commit", "Reference source is at pinned_commit", "gap",
        `HEAD matches ${ref.pinned_commit}, but the tree has uncommitted changes (${dirty.split("\n").length} path(s)).`,
        "A finding citing path + commit would not reproduce from the commit alone. Clean the checkout.");
    } else {
      add("pinned-commit", "Reference source is at pinned_commit", "pass",
        `${checkout} HEAD = ${ref.pinned_commit}, tree clean.`, null);
    }
  }
}

// 2. + 4. Build and test definitions — detected in the spec's order: CI, then Dockerfile,
//    then Makefile. First one found wins; the others are still listed, because "the CI says
//    one thing and the Makefile another" is itself worth knowing before a slice depends on it.
const buildDefs = [], testDefs = [];
if (checkout) {
  const wfDir = join(checkout, ".github", "workflows");
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f))) {
      const body = readFileSync(join(wfDir, f), "utf8");
      const runs = [...body.matchAll(/^\s*(?:- )?run:\s*(?:\||>-?)?\s*(.*)$/gm)]
        .map((m) => m[1].trim()).filter(Boolean);
      // Verb lists, not loose keywords. The first draft used `bundle` as a build verb and
      // `test` as the only test verb, on a reference whose CI reads `bundle exec rake
      // assets:precompile` / `bundle exec rspec`: it reported the Ruby package manager as
      // the build command and found no test suite in a repo that plainly has one. A wrong
      // command here is worse than none — it is what --run-build would execute.
      const build = runs.find((r) => /\b(build|precompile|compile|assemble|package|dist)\b/.test(r));
      const test = runs.find((r) => /\b(test|tests|spec|rspec|pytest|unittest|jest|vitest|mocha|tox|phpunit|check)\b/.test(r));
      if (build) buildDefs.push({ source: `.github/workflows/${f}`, command: build });
      if (test) testDefs.push({ source: `.github/workflows/${f}`, command: test });
    }
  }
  if (existsSync(join(checkout, "Dockerfile"))) {
    buildDefs.push({ source: "Dockerfile", command: `docker build -t ${ref.name || "reference"}:preflight .` });
  }
  const mk = ["Makefile", "makefile", "GNUmakefile"].map((m) => join(checkout, m)).find(existsSync);
  if (mk) {
    const body = readFileSync(mk, "utf8");
    if (/^build:/m.test(body)) buildDefs.push({ source: basename(mk), command: "make build" });
    for (const t of ["test", "tests", "check"]) {
      if (new RegExp(`^${t}:`, "m").test(body)) { testDefs.push({ source: basename(mk), command: `make ${t}` }); break; }
    }
  }
}

const runInCheckout = (command) => {
  try {
    execFileSync("/bin/sh", ["-c", command], { cwd: checkout, stdio: "ignore", timeout: 20 * 60_000 });
    return { ok: true };
  } catch (e) { return { ok: false, why: String(e.message).split("\n")[0] }; }
};

if (!checkout) {
  add("build", "Reference builds", "skip", "No checkout to inspect.", null);
  add("test-suite", "Reference test suite exists and passes", "skip", "No checkout to inspect.", null);
} else if (!buildDefs.length) {
  add("build", "Reference builds", "gap",
    "No build definition detected (.github/workflows, Dockerfile, Makefile — in that order).",
    "Lane D still runs; the E8 equivalence lane has no way to stand up the legacy system and stays disabled.");
} else if (has("--run-build")) {
  const d = buildDefs[0];
  const r = runInCheckout(d.command);
  add("build", "Reference builds", r.ok ? "pass" : "gap",
    `${d.source}: \`${d.command}\` — ${r.ok ? "succeeded" : `failed (${r.why})`}.`,
    r.ok ? null : "Lane D still runs; the E8 equivalence lane stays disabled until the reference builds.");
} else {
  const d = buildDefs[0];
  add("build", "Reference builds", "gap",
    `Build definition found in ${d.source}: \`${d.command}\`. Not executed.`,
    `Unproven, not failed. Run it yourself, or re-run: \`node scripts/preflight.mjs --run-build\` ` +
    `— that executes a command from the reference's own CI, which is why it is opt-in.`);
}

if (checkout && !testDefs.length) {
  add("test-suite", "Reference test suite exists and passes", "gap",
    "No test target detected in the reference's CI, Makefile or Dockerfile.",
    "Recorded: the E8 equivalence lane has no baseline to compare against.");
} else if (checkout && has("--run-tests")) {
  const d = testDefs[0];
  const r = runInCheckout(d.command);
  add("test-suite", "Reference test suite exists and passes", r.ok ? "pass" : "gap",
    `${d.source}: \`${d.command}\` — ${r.ok ? "passed" : `failed (${r.why})`}.`,
    r.ok ? null : "A red reference suite is a baseline fact, not a blocker — record which tests are red before mining.");
} else if (checkout) {
  const d = testDefs[0];
  add("test-suite", "Reference test suite exists and passes", "gap",
    `Test target found in ${d.source}: \`${d.command}\`. Not executed.`,
    "Re-run with --run-tests to record the baseline the E8 equivalence lane compares against.");
}

// 3. Reference runs. Probe the instance URL from sources.yaml.allowed.
//    Not-ready for lanes B and C — those two mine the running product and nothing else —
//    while lane D proceeds, which is why the lane verdicts below are per-lane and the
//    overall verdict is not simply their minimum.
const instanceUrls = allowed.filter((u) => /^https?:\/\//.test(u));
const probe = async (url) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: "follow" });
    return { ok: res.status < 500, status: res.status };
  } catch (e) { return { ok: false, why: String(e.message).split("\n")[0] }; }
  finally { clearTimeout(t); }
};

const isMobile = /client-only/.test(blockField("architecture", "target_shape")) &&
  /flutter|mobile/i.test(blockField("architecture", "playbook"));
if (isMobile) {
  // No HTTP endpoint to probe: the running reference is a binary on a device or simulator,
  // and only the user can say whether it is installed and opens. Recorded as a gap the G1
  // exit criteria already make the user confirm, rather than a check this script can fake.
  add("instance", "Reference runs", "gap",
    "Mobile reference: the running instance is the old app on a device or simulator, which this script cannot probe.",
    "Confirm with the user that the old app is installed and opens — ideally from a backup of a real install (g1-mining.md). Lanes B and C depend on it.");
} else if (!instanceUrls.length) {
  add("instance", "Reference runs", "gap",
    "sources.yaml `allowed:` names no http(s) instance URL to probe.",
    "Lanes B (NFR) and C (UX flows) mine the running product and have nothing to mine. Add the instance URL, or record that the reference cannot be run and accept that B and C are docs-only.");
} else {
  const results = [];
  for (const u of instanceUrls) results.push({ url: u, ...(await probe(u)) });
  const up = results.filter((r) => r.ok);
  if (!up.length) {
    add("instance", "Reference runs", "gap",
      results.map((r) => `${r.url} — ${r.status ? `HTTP ${r.status}` : r.why}`).join("; "),
      "Lanes B and C have no running product to observe. Lane D may proceed.");
  } else {
    add("instance", "Reference runs", "pass",
      up.map((r) => `${r.url} — HTTP ${r.status}`).join("; "), null);
  }
}

// 5. Scope boundary — advisory, always. A reference mined at a subdirectory of a larger
//    repo has siblings that may import from it, and every one of those is behavior the
//    matrix will not see. Naming them is the whole job; deciding about them is not this
//    script's call.
if (checkout) {
  const top = git(checkout, "rev-parse", "--show-toplevel");
  const abs = resolve(checkout);
  if (top && resolve(top) !== abs) {
    const rel = abs.slice(resolve(top).length + 1);
    const siblings = readdirSync(top)
      .filter((d) => !d.startsWith(".") && d !== rel.split("/")[0])
      .filter((d) => { try { return statSync(join(top, d)).isDirectory(); } catch { return false; } });
    const importers = siblings.filter((d) => {
      const hit = (() => {
        try {
          return execFileSync("grep", ["-rqs", "--", basename(abs), join(top, d)],
            { stdio: ["ignore", "ignore", "ignore"], timeout: 30_000 });
        } catch { return null; }
      })();
      return hit !== null;
    });
    add("scope-boundary", "Scope boundary", "gap",
      `The mined path is \`${rel}\` inside the monorepo at ${top}. ` +
      (importers.length
        ? `Sibling(s) mentioning it: ${importers.join(", ")}.`
        : `No sibling mentions it by name.`),
      "Advisory only. Behavior living in a sibling is behavior the feature matrix will not see — decide deliberately whether it is in scope.");
  } else {
    add("scope-boundary", "Scope boundary", "pass", "The checkout is its own repository root.", null);
  }
}

// 6. The two G0 interview answers. Recorded in license-posture.md, and they feed
//    sources.yaml `denied:` — an off-limits path the deny list does not carry is an
//    instruction that exists only in a conversation nobody will re-read.
const posture = existsSync("license-posture.md") ? readFileSync("license-posture.md", "utf8") : "";
// The heading alone does not count — the scaffold ships both headings with a prompt in an
// HTML comment, so "section present" would pass on an unanswered question, which is the
// exact failure this check exists to catch. Answered means a line of prose under it.
const sectionBody = (heading) => {
  // Split on headings rather than a lookahead: the body runs to the next `## ` or to EOF,
  // and JavaScript has no \Z for that second case — an earlier draft wrote one and matched
  // a literal "Z", so the last section of the file silently never matched.
  const parts = posture.split(/^## /m).slice(1);
  const hit = parts.find((p) => p.split("\n")[0].trim().toLowerCase() === heading.toLowerCase());
  return hit === undefined ? null : hit.split("\n").slice(1).join("\n");
};
const answered = (heading) => {
  const body = sectionBody(heading);
  if (body === null) return false;
  // Strip HTML comments FIRST. The scaffold's prompts span several lines, and a per-line
  // "starts with <!--" test reads the middle line of one as prose — which is a question
  // reported as answered, the one error this check must not make.
  return body.replace(/<!--[\s\S]*?-->/g, "").trim().length > 0;
};
const hasPrior = answered("Prior attempts");
const hasOffLimits = answered("Off-limits");
if (hasPrior && hasOffLimits) {
  add("interview", "Prior attempts and off-limits recorded", "pass",
    "license-posture.md carries both sections.", null);
} else {
  const missing = [!hasPrior && "Prior attempts", !hasOffLimits && "Off-limits"].filter(Boolean);
  add("interview", "Prior attempts and off-limits recorded", "gap",
    `license-posture.md is missing: ${missing.join(", ")}.`,
    "Ask the two G0 questions (g0-reference.md) and write the answers down. Anything off-limits also belongs in sources.yaml `denied:` — the miners read that, not the prose.");
}

// 7. Tooling. Metrics degrade to find/wc without scc/cloc; lane D's miners navigate with
//    grep instead of a graph without graphify. Both are gaps, neither is fatal.
const counter = ["scc", "cloc"].find(onPath);
const graphify = onPath("graphify");
const toolNotes = [
  counter ? `${counter} present` : "neither scc nor cloc on PATH — size metrics fall back to find/wc",
  graphify ? "graphify present" : "graphify not on PATH — lane-D miners grep cold instead of querying a graph (g1-mining.md)",
];
add("tooling", "Tooling", counter && graphify ? "pass" : "gap", toolNotes.join("; "),
  counter && graphify ? null : "Install what is missing, or accept the degraded path — neither blocks G1.");

// --- verdict --------------------------------------------------------------------------
const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
const failed = checks.filter((c) => c.status === "fail");
const gaps = checks.filter((c) => c.status === "gap");
const verdict = failed.length ? "Not-ready" : gaps.length ? "Ready-with-gaps" : "Ready";

// Per-lane, because the causes are not interchangeable: a wrong commit poisons lane D's
// citations and nothing else; an instance that will not come up takes out B and C and
// leaves D untouched.
//
// A lane verdict is NOT the check's status, and the two must not be collapsed. The spec's
// row for "reference runs" reads "Not-ready for lanes B and C; lane D may proceed" — but
// the overall verdict gates dispatch for ALL lanes, so recording that as a global
// Not-ready would block the one lane the same sentence says may proceed. So an unreachable
// instance is a global **gap** with lanes B and C **blocked**: the run is Ready-with-gaps,
// the orchestrator dispatches lane D and lane A, and PREFLIGHT.md says in as many words
// that B and C have nothing to observe yet.
//
// The wrong commit is the only global Not-ready, and it earns it: it is the only cause
// where dispatching anyway produces artifacts that are wrong rather than missing.
const commitBad = byId["pinned-commit"]?.status === "fail";
const instanceOk = byId["instance"]?.status === "pass";
const lanes = {
  A: "ready",
  B: instanceOk ? "ready" : "blocked",
  C: instanceOk ? "ready" : "blocked",
  D: commitBad ? "blocked" : "ready",
};

// No timestamp in this file, deliberately. Two runs on an unchanged tree must produce a
// byte-identical preflight.json (it is an acceptance criterion), and a clock makes that
// impossible. Staleness is answered by the two fields that actually move when the thing
// being checked moves — `pinned_commit` and `checkout_head`. The human-readable date lives
// in PREFLIGHT.md, which is prose and has no such contract.
const report = {
  schema: "preflight.schema.json",
  verdict,
  reference: {
    name: ref.name || null,
    kind: ref.kind || null,
    pinned_commit: ref.pinned_commit || null,
    checkout: checkout || null,
    checkout_head: checkout ? git(checkout, "rev-parse", "HEAD") : null,
  },
  lanes,
  checks,
  blockers: failed.map((c) => `${c.title}: ${c.detail}`),
  gaps: gaps.map((c) => `${c.title}: ${c.detail}`),
};
writeFileSync("preflight.json", JSON.stringify(report, null, 2) + "\n");

const MARK = { pass: "✅", gap: "🟡", fail: "⛔", skip: "—" };
const md = [
  `# Preflight — ${verdict}`,
  ``,
  `Generated ${new Date().toISOString()} by \`npm run preflight\`. Machine-readable twin: \`preflight.json\`.`,
  ``,
  verdict === "Not-ready"
    ? `**G1 dispatch is blocked.** \`autopilot preflight\` and the orchestrator's G1 step refuse to dispatch miners until this reads Ready or Ready-with-gaps. G0's own artifacts — \`sources.yaml\`, \`license-posture.md\` — commit and push regardless; none of the causes below changes a G0 decision.`
    : verdict === "Ready-with-gaps"
      ? `**G1 may dispatch.** The gaps below are real and named; each one says what it costs.`
      : `**G1 may dispatch.** No gaps.`,
  ``,
  `| Lane | | Verdict |`,
  `|---|---|---|`,
  `| A | Features | ${lanes.A} |`,
  `| B | NFR | ${lanes.B} |`,
  `| C | UX flows | ${lanes.C} |`,
  `| D | Ground truth | ${lanes.D} |`,
  ``,
  `## Checks`,
  ``,
  ...checks.flatMap((c) => [
    `### ${MARK[c.status]} ${c.title}`,
    ``,
    c.detail,
    ...(c.effect ? ["", `→ ${c.effect}`] : []),
    ``,
  ]),
  `## Re-running`,
  ``,
  "```sh",
  `npm run preflight               # detect only`,
  `npm run preflight -- --run-build --run-tests   # also execute the reference's own build and test commands`,
  "```",
  ``,
  `Executing them is opt-in because they are arbitrary commands from a third party's CI —`,
  `the same source \`agents/miner.md\` treats as untrusted input. Detected-not-executed is`,
  `recorded as a gap, never as a pass.`,
  ``,
].join("\n");
writeFileSync("PREFLIGHT.md", md);

if (has("--json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(verdict === "Not-ready" ? 1 : 0);
}

console.log(`Preflight: ${verdict}\n`);
for (const c of checks) {
  console.log(`  ${MARK[c.status]} ${c.title}`);
  console.log(`     ${c.detail}`);
  if (c.effect) console.log(`     → ${c.effect}`);
}
console.log(`\n  Lanes: A ${lanes.A} · B ${lanes.B} · C ${lanes.C} · D ${lanes.D}`);
console.log(`\nWrote PREFLIGHT.md and preflight.json.`);
if (verdict === "Not-ready") {
  console.log("G1 dispatch is blocked until this reads Ready or Ready-with-gaps.");
  process.exit(1);
}
process.exit(0);
