// playbook.mjs — architecture-playbook checks shared by validate.mjs and gate.mjs.
// Library, not an entry point.
//
// Zero-dependency by necessity: gate.mjs runs without the workbench's node_modules, same
// constraint as erd.mjs. So the two formats this file reads are parsed by line, not by a
// YAML library, and both are formats this pipeline defines rather than inherits:
//
//   1. `architecture:` in sources.yaml — two scalar keys, one nesting level.
//   2. The frontmatter block of a playbook in references/playbooks/ — scalars, one list,
//      and two single-level maps (`concerns:`, `decide-before:`).
//
// Deliberately NOT a YAML parser, and deliberately not tolerant of clever YAML: anchors,
// folded scalars and flow mappings are not supported anywhere in these two blocks. A
// playbook that needs them is a playbook whose frontmatter has outgrown its job.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every file this module reads is hand-edited, and one of them will be edited on Windows.
 * `split("\n")` on a CRLF file leaves a `\r` on every line, and JS `.` does not match `\r`
 * (it is a line terminator), so a `(.*)$` pattern without `/m` fails on every *value* line
 * while the block *header* still matches — the mechanism then reports "no playbook selected"
 * rather than "unparsable", and every check silently switches off. A review reproduced a
 * gate-3 lock carrying a fabricated `§999` citation that way, from a CRLF `sources.yaml`
 * whose LF twin refused correctly. Normalize once at every read instead of trusting each
 * pattern to be CRLF-safe: `readAdrs` happened to use `/m` and was fine, which is exactly
 * what made the inconsistency invisible.
 */
const stripCR = (s) => s.replace(/\r\n?/g, "\n");
const readText = (p) => stripCR(readFileSync(p, "utf8"));

/** Where G4a vendors the selected playbook. Inside gate-3's `protects:` (`adr/`) on purpose. */
export const VENDORED_PLAYBOOK = "adr/playbook.md";

/** Registry path inside the plugin, for messages only — the workbench never reads it. */
export const REGISTRY_DIR = "skills/rebuild-pipeline/references/playbooks";

/**
 * The playbook a project gets when `sources.yaml` names none. This is not a convenience
 * default: `g4a-architecture.md` step 0.1 and `docs/PLAYBOOK.md` both say an absent or empty
 * `architecture.playbook` resolves here and step 0.3 then vendors it, so treating the blank
 * scaffolded value as "no playbook, run no checks" left the *most common* configuration
 * unenforced while three documents claimed otherwise.
 */
export const DEFAULT_PLAYBOOK = "web-modular-monolith";

/**
 * True for workbenches scaffolded before the playbook registry existed. They get warnings
 * where a new workbench gets errors. Same signal and same reasoning as
 * `erd.isLegacyWorkbench`: `locks/pipeline.yaml`'s schema_version, because `protects:`
 * already covers `adr/` in every workbench ever scaffolded and so cannot tell old from new.
 */
export const isPrePlaybookWorkbench = (root = ".") => {
  const p = join(root, "locks", "pipeline.yaml");
  if (!existsSync(p)) return true;
  const v = (readText(p).match(/^schema_version:\s*"?([\d.]+)"?/m) || [])[1];
  if (!v) return true;
  const [major, minor] = v.split(".").map(Number);
  return major === 0 && minor < 3;
};

const unquote = (s) => s.trim().replace(/^["'](.*)["']$/, "$1").trim();

/**
 * Read `architecture:` out of sources.yaml. An absent block or empty value reads as null
 * here; `checkPlaybook` is what resolves null to `DEFAULT_PLAYBOOK`.
 */
export const readArchitectureConfig = (root = ".") => {
  const p = join(root, "sources.yaml");
  const out = { playbook: null, targetShape: null };
  if (!existsSync(p)) return out;
  const lines = readText(p).split("\n");
  const start = lines.findIndex((l) => /^architecture:\s*$/.test(l));
  if (start === -1) return out;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;            // dedent ends the block
    const m = line.match(/^\s+([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, raw] = m;
    const val = unquote(raw.replace(/\s+#.*$/, ""));
    if (!val) continue;
    if (key === "playbook") out.playbook = val;
    if (key === "target_shape" || key === "target-shape") out.targetShape = val;
  }
  return out;
};

/**
 * Parse a playbook's frontmatter. Returns null when the file has no `---` block at all —
 * which is the one failure worth distinguishing, because it means the file predates the
 * registry (or is not a playbook) rather than being malformed.
 */
export const parsePlaybookMeta = (rawText) => {
  const text = stripCR(rawText);
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const meta = {
    playbook: null, stack: null, targetShape: null, scaffoldProfile: null,
    notApplicableWhen: [], concerns: {}, decideBefore: {},
  };
  let block = null; // "not-applicable-when" | "concerns" | "decide-before"
  for (const raw of m[1].split("\n")) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const top = raw.match(/^([\w-]+):\s*(.*)$/);
    if (top) {
      const [, key, rest] = top;
      const val = unquote(rest);
      block = null;
      if (key === "playbook") meta.playbook = val;
      else if (key === "stack") meta.stack = val;
      else if (key === "target-shape" || key === "target_shape") meta.targetShape = val;
      else if (key === "scaffold-profile") meta.scaffoldProfile = val;
      else if (key === "not-applicable-when") block = "not-applicable-when";
      else if (key === "concerns") block = "concerns";
      else if (key === "decide-before") block = "decide-before";
      continue;
    }
    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && block === "not-applicable-when") { meta.notApplicableWhen.push(unquote(item[1])); continue; }
    const pair = raw.match(/^\s+([\w-]+):\s*(.*)$/);
    if (pair && (block === "concerns" || block === "decide-before")) {
      const value = unquote(pair[2]);
      if (block === "concerns") meta.concerns[pair[1]] = value;
      else meta.decideBefore[pair[1]] = value.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return meta;
};

/**
 * Section numbers the playbook actually declares, read from its own headings
 * (`## 4. Backend`, `### 4.2 Hard Rules for Feature Boundaries`).
 *
 * This exists because the `concerns:` map answers "which section covers this concern" and is
 * NOT the list of sections that exist. Seeding the citation check from the map alone rejected
 * an ADR citing a real section no concern happens to map (§15 Testing Strategy, §19
 * Anti-patterns) and — worse — a *subsection* of a mapped one: `mobile-flutter.md` maps
 * `decomposition: "§2, §4, §20"` and has a `### 4.3` that is the natural thing for that
 * ADR to cite. Both were reported as "the wrong playbook", which is a false accusation.
 */
export const playbookSections = (text) => {
  const out = new Set();
  for (const m of stripCR(text).matchAll(/^#{2,6}\s+(\d+(?:\.\d+)*)[.):]?(?=\s)/gm)) out.add(`§${m[1]}`);
  return out;
};

/** Section tokens a playbook's concerns map cites — where each concern's answer lives. */
export const citedSections = (meta) => {
  const out = new Set();
  for (const v of Object.values(meta?.concerns || {})) {
    for (const tok of String(v).match(/§\s*[\w.]+/g) || []) out.add(tok.replace(/\s+/g, ""));
  }
  return out;
};

const ADR_NON_ADR = new Set(["playbook.md", "README.md", "readme.md"]);

/** Every ADR in adr/, with the two fields the playbook mechanism reads. */
export const readAdrs = (root = ".") => {
  const dir = join(root, "adr");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md") && !ADR_NON_ADR.has(f))
    .map((f) => join(dir, f)).filter((f) => statSync(f).isFile()).sort()
    .map((file) => {
      const text = readText(file);
      const concern = (text.match(/^concern:\s*(.+)$/m) || [])[1];
      const orgDefault = (text.match(/^org-default:\s*(.+)$/m) || [])[1];
      return { file, concern: concern && unquote(concern), orgDefault: orgDefault && unquote(orgDefault) };
    });
};

/**
 * The whole playbook check, in one call so validate.mjs and gate.mjs report identically.
 *
 * `problems` are always wrong. `undecided` is a list of concerns with no ADR — legitimate
 * until Gate 3 is about to lock, so it is returned separately and callers decide when it
 * becomes fatal. Same split as erd.checkDataModel's `missing`.
 */
export const checkPlaybook = (root = ".") => {
  const cfg = readArchitectureConfig(root);
  const vendoredPath = join(root, VENDORED_PLAYBOOK);
  const explicit = cfg.playbook;
  // `none` is the only way to switch the mechanism off — G4a step 0b, every ADR blank-slate.
  // A blank value is NOT that: it resolves to the org default, which is what G4a vendors.
  const disabled = !!explicit && explicit.toLowerCase() === "none";
  const res = {
    explicit,
    selected: disabled ? null : (explicit || DEFAULT_PLAYBOOK),
    selectedBy: disabled ? "none" : (explicit ? "sources.yaml" : "default"),
    disabled,
    targetShape: cfg.targetShape,
    vendored: existsSync(vendoredPath) ? VENDORED_PLAYBOOK : null,
    meta: null, problems: [], missingVendored: false, undecided: [], adrs: readAdrs(root),
  };
  if (disabled) return res;
  // Absence is reported separately from `problems` because it is legitimate for most of a
  // project's life: G4a vendors the copy, and everything before G4a validates without it.
  // Callers decide when it becomes fatal — same split as `erd.checkDataModel`'s `missing`.
  if (!res.vendored) { res.missingVendored = true; return res; }
  // `architecture.playbook` may name a registry entry (`mobile-flutter`) or a path to one the
  // user wrote (`playbooks/ours.md`). The vendored file's own `playbook:` is always the bare
  // name, so compare on the bare name or a path-selected playbook reports a mismatch with
  // itself — which would make the user-written case unusable, the case the registry exists for.
  const selectedName = res.selected.replace(/\.md$/i, "").split("/").pop();
  const vendoredText = readText(vendoredPath);
  const meta = parsePlaybookMeta(vendoredText);
  if (!meta) {
    res.problems.push(`${VENDORED_PLAYBOOK} has no frontmatter block — it is not a registry playbook`);
    return res;
  }
  res.meta = meta;
  if (meta.playbook && meta.playbook !== selectedName) {
    res.problems.push(`${VENDORED_PLAYBOOK} declares playbook "${meta.playbook}" but sources.yaml selects "${res.selected}"`);
  }
  if (!Object.keys(meta.concerns).length) {
    res.problems.push(`${VENDORED_PLAYBOOK} declares no concerns: map — G4a has nothing to walk`);
  }
  if (cfg.targetShape && meta.targetShape && cfg.targetShape !== meta.targetShape) {
    res.problems.push(`target shape mismatch: sources.yaml says "${cfg.targetShape}", ` +
      `playbook "${meta.playbook}" serves "${meta.targetShape}"`);
  }

  // Legal citations = the sections the map points at, PLUS every section the playbook
  // actually declares. See `playbookSections` for why the map alone is the wrong authority.
  const legal = new Set([...citedSections(meta), ...playbookSections(vendoredText)]);
  const sectionIsKnown = (tok) => {
    // A subsection of a real section is real: `§4.2.1` is satisfied by a known `§4.2` or `§4`.
    const parts = tok.replace(/^§/, "").split(".");
    for (let n = parts.length; n > 0; n--) if (legal.has(`§${parts.slice(0, n).join(".")}`)) return true;
    return false;
  };
  const decided = new Set();
  for (const adr of res.adrs) {
    if (!adr.concern) {
      res.problems.push(`${adr.file}: no \`concern:\` field — cannot tell which playbook concern it decides`);
      continue;
    }
    decided.add(adr.concern);
    if (!(adr.concern in meta.concerns)) {
      res.problems.push(`${adr.file}: concern "${adr.concern}" is not in ${VENDORED_PLAYBOOK}'s concerns map`);
    }
    if (!adr.orgDefault) {
      res.problems.push(`${adr.file}: no \`org-default:\` field (use N/A for a concern with no default)`);
      continue;
    }
    // `/^n\/a\b/` not `/^n\/a$/`: the ADR template presents this field as
    // "<cited section(s) …, or N/A where it has no answer>", so a drafter writing
    // `N/A — the reference schema is the only axis` is the expected output, not a deviation.
    // `\b` still rejects `N/Applicable`, which is not this field's vocabulary.
    if (/^n\/a\b/i.test(adr.orgDefault)) continue;
    const cited = (adr.orgDefault.match(/§\s*[\w.]+/g) || []).map((t) => t.replace(/\s+/g, ""));
    if (!cited.length) {
      res.problems.push(`${adr.file}: org-default "${adr.orgDefault}" cites no § section and is not N/A`);
      continue;
    }
    for (const tok of cited) {
      if (!sectionIsKnown(tok)) {
        res.problems.push(`${adr.file}: org-default cites ${tok}, which ${VENDORED_PLAYBOOK} ` +
          `has no such section for (checked against its headings and its concerns map) — ` +
          `a stale citation, or the wrong playbook`);
      }
    }
  }
  for (const concern of Object.keys(meta.concerns)) {
    if (!decided.has(concern)) res.undecided.push(concern);
  }
  return res;
};

/** One-line remedy, shared so both scripts say the same thing. */
export const PLAYBOOK_REMEDY =
  `At G4a entry, copy the playbook named by sources.yaml's architecture.playbook from the ` +
  `plugin's ${REGISTRY_DIR}/ to ${VENDORED_PLAYBOOK}, then draft one ADR per concern in its ` +
  `concerns: map, each declaring \`concern:\` and \`org-default:\` (see references/g4a-architecture.md).`;
