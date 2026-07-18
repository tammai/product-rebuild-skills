#!/usr/bin/env node
// rebuild-init.mjs — scaffold a workbench repo for a product rebuild project.
// Usage: node rebuild-init.mjs <project-name> [--dir <parent-dir>]
// Zero-dependency: uses only node:fs / node:path / node:child_process.

import { mkdirSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS = join(HERE, "..", "schemas");

const args = process.argv.slice(2);
const name = args[0];
if (!name || name.startsWith("--")) {
  console.error("Usage: node rebuild-init.mjs <project-name> [--dir <parent-dir>]");
  process.exit(1);
}
const dirFlag = args.indexOf("--dir");
const parent = dirFlag !== -1 ? args[dirFlag + 1] : process.cwd();
const root = join(parent, `${name}-workbench`);
if (existsSync(root)) {
  console.error(`Refusing to overwrite existing directory: ${root}`);
  process.exit(1);
}

const dirs = [
  "findings/ground-truth", "findings/feature", "findings/nfr", "findings/flow",
  "matrix", "plan", "adr", "contracts/openapi", "contracts/internal",
  "contracts/asyncapi", "locks", "parity", "schemas", "scripts",
  ".github/workflows",
];
for (const d of dirs) mkdirSync(join(root, d), { recursive: true });

// Pin schemas + tooling scripts into the workbench (self-contained, versioned copy).
cpSync(SCHEMAS, join(root, "schemas"), { recursive: true });
for (const s of ["validate.mjs", "gate.mjs", "parity.mjs"]) {
  cpSync(join(HERE, s), join(root, "scripts", s));
}

const write = (p, c) => writeFileSync(join(root, p), c.trimStart());

write("sources.yaml", `
# What agents may read. Derived from license-posture.md — keep them consistent.
project: ${name}
reference:
  name: ""            # e.g. openproject
  repo: ""            # clone URL; leave empty in clean-room mode
  pinned_commit: ""   # fill after first clone; all lane-D evidence uses this
  license: ""         # e.g. GPL-3.0, MIT
allowed:
  - ""                # docs base URL, changelog URL, running-instance URL...
denied:
  - ""                # explicit deny list (e.g. the repo itself in clean-room mode)
`);

write("license-posture.md", `
# License posture — decide BEFORE mining

status: draft   # draft | decided

## Reference license
<!-- e.g. GPL-3.0 -->

## Distribution intent
<!-- private-learning | possible-closed-distribution | permissive-reference -->

## Consequence for lane D (ground truth)
<!-- full source access | clean-room: behavior/docs/API only -->

## Rationale
<!-- Why this posture. Note: this playbook is process, not legal advice. -->
`);

write("repos.yaml", `
# Code repos consuming this workbench (fill after Gate 3).
# Each pins the workbench as a read-only submodule at a gate-4 tag.
repos: []
`);

const gates = [
  ["gate-1", "Taxonomy lock",     ["matrix/features.yaml"]],
  ["gate-2", "Slice-plan lock",   ["plan/slices.yaml"]],
  ["gate-3", "Architecture lock", ["adr/"]],
  ["gate-4", "Contract lock",     ["contracts/"]],
  ["gate-5", "Prod-ready lock",   ["parity/production-readiness.md"]],
];
for (const [id, title, protects] of gates) {
  write(`locks/${id}.yaml`, `
gate: ${id}
title: ${title}
status: open
protects:
${protects.map((p) => `  - ${p}`).join("\n")}
history: []
`);
}
write("locks/pipeline.yaml", `
# Marker + metadata for orchestrator state detection. Do not edit by hand.
project: ${name}
schema_version: "0.1.0"
created: ${new Date().toISOString()}
`);

write("package.json", JSON.stringify({
  name: `${name}-workbench`,
  private: true,
  type: "module",
  scripts: {
    validate: "node scripts/validate.mjs",
    gate: "node scripts/gate.mjs",
    parity: "node scripts/parity.mjs",
  },
  devDependencies: { ajv: "^8.17.0", "ajv-formats": "^3.0.0", yaml: "^2.5.0" },
}, null, 2) + "\n");

write(".github/workflows/validate.yml", `
name: validate-workbench
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci || npm install
      - run: npm run validate
`);

write(".gitignore", "node_modules/\n");

write("README.md", `
# ${name} — rebuild workbench

Pipeline state store for the ${name} rebuild. Describes the product; never contains
product code. Managed by the \`rebuild-pipeline\` skill (product-rebuild-skills plugin).

- \`npm run validate\` — schema-validate all artifacts
- \`npm run gate -- status\` — pipeline/gate state
- Decision history = \`git log\` on adr/, locks/, matrix/
`);

try { execSync("git init -q && git add -A && git commit -qm 'workbench: scaffold'", { cwd: root }); }
catch { console.warn("git init skipped (git unavailable?) — initialize manually."); }

console.log(`Workbench created: ${root}`);
console.log("Next: npm install, then fill sources.yaml and license-posture.md (G0).");
