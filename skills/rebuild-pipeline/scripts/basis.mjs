// basis.mjs — evidence-basis checks shared by validate.mjs and parity.mjs. Library, not an
// entry point. Needs the workbench's `yaml` dependency; gate.mjs never imports it, so unlike
// erd.mjs this one is allowed a dependency.
//
// `basis` answers a different question from `confidence`, and conflating them is the mistake
// this field exists to stop. `confidence` is the MINER's certainty. `basis` is WHERE THE FACT
// CAME FROM. A route transcribed from a migration file at the pinned commit and a route
// inferred from a docs page can both be recorded `confidence: high` — the miner is equally
// sure in both cases — and G4b should not treat them the same when it freezes a contract.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/** Where a fact came from. Orthogonal to `confidence`. */
export const BASIS_VALUES = ["transcribed", "observed", "inferred"];

/** One line each, so every file that explains this says the same thing. */
export const BASIS_MEANING = {
  transcribed: "copied from the reference's source at the pinned commit (schema files, route tables, call sites)",
  observed: "seen at runtime on the running reference or a device restored from a real backup",
  inferred: "derived from docs, changelogs, API responses, or reasoning",
};

/**
 * True for workbenches scaffolded before `basis` became a required field. They get warnings
 * where a new workbench gets errors — the same treatment, and the same signal
 * (`locks/pipeline.yaml`'s schema_version), that erd.mjs and playbook.mjs use.
 *
 * The grace this encodes is real rather than calendar-based: a project mid-mining when this
 * landed has findings written under the old rule, and the non-goal was always "no backfill".
 */
export const isPreBasisWorkbench = (root = ".") => {
  const p = join(root, "locks", "pipeline.yaml");
  if (!existsSync(p)) return true;
  const v = (readFileSync(p, "utf8").match(/^schema_version:\s*"?([\d.]+)"?/m) || [])[1];
  if (!v) return true;
  const [major, minor] = v.split(".").map(Number);
  return major === 0 && minor < 4;
};

/** Every schema-validated finding file. `nfr-profile.yaml` is free-form and excluded. */
export const findingFiles = (root = ".") => {
  const dir = join(root, "findings");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile() && !f.endsWith("nfr-profile.yaml"))
    .sort();
};

/** Parse one findings file into an array, tolerating anything that is not one. */
const readFindings = (file) => {
  let data;
  try { data = parse(readFileSync(file, "utf8")); } catch { return null; }
  return Array.isArray(data) ? data : null;
};

/**
 * Per-file basis coverage. `unparseable` and non-array files are skipped rather than
 * reported — their own schema pass in validate.mjs already owns that failure, and reporting
 * it twice trains people to read one of the two messages as noise.
 */
export const checkBasis = (root = ".") => {
  const files = [];
  let totalEvidence = 0, totalMissing = 0, anyBasis = false;
  for (const file of findingFiles(root)) {
    const findings = readFindings(file);
    if (!findings) continue;
    let evidence = 0, missing = 0;
    const ids = [];
    for (const f of findings) {
      for (const e of Array.isArray(f?.evidence) ? f.evidence : []) {
        evidence++;
        if (e && typeof e === "object" && BASIS_VALUES.includes(e.basis)) anyBasis = true;
        else { missing++; if (f?.id && !ids.includes(f.id)) ids.push(f.id); }
      }
    }
    if (!evidence) continue;
    files.push({ file, evidence, missing, findingIds: ids });
    totalEvidence += evidence; totalMissing += missing;
  }
  return { files, totalEvidence, totalMissing, anyBasis };
};

/**
 * Join the feature matrix to the findings that back it, then report the basis behind each
 * feature. A feature whose ONLY basis is `inferred` is the weakest parity claim in the
 * report — nobody transcribed it from source and nobody watched it happen.
 *
 * The join is the awkward part and it is worth being explicit about, because a silent one
 * would be worse than none. `feature.evidence` is an array of free-text pointers (the schema
 * says `string`), so three matches are tried per pointer, in order: the pointer IS a finding
 * id; the pointer equals a finding evidence `url` or `path`; a `[a-z0-9-]+` token inside the
 * pointer is a finding id. Anything that matches nothing is counted and REPORTED as unjoined
 * rather than quietly treated as "not inferred" — a zero that came from a failed join reads
 * exactly like a clean bill of health, which is the one thing this must not do.
 */
export const featureBasis = (root = ".") => {
  const byId = new Map(), byPointer = new Map();
  for (const file of findingFiles(root)) {
    for (const f of readFindings(file) || []) {
      if (!f?.id) continue;
      const bases = (Array.isArray(f.evidence) ? f.evidence : [])
        .map((e) => e?.basis).filter((b) => BASIS_VALUES.includes(b));
      const rec = { id: f.id, bases };
      byId.set(f.id, rec);
      for (const e of Array.isArray(f.evidence) ? f.evidence : []) {
        if (e?.url) byPointer.set(String(e.url), rec);
        if (e?.path) byPointer.set(String(e.path), rec);
      }
    }
  }

  const matchesFor = (pointers) => {
    const hits = new Map();
    for (const raw of pointers) {
      const p = String(raw ?? "").trim();
      if (!p) continue;
      const direct = byId.get(p) || byPointer.get(p);
      if (direct) { hits.set(direct.id, direct); continue; }
      for (const tok of p.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) || []) {
        const rec = byId.get(tok);
        if (rec) hits.set(rec.id, rec);
      }
    }
    return [...hits.values()];
  };

  return (features) => {
    const inferredOnly = [], unjoined = [];
    for (const f of features) {
      const matched = matchesFor([
        ...(Array.isArray(f.evidence) ? f.evidence : []),
        ...(Array.isArray(f.flows) ? f.flows : []),
        ...(Array.isArray(f.history?.evidence) ? f.history.evidence : []),
      ]);
      if (!matched.length) { unjoined.push(f); continue; }
      const bases = new Set(matched.flatMap((m) => m.bases));
      if (!bases.size) continue;                       // findings predate the field — say nothing
      if (bases.size === 1 && bases.has("inferred")) inferredOnly.push(f);
    }
    return { inferredOnly, unjoined };
  };
};

/** One-line remedy, shared so every caller says the same thing. */
export const BASIS_REMEDY =
  `Add \`basis:\` to each evidence entry — ${BASIS_VALUES.join(" | ")} ` +
  `(see references/g1-mining.md, "Where a fact came from"). It records the SOURCE of the fact, ` +
  `not the miner's certainty; \`confidence\` still does that.`;
