#!/usr/bin/env node
// equiv.mjs — the equivalence lane: does the rebuild produce what the OLD system produced?
// Run from the workbench root.
// Usage:
//   node scripts/equiv.mjs status
//   node scripts/equiv.mjs record <feature-id>          # drive the LEGACY instance, write traces
//   node scripts/equiv.mjs replay <feature-id>|--all    # replay against the REBUILD, write JUnit
//   node scripts/equiv.mjs accept <trace> --reason "..." # log a decision about a red trace
//   node scripts/equiv.mjs unlock --reason "..."  |  relock
//
// Needs the workbench's `yaml` dependency (npm install). Unlike preflight.mjs this cannot run
// before G0 finishes — traces are recorded per slice, deep into G5 — and trace files carry
// nested request/response bodies that a fixed-subset regex parser would mangle silently. The
// hook and gate.mjs stay zero-dependency because neither needs to parse a trace: the guard
// needs a path, and gate.mjs needs the JUnit and the decision log.
//
// WHAT THIS IS FOR
//
// `parity/flows/` is already a characterization harness — but only through Maestro, on the
// accessibility layer, for a `client-only` mobile rebuild. A `fullstack` rebuild of your own
// legacy web app had no equivalent: G6 said which features were covered and whether AC passed,
// never whether `POST /invoices` returns the same totals the old system returned. This lane is
// the same principle one layer down: a trace green against the old system and then green
// against the rebuild is evidence of parity.
//
// Maestro answers *does the UI do what the old UI did*. This answers *does the system produce
// what the old system produced*. A `client-only` rebuild uses Maestro alone; a `fullstack`
// own-code rebuild uses both; a third-party reference uses neither.
//
// RECORDED BEFORE THE SLICE'S BACKEND LANE STARTS, AND THE ORDER IS THE WHOLE POINT
//
// A trace recorded after the rebuild exists is derived from the rebuild. It asserts what was
// built, says nothing about the reference, and every later replay agrees with the code by
// construction — the same argument g5-build.md step 0 makes for Maestro flows, and the reason
// that property cannot be recovered afterwards short of standing the old system back up.
//
// WHY IT IS GATED ON own-code
//
// Replaying recorded traffic against a product you do not operate is neither legal nor
// practical, and under clean-room posture reading the reference's responses at all is the thing
// the posture forbids. So the lane runs only where `sources.yaml` says `reference.kind:
// own-code` and the E4 preflight says the reference actually runs. Everywhere else it refuses
// and says which condition failed — never a silent no-op, because an empty equivalence column
// and a skipped lane look identical in a report.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync, appendFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";

export const EQUIV_DIR = "parity/equiv";
export const UNLOCK_FILE = join(EQUIV_DIR, ".unlocked.yaml");
export const DECISION_LOG = join(EQUIV_DIR, "DECISIONS.md");
export const CONFIG_FILE = join(EQUIV_DIR, "config.yaml");

// ---------------------------------------------------------------------------
// Adapter interface — capture() / diff()
//
// An HTTP response is only half of what a request does. `POST /invoices` returning the same
// JSON while writing a different row is not equivalence, and it is exactly the class of
// difference a rebuild produces: the API was transcribed from the contract and the persistence
// was rewritten. So a trace can declare `tables:` and an adapter snapshots them.
//
// The interface is two functions and deliberately no more:
//
//   capture(tables, side)  -> { [table]: rows }   a snapshot, JSON-serialisable
//   diff(before, after, ignore) -> [ { path, legacy, rebuild } ]   empty means equivalent
//
// `side` is "legacy" or "rebuild" and is resolved to a connection by config.yaml, so an adapter
// never learns which system it is talking to beyond that word.
//
// ONE ADAPTER SHIPS: postgres. It covers OpenProject, most Rails/Django legacy and the Go
// target. Job-queue capture is deliberately absent until a real own-code rebuild shows which
// side effects the row diff misses — guessing at that interface now would mean designing
// against an imagined failure, and the adapter boundary exists precisely so the second one can
// be added without touching this file's command surface.
//
// Adapters are NOT a playbook concern. The playbook describes the target; the adapter is needed
// on the legacy side, which the playbook says nothing about.
// ---------------------------------------------------------------------------

/** Rows of the declared tables, via `psql`. Zero client libraries: the plugin ships none. */
const postgresAdapter = {
  name: "postgres",
  available(conn) {
    if (!conn) return "no connection string (see config.yaml)";
    try { execFileSync("psql", ["--version"], { stdio: "ignore" }); } catch { return "`psql` is not on PATH"; }
    // Reachability is NOT checked here — that is capture()'s job, and doing it twice would
    // double every connection timeout on a system that is simply down.
    return null;
  },
  capture(tables, conn) {
    const out = {};
    for (const t of tables) {
      // `order by 1` makes the snapshot stable run to run: an unordered select is free to
      // return the same rows in a different order, which would diff as every row changed.
      const sql = `select coalesce(json_agg(row_to_json(t) order by 1), '[]'::json) from "${t}" t`;
      let raw;
      try {
        // stderr is PIPED, not inherited: psql's own multi-line connection errors would
        // otherwise print before this script's message and bury the one piece of context that
        // matters — which table, on which side, during which command.
        raw = execFileSync("psql", [conn, "-At", "-c", sql],
          { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        const why = (String(e.stderr || e.message).split("\n").find((l) => l.trim()) || "").trim();
        throw new Error(`psql failed reading table "${t}": ${why}`);
      }
      try { out[t] = JSON.parse(raw.trim() || "[]"); }
      catch { throw new Error(`psql returned unparseable JSON for table "${t}"`); }
    }
    return out;
  },
  diff(before, after, ignore) {
    return diffValues(before, after, "$", ignore);
  },
};

const ADAPTERS = { postgres: postgresAdapter };

// ---------------------------------------------------------------------------
// Structural diff, with `ignore` declared per trace and never inferred.
//
// Fields the rebuild is ALLOWED to differ on — surrogate ids, timestamps, hashes, whatever the
// Gate 4 contract renamed — are listed in the trace's `ignore:`. Anything not listed is a
// failure. That direction matters: a differ that guessed at "probably a timestamp" would quietly
// absorb the one difference somebody needed to see, and the guess would be invisible in the
// report. Declaring them makes the list reviewable, and adding to it is a logged decision.
//
// Patterns: `$.a.b`, `$.items[*].id`, and `**.created_at` for a field at any depth. A bare name
// means the top-level field only — `id` ignoring every `id` everywhere is how an equivalence
// suite becomes decorative, so that spelling has to be asked for explicitly as `**.id`.
// ---------------------------------------------------------------------------
const pathMatches = (path, pattern) => {
  const p = pattern.startsWith("**.")
    ? `^\\$(\\.[^.]+|\\[[0-9*]+\\])*\\.${pattern.slice(3).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`
    : "^" + (pattern.startsWith("$") ? pattern : "$." + pattern)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\[\\\*\\\]/g, "\\[\\d+\\]") + "$";
  try { return new RegExp(p).test(path); } catch { return false; }
};
const isIgnored = (path, ignore) => (ignore || []).some((pat) => pathMatches(path, pat));

const diffValues = (a, b, path, ignore, out = []) => {
  if (isIgnored(path, ignore)) return out;
  const ta = a === null ? "null" : Array.isArray(a) ? "array" : typeof a;
  const tb = b === null ? "null" : Array.isArray(b) ? "array" : typeof b;
  if (ta !== tb) { out.push({ path, legacy: a, rebuild: b }); return out; }
  if (ta === "array") {
    if (a.length !== b.length) out.push({ path: `${path}.length`, legacy: a.length, rebuild: b.length });
    for (let i = 0; i < Math.max(a.length, b.length); i++) diffValues(a[i], b[i], `${path}[${i}]`, ignore, out);
    return out;
  }
  if (ta === "object") {
    for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
      diffValues(a?.[k], b?.[k], `${path}.${k}`, ignore, out);
    }
    return out;
  }
  if (a !== b) out.push({ path, legacy: a, rebuild: b });
  return out;
};

// ---------------------------------------------------------------------------
// Gating. Refuses loudly rather than no-opping: an empty equivalence column and a lane that
// never applied look identical in a report, and only one of them means anything.
// ---------------------------------------------------------------------------
const readSources = () => {
  const text = existsSync("sources.yaml") ? readFileSync("sources.yaml", "utf8") : "";
  const block = text.match(/^reference:\n((?:(?:[ \t]+.*)?\n)*)/m);
  const get = (k) => (block?.[1].match(new RegExp(`^\\s+${k}:\\s*(.*)$`, "m")) || [])[1]
    ?.trim().split(/\s+#/)[0].replace(/^["']|["']$/g, "") || "";
  return { kind: get("kind"), name: get("name") };
};
const gateReasons = () => {
  const reasons = [];
  const { kind } = readSources();
  if (kind !== "own-code") {
    reasons.push(`sources.yaml has reference.kind: ${kind || "(empty)"} — this lane needs \`own-code\`. ` +
      `Replaying recorded traffic against a product you do not operate is neither legal nor ` +
      `practical, and under clean-room posture reading the reference's responses is the thing ` +
      `the posture forbids. A third-party rebuild uses the AC suite and the parity report; ` +
      `parity.mjs says the lane does not apply rather than showing an empty column.`);
  }
  if (!existsSync("preflight.json")) {
    reasons.push("no preflight.json — run `npm run preflight` (G0's last action). This lane " +
      "replays against the legacy system, so \"the reference runs\" has to be a checked fact, " +
      "not an assumption.");
  } else {
    let pf = null;
    try { pf = JSON.parse(readFileSync("preflight.json", "utf8")); } catch { /* handled below */ }
    if (!pf) reasons.push("preflight.json is unreadable — re-run `npm run preflight`.");
    else {
      const instance = (pf.checks || []).find((c) => c.id === "instance");
      if (instance?.status !== "pass") {
        reasons.push(`preflight says the reference does not run (\`instance\` check: ` +
          `${instance?.status || "absent"}${instance?.detail ? ` — ${instance.detail}` : ""}). ` +
          `Stand the legacy system up and re-run \`npm run preflight\`.`);
      }
    }
  }
  return reasons;
};
const requireGate = (cmd) => {
  const reasons = gateReasons();
  if (!reasons.length) return;
  console.error(`equiv ${cmd}: this workbench does not meet the equivalence lane's gating condition.\n`);
  for (const r of reasons) console.error(`  - ${r}\n`);
  console.error("Nothing was written.");
  process.exit(1);
};

// ---------------------------------------------------------------------------
// Config + traces
// ---------------------------------------------------------------------------
const readConfig = () => {
  if (!existsSync(CONFIG_FILE)) return null;
  try { return parse(readFileSync(CONFIG_FILE, "utf8")) || null; } catch { return null; }
};
// Connections come from ENV VAR NAMES in config.yaml, not from literals. The workbench is a git
// repo that gets pushed, and a DSN with a password in it is a credential in version control —
// this directory is committed on purpose, which makes it exactly the wrong place for one.
const resolveSide = (cfg, side) => {
  const s = cfg?.[side] || {};
  const pick = (literalKey, envKey) => {
    const envName = s[envKey];
    if (envName && process.env[envName]) return process.env[envName];
    if (envName) return null; // named but unset — the caller reports which variable
    return s[literalKey] || null;
  };
  return {
    baseUrl: pick("base_url", "base_url_env"),
    db: pick("database_url", "database_url_env"),
    baseUrlEnv: s.base_url_env, dbEnv: s.database_url_env,
  };
};

const traceFiles = (featureId) => {
  const dirs = featureId
    ? [join(EQUIV_DIR, featureId)]
    : (existsSync(EQUIV_DIR) ? readdirSync(EQUIV_DIR)
        .map((d) => join(EQUIV_DIR, d))
        .filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } }) : []);
  const out = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((f) => f.endsWith(".trace.yaml"))) out.push(join(d, f));
  }
  return out.sort();
};
const requestFiles = (featureId) => {
  const d = join(EQUIV_DIR, featureId);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".request.yaml")).map((f) => join(d, f)).sort();
};
const traceName = (p) => `${basename(join(p, "..")) } › ${basename(p).replace(/\.trace\.yaml$/, "")}`;

const doRequest = async (baseUrl, req) => {
  const url = new URL(req.path, baseUrl).toString();
  const init = { method: req.method || "GET", headers: { ...(req.headers || {}) }, redirect: "manual" };
  if (req.body !== undefined && req.body !== null) {
    init.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    if (!Object.keys(init.headers).some((h) => h.toLowerCase() === "content-type")) {
      init.headers["content-type"] = "application/json";
    }
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
};

// --- CLI. Importing this module runs nothing. ---
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (!isMain) { /* imported for EQUIV_DIR / readUnlock etc. */ }

export const readUnlock = (root = ".") => {
  const p = join(root, UNLOCK_FILE);
  if (!existsSync(p)) return null;
  let text = "";
  try { text = readFileSync(p, "utf8"); } catch { return null; }
  const get = (k) => (text.match(new RegExp(`^${k}:\\s*(.*)$`, "m")) || [])[1]?.trim().replace(/^"|"$/g, "");
  return { reason: get("reason") || "(no reason recorded)", at: get("at") || "(unknown)", by: get("by") || "unknown" };
};

if (isMain) {
  if (!existsSync(join("locks", "pipeline.yaml"))) {
    console.error("No locks/pipeline.yaml here — run from the workbench root.");
    process.exit(1);
  }
  const cmd = process.argv[2] || "status";
  const argAfter = (f) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : undefined; };
  const has = (f) => process.argv.includes(f);
  const by = argAfter("--by") || process.env.USER || "unknown";
  const now = new Date().toISOString();
  const yamlStr = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
  const logDecision = (line) => {
    mkdirSync(EQUIV_DIR, { recursive: true });
    if (!existsSync(DECISION_LOG)) {
      writeFileSync(DECISION_LOG, "# Equivalence trace decisions\n\n" +
        "Every suspension of the trace-protection rule, every restoration of it, and every\n" +
        "accepted difference between the legacy system and the rebuild, in order.\n" +
        "Written by `npm run equiv -- unlock|relock|accept`. Do not edit by hand — the point of\n" +
        "the log is that it records what happened, not what someone remembers happening.\n\n" +
        "`gate.mjs lock gate-5` reads the `accepted:` lines below and refuses to lock while the\n" +
        "newest equivalence run has a failure that none of them names.\n\n");
    }
    appendFileSync(DECISION_LOG, line);
  };

  // ---- status -------------------------------------------------------------
  if (cmd === "status") {
    const reasons = gateReasons();
    if (reasons.length) {
      console.log("Equivalence lane: DOES NOT APPLY to this workbench.\n");
      for (const r of reasons) console.log(`  - ${r}\n`);
      process.exit(0);
    }
    const traces = traceFiles(null);
    const u = readUnlock();
    console.log(`Equivalence lane: applies (own-code, reference runs).`);
    console.log(`  ${traces.length} trace(s) recorded under ${EQUIV_DIR}/`);
    const byFeature = new Map();
    for (const t of traces) {
      const f = basename(join(t, ".."));
      byFeature.set(f, (byFeature.get(f) || 0) + 1);
    }
    for (const [f, n] of [...byFeature].sort()) console.log(`    ${f}: ${n}`);
    console.log(u
      ? `\n  Traces: UNLOCKED since ${u.at} by ${u.by}\n    reason: ${u.reason}\n` +
        `  Re-lock as soon as the change is made: npm run equiv -- relock`
      : `\n  Traces: protected. Editing a committed *.trace.yaml is blocked by the hook.`);
    process.exit(0);
  }

  // ---- record -------------------------------------------------------------
  if (cmd === "record") {
    requireGate("record");
    const featureId = process.argv[3];
    if (!featureId || featureId.startsWith("--")) {
      console.error("Usage: equiv record <feature-id>");
      process.exit(1);
    }
    const cfg = readConfig();
    if (!cfg) {
      console.error(`No ${CONFIG_FILE}. Create it first — it names the two systems and the adapter:\n\n` +
        `adapter: postgres\n` +
        `legacy:\n  base_url_env: EQUIV_LEGACY_URL\n  database_url_env: EQUIV_LEGACY_DB\n` +
        `rebuild:\n  base_url_env: EQUIV_REBUILD_URL\n  database_url_env: EQUIV_REBUILD_DB\n\n` +
        `Env var NAMES, not values: this directory is committed, and a DSN with a password in ` +
        `it is a credential in version control.`);
      process.exit(1);
    }
    const reqs = requestFiles(featureId);
    if (!reqs.length) {
      console.error(`No *.request.yaml under ${join(EQUIV_DIR, featureId)}/.\n\n` +
        `A trace is recorded FROM a request you author, out of the feature's UX flows and its ` +
        `Rule Cards — this script drives the legacy system, it does not invent the traffic. One ` +
        `file per behavior worth proving:\n\n` +
        `  ${join(EQUIV_DIR, featureId, "issue-invoice.request.yaml")}\n\n` +
        `    feature: ${featureId}\n` +
        `    rules: [R-BILL-002]        # optional; puts this trace in parity's per-rule column\n` +
        `    tables: [invoices]         # optional; snapshotted by the adapter before and after\n` +
        `    ignore:                    # fields the rebuild MAY differ on. Declared, never guessed\n` +
        `      - $.id\n` +
        `      - $.created_at\n` +
        `    request:\n      method: POST\n      path: /api/invoices\n      body: { customer_id: 1 }\n`);
      process.exit(1);
    }
    const legacy = resolveSide(cfg, "legacy");
    if (!legacy.baseUrl) {
      console.error(`No legacy base URL. config.yaml names ${legacy.baseUrlEnv || "(nothing)"}` +
        `${legacy.baseUrlEnv ? `, which is unset in this shell` : ""}.`);
      process.exit(1);
    }
    const adapterName = cfg.adapter || "none";
    const adapter = adapterName === "none" ? null : ADAPTERS[adapterName];
    if (adapterName !== "none" && !adapter) {
      console.error(`Unknown adapter "${adapterName}". Shipped: ${Object.keys(ADAPTERS).join(", ")}, or \`none\`.`);
      process.exit(1);
    }

    mkdirSync(join(EQUIV_DIR, featureId), { recursive: true });
    let written = 0;
    for (const rf of reqs) {
      const spec = parse(readFileSync(rf, "utf8")) || {};
      const name = basename(rf).replace(/\.request\.yaml$/, "");
      const out = join(EQUIV_DIR, featureId, `${name}.trace.yaml`);
      if (existsSync(out) && !has("--force")) {
        console.log(`skip   ${out} already exists (re-recording would overwrite evidence — --force to insist)`);
        continue;
      }
      const tables = spec.tables || [];
      let rowsBefore = null, rowsAfter = null;
      const snapshot = (when) => {
        try { return adapter.capture(tables, legacy.db); }
        catch (e) {
          console.error(`Cannot snapshot ${tables.join(", ")} on the LEGACY side (${when} the request), ` +
            `recording ${name}:\n  ${e.message}`);
          console.error(`\n  config.yaml's legacy.database_url_env names ` +
            `${legacy.dbEnv || "(nothing)"}${legacy.dbEnv ? `, currently ${process.env[legacy.dbEnv] ? "set" : "UNSET"}` : ""}.`);
          console.error("  Nothing was written. A trace with half a snapshot is worse than no trace: " +
            "it would replay green against a rebuild that persists nothing.");
          process.exit(1);
        }
      };
      if (adapter && tables.length) {
        const why = adapter.available(legacy.db);
        if (why) {
          console.error(`Cannot snapshot tables for ${name}: ${why}.`);
          process.exit(1);
        }
        rowsBefore = snapshot("before");
      }
      let res;
      try { res = await doRequest(legacy.baseUrl, spec.request || {}); }
      catch (e) {
        console.error(`Request failed against the LEGACY system for ${name}: ${String(e.message).split("\n")[0]}`);
        console.error("Nothing recorded. The legacy system has to be up and reachable to record against it.");
        process.exit(1);
      }
      if (adapter && tables.length) rowsAfter = snapshot("after");

      const doc = {
        "//": "Recorded against the LEGACY system before the rebuild existed. Do not edit: " +
          "`npm run equiv -- unlock --reason \"...\"` is the logged way to change an expectation.",
        feature: featureId,
        rules: spec.rules || [],
        recorded_at: now,
        recorded_by: by,
        adapter: adapter && tables.length ? adapterName : "none",
        request: spec.request || {},
        expect: { status: res.status, body: res.body },
        ignore: spec.ignore || [],
        tables,
        ...(rowsBefore ? { rows_before: rowsBefore, rows_after: rowsAfter } : {}),
      };
      writeFileSync(out, toYaml(doc));
      console.log(`recorded ${out}  (HTTP ${res.status}${tables.length ? `, ${tables.length} table(s) snapshotted` : ""})`);
      written++;
    }
    console.log(`\n${written} trace(s) recorded for ${featureId}.`);
    console.log("Commit them now. A committed trace is protected by the hook; an uncommitted one " +
      "is still being recorded and is free to edit.");
    process.exit(0);
  }

  // ---- replay -------------------------------------------------------------
  if (cmd === "replay") {
    requireGate("replay");
    const featureId = has("--all") ? null : process.argv[3];
    if (!featureId && !has("--all")) {
      console.error("Usage: equiv replay <feature-id> | --all");
      process.exit(1);
    }
    const cfg = readConfig();
    const rebuild = resolveSide(cfg, "rebuild");
    if (!rebuild.baseUrl) {
      console.error(`No rebuild base URL. config.yaml names ${rebuild.baseUrlEnv || "(nothing)"}` +
        `${rebuild.baseUrlEnv ? ", which is unset in this shell" : ""}.`);
      process.exit(1);
    }
    const traces = traceFiles(featureId);
    if (!traces.length) {
      console.error(`No *.trace.yaml under ${featureId ? join(EQUIV_DIR, featureId) : EQUIV_DIR}/ — ` +
        `record before you replay.`);
      process.exit(1);
    }
    const adapterName = cfg.adapter || "none";
    const adapter = adapterName === "none" ? null : ADAPTERS[adapterName];

    const cases = [];
    for (const tf of traces) {
      const t = parse(readFileSync(tf, "utf8")) || {};
      const name = basename(tf).replace(/\.trace\.yaml$/, "");
      const feature = t.feature || basename(join(tf, ".."));
      // classname carries the feature id and any rule ids, because that is the only thing JUnit
      // transports — acsuite.mjs groups the equivalence run by both, exactly as it does the AC run.
      const classname = [feature, ...(t.rules || [])].join(" ");
      const diffs = [];
      let errored = null;
      let res = null;
      const tables = t.tables || [];
      let rowsAfter = null;
      try {
        if (adapter && tables.length && t.rows_before) {
          const why = adapter.available(rebuild.db);
          if (why) throw new Error(why);
          // The rebuild's rows are compared against the LEGACY's post-request snapshot: the
          // question is what the request left behind, not what the database happened to hold.
        }
        res = await doRequest(rebuild.baseUrl, t.request || {});
        if (adapter && tables.length && t.rows_after) rowsAfter = adapter.capture(tables, rebuild.db);
      } catch (e) { errored = String(e.message).split("\n")[0]; }

      if (errored) {
        cases.push({ name, classname, failure: `request or snapshot failed against the rebuild: ${errored}` });
        console.log(`ERROR  ${feature} › ${name}: ${errored}`);
        continue;
      }
      if (t.expect?.status !== res.status) {
        diffs.push({ path: "$.status", legacy: t.expect?.status, rebuild: res.status });
      }
      diffs.push(...diffValues(t.expect?.body, res.body, "$.body", t.ignore || []));
      if (rowsAfter) diffs.push(...adapter.diff(t.rows_after, rowsAfter, (t.ignore || []).map(
        (p) => (p.startsWith("$.body") ? p.replace(/^\$\.body/, "$") : p))));

      if (diffs.length) {
        const detail = diffs.slice(0, 20).map((d) =>
          `  ${d.path}\n    legacy:  ${JSON.stringify(d.legacy)}\n    rebuild: ${JSON.stringify(d.rebuild)}`).join("\n");
        cases.push({ name, classname, failure:
          `${diffs.length} unignored difference(s) between the legacy system and the rebuild:\n${detail}` +
          (diffs.length > 20 ? `\n  …and ${diffs.length - 20} more` : "") });
        console.log(`FAIL   ${feature} › ${name}  (${diffs.length} difference(s))`);
      } else {
        cases.push({ name, classname });
        console.log(`ok     ${feature} › ${name}`);
      }
    }

    const date = new Date().toISOString().slice(0, 10);
    const out = join("parity", `${date}-equiv.xml`);
    mkdirSync("parity", { recursive: true });
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const failed = cases.filter((c) => c.failure).length;
    writeFileSync(out,
`<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="equivalence" tests="${cases.length}" failures="${failed}">
${cases.map((c) => c.failure
  ? `    <testcase classname="${esc(c.classname)}" name="${esc(c.name)}">\n` +
    `      <failure message="not equivalent">${esc(c.failure)}</failure>\n    </testcase>`
  : `    <testcase classname="${esc(c.classname)}" name="${esc(c.name)}"/>`).join("\n")}
  </testsuite>
</testsuites>
`);
    console.log(`\n${cases.length - failed}/${cases.length} trace(s) equivalent. Wrote ${out}.`);
    if (failed) {
      console.log(`\nA red trace is a real difference, not a flaky test. Either the rebuild is wrong, ` +
        `or the difference is intended — in which case say so on the record:`);
      console.log(`  npm run equiv -- accept "<trace name>" --reason "..."`);
      console.log(`\`gate.mjs lock gate-5\` refuses while the newest run has a failure no decision names.`);
    }
    process.exit(failed ? 1 : 0);
  }

  // ---- accept -------------------------------------------------------------
  if (cmd === "accept") {
    const trace = process.argv[3];
    const reason = argAfter("--reason");
    if (!trace || trace.startsWith("--") || !reason) {
      console.error('Usage: equiv accept "<trace name>" --reason "..."');
      console.error("The trace name is the `name` attribute in the JUnit output — what `replay` printed.");
      console.error("A reason is required: this is the record that a difference between the old system");
      console.error('and the rebuild is intended. "the test is red" is not a reason; it is the situation.');
      process.exit(1);
    }
    logDecision(`- **${now}** · accepted by ${by}\n  - accepted: \`${trace}\`\n  - ${reason}\n`);
    console.log(`Logged to ${DECISION_LOG}: \`${trace}\` is an accepted difference.`);
    console.log("gate-5 will no longer refuse to lock on it. It stays red in the report, which is " +
      "correct — the difference is real and now it is also explained.");
    process.exit(0);
  }

  // ---- unlock / relock ----------------------------------------------------
  if (cmd === "unlock") {
    const reason = argAfter("--reason");
    if (!reason) {
      console.error('Unlocking requires --reason "..." — it is a formal, logged event, same as a gate reopen.');
      console.error("Say which expectation is changing and why the recorded one was wrong. Remember what a");
      console.error("trace IS: what the old system actually did, captured before the rebuild existed. Changing");
      console.error("it to match the rebuild does not make them equivalent, it makes the evidence agree with");
      console.error("the code — which is the one property this lane exists to have.");
      process.exit(1);
    }
    mkdirSync(EQUIV_DIR, { recursive: true });
    writeFileSync(UNLOCK_FILE,
`# Equivalence traces are temporarily unprotected. Written by scripts/equiv.mjs.
# Re-lock with: npm run equiv -- relock
at: ${now}
by: ${yamlStr(by)}
reason: ${yamlStr(reason)}
`);
    logDecision(`- **${now}** · unlocked by ${by}\n  - ${reason}\n`);
    console.log(`Equivalence traces unlocked. Logged to ${DECISION_LOG}.`);
    console.log(`Make the change, then: npm run equiv -- relock`);
    process.exit(0);
  }

  if (cmd === "relock") {
    const u = readUnlock();
    if (!u) { console.log("Already protected — nothing to re-lock."); process.exit(0); }
    rmSync(UNLOCK_FILE);
    logDecision(`- **${now}** · re-locked by ${by} (was unlocked ${u.at})\n`);
    console.log(`Equivalence traces re-locked. Logged to ${DECISION_LOG}.`);
    process.exit(0);
  }

  console.error('Usage: equiv.mjs status | record <feature-id> | replay <feature-id>|--all | ' +
    'accept "<trace>" --reason "..." | unlock --reason "..." | relock');
  process.exit(1);
}

// Minimal YAML emitter for trace files. Only the shapes a trace holds: scalars, arrays,
// nested maps. Kept here rather than pulling `yaml`'s stringify so the written file's layout
// is stable run to run — a trace is evidence, and a formatter that reflows it on a library
// upgrade would show up as a diff on every trace in the repo.
function toYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  const scalar = (v) => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    const s = String(v);
    return /^[\w./@-]+$/.test(s) && !/^\d+$/.test(s) ? s : JSON.stringify(s);
  };
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return "\n" + value.map((v) => (v !== null && typeof v === "object")
      ? `${pad}- ${toYaml(v, indent + 2).replace(/^\n?/, "").replace(/^\s+/, "")}`
      : `${pad}- ${scalar(v)}`).join("\n");
  }
  if (value !== null && typeof value === "object") {
    const lines = [];
    for (const [k, v] of Object.entries(value)) {
      const key = k === "//" ? "#" : `${k}:`;
      if (k === "//") { lines.push(`${pad}# ${v}`); continue; }
      if (v !== null && typeof v === "object") {
        const rendered = toYaml(v, indent + 2);
        lines.push(rendered.startsWith("\n") ? `${pad}${key}${rendered}` : `${pad}${key} ${rendered}`);
      } else lines.push(`${pad}${key} ${scalar(v)}`);
    }
    return (indent ? "\n" : "") + lines.join("\n") + (indent ? "" : "\n");
  }
  return scalar(value);
}
