#!/usr/bin/env node
// validate.mjs — schema-validate all workbench artifacts. Run from the workbench root.
// Requires devDependencies (ajv, ajv-formats, yaml) — installed by `npm install`.
// Checks, in order:
//   1. Every findings/**.yaml against finding.schema.json (+ evidence rule)
//   2. matrix/features.yaml against feature.schema.json
//   3. plan/slices.yaml against slice.schema.json (+ acyclic dependencies)
//   4. locks/gate-*.yaml against lock.schema.json
//   5. Locked-gate hash consistency: protected files must match recorded hashes

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { parse } from "yaml";

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const schema = (n) => JSON.parse(readFileSync(join("schemas", n), "utf8"));
const validators = {
  finding: ajv.compile(schema("finding.schema.json")),
  feature: ajv.compile(schema("feature.schema.json")),
  slice: ajv.compile(schema("slice.schema.json")),
  lock: ajv.compile(schema("lock.schema.json")),
};

let failures = 0;
const fail = (file, msg) => { failures++; console.error(`FAIL ${file}\n  ${msg}`); };
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
if (existsSync("matrix/features.yaml")) check("matrix/features.yaml", validators.feature);
if (existsSync("plan/slices.yaml")) {
  const slices = check("plan/slices.yaml", validators.slice);
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
