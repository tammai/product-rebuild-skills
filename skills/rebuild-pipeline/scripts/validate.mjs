#!/usr/bin/env node
// validate.mjs — schema-validate all workbench artifacts. Run from the workbench root.
// Requires ajv, ajv-formats and yaml from the workbench's own `npm install`. The plugin
// ships no dependencies, so running the plugin's copy of this file cannot work.
// Checks, in order:
//   1. Every findings/**.yaml against finding.schema.json (+ evidence rule)
//   2. matrix/features.yaml against feature.schema.json
//   3. plan/slices.yaml against slice.schema.json (+ acyclic dependencies)
//   4. plan/progress.yaml against progress.schema.json (+ ids must exist upstream)
//   5. contracts/**.yaml structural checks — YAML validity, duplicate keys, and every
//      $ref resolving. G5 generates code from these; nothing else in this pipeline
//      checked them, so a dangling $ref first surfaced as a codegen failure in a code
//      repo, one gate lock too late.
//   6. contracts/data-model/*.mermaid — every diagram declares entities; one must exist
//      once gate-4 is locked
//   7. locks/gate-*.yaml against lock.schema.json
//   8. Locked-gate hash consistency: protected files must match recorded hashes

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
// schema and the file are present.
if (existsSync(join("schemas", "progress.schema.json"))) {
  validators.progress = ajv.compile(schema("progress.schema.json"));
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

for (const f of yamlFilesUnder("findings")) {
  if (f.endsWith("nfr-profile.yaml")) { ok(f + " (profile, free-form)"); continue; }
  check(f, validators.finding);
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
