// erd.mjs — data-model checks shared by validate.mjs and gate.mjs. Library, not an entry point.
// Zero-dependency by necessity: gate.mjs runs without the workbench's node_modules.
//
// Deliberately NOT a Mermaid parser. It answers the two questions Gate 4 actually gates
// on — is there a data model at all, and does it declare entities — because the failure
// worth catching is a scaffold stub. A file containing the word `erDiagram` and nothing
// else satisfies "has an erDiagram block" forever, so that check alone can never fail.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** Directory holding one Mermaid erDiagram per bounded context. */
export const DATA_MODEL_DIR = "contracts/data-model";

/**
 * True for workbenches scaffolded before the data model became a checked artifact.
 * They get warnings where a new workbench gets errors.
 *
 * The signal is `locks/pipeline.yaml`, not gate-4's `protects:`. Every workbench ever
 * scaffolded protects `contracts/` wholesale and gate.mjs hashes every file beneath it,
 * so `protects` already covers the new file everywhere and cannot tell old from new.
 */
export const isLegacyWorkbench = (root = ".") => {
  const p = join(root, "locks", "pipeline.yaml");
  if (!existsSync(p)) return true;
  const v = (readFileSync(p, "utf8").match(/^schema_version:\s*"?([\d.]+)"?/m) || [])[1];
  if (!v) return true;
  const [major, minor] = v.split(".").map(Number);
  return major === 0 && minor < 2;
};

// An entity reference: a bare name, a quoted name, or either carrying a display alias
// (`PROJECT["Project"]`). The alias form is valid Mermaid and a hand-written diagram is
// where it shows up — a pattern that misses it reports "declares no entities" on a correct
// file, which blocks a gate lock. A check with false positives on legitimate work gets
// disabled within a week, so it has to match what people actually write.
const NAME = String.raw`(?:[A-Za-z_][\w-]*|"[^"]+")(?:\[[^\]]*\])?`;
// `CUSTOMER ||--o{ ORDER : places` — the cardinality token is what marks a relationship.
const REL = new RegExp(String.raw`^\s*(${NAME})\s*([|}o{<>.-]{3,})\s*(${NAME})\s*:`);
// `CUSTOMER {` opens an attribute block.
const BLOCK = new RegExp(String.raw`^\s*(${NAME})\s*\{\s*$`);
// Entities are keyed by name, so the alias must not make `PROJECT` and `PROJECT["x"]` two.
const entityName = (s) => s.replace(/\[[^\]]*\]$/, "");

/**
 * Read one .mermaid file. Returns the entity names it declares, how many relationships
 * it draws, and any problems. Unrecognized lines (`direction`, `title`, frontmatter) are
 * ignored rather than reported — this is a floor check, not a linter.
 */
export const readErd = (file) => {
  const problems = [], entities = new Set();
  let relationships = 0, inBlock = false, sawHeader = false;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.replace(/%%.*$/, ""); // Mermaid comment
    if (!line.trim()) continue;
    if (inBlock) { if (/^\s*\}/.test(line)) inBlock = false; continue; }
    if (/^\s*erDiagram\b/.test(line)) { sawHeader = true; continue; }
    const rel = line.match(REL);
    if (rel) { entities.add(entityName(rel[1])); entities.add(entityName(rel[3])); relationships++; continue; }
    const block = line.match(BLOCK);
    if (block) { entities.add(entityName(block[1])); inBlock = true; }
  }
  if (!sawHeader) problems.push("no `erDiagram` block");
  else if (!entities.size) problems.push("`erDiagram` block declares no entities");
  return { entities, relationships, problems };
};

/**
 * Check every data model in the workbench. `missing` is reported separately from
 * `problems` because an absent data model is legitimate until Gate 4 — callers decide
 * when it becomes fatal.
 */
export const checkDataModel = (root = ".") => {
  const dir = join(root, DATA_MODEL_DIR);
  const files = existsSync(dir)
    ? readdirSync(dir, { recursive: true }).map(String)
        .filter((f) => f.endsWith(".mermaid"))
        .map((f) => join(dir, f)).filter((f) => statSync(f).isFile()).sort()
    : [];
  const problems = [], perFile = [];
  for (const f of files) {
    const r = readErd(f);
    perFile.push({ file: f, ...r });
    for (const p of r.problems) problems.push(`${f}: ${p}`);
  }
  return { files, perFile, problems, missing: files.length === 0 };
};

/** One-line remedy, shared so both scripts say the same thing. */
export const DATA_MODEL_REMEDY =
  `Draft the data model first: one Mermaid erDiagram per bounded context at ` +
  `${DATA_MODEL_DIR}/<context>.mermaid (see contracts/data-model/README.md).`;
