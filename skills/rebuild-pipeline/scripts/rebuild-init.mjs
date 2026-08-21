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
  "matrix", "plan", "adr", "contracts/data-model", "contracts/openapi",
  "contracts/internal", "contracts/asyncapi", "locks", "parity", "parity/flows",
  "schemas", "scripts",
  ".github/workflows",
];
for (const d of dirs) mkdirSync(join(root, d), { recursive: true });

// Pin schemas + tooling scripts into the workbench (self-contained, versioned copy).
cpSync(SCHEMAS, join(root, "schemas"), { recursive: true });
for (const s of ["validate.mjs", "gate.mjs", "parity.mjs", "pause-check.mjs", "erd.mjs",
                 "playbook.mjs", "basis.mjs", "autopilot.mjs"]) {
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
  kind: ""            # third-party | own-code (an app you already own and are replacing)
  upstream: ""        # active | frozen — frozen turns off G6's upstream re-mine
# Which architecture playbook G4a decides against, and what this rebuild's output IS.
# Read by G4a (which vendors the playbook to adr/playbook.md and hashes it into Gate 3),
# by G4b, G5 and GP. Leave playbook empty for the org default; \`none\` disables the
# mechanism and makes every ADR a blank-slate decision against the reference.
architecture:
  playbook: ""        # e.g. web-modular-monolith | mobile-flutter | playbooks/ours.md | none
  target_shape: ""    # fullstack | client-only (client-only = the API already exists and stays)
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
# Populate as each repo is created — scripts/pause-check.mjs reads this to know which
# repos to check for uncommitted or unpushed work before a session pauses. A repo missing
# from this list is invisible to it and never checked. Format:
#   repos:
#     - name: <repo-name>
#       path: ../<repo-name>   # relative to this workbench's own root
repos: []
`);

// Not a stub diagram, on purpose. A scaffolded `erDiagram` with no entities would satisfy
// every check written against it, so the scaffold ships the format instead — and the
// directory stays empty of .mermaid files until someone drafts one, which is exactly the
// state gate.mjs refuses to lock. (A file is also the only way the directory survives a
// clone: git does not track empty directories.)
write("contracts/data-model/README.md", `
# Data model — one Mermaid \`erDiagram\` per bounded context

Drafted in **G4b, before the three contract layers**: Gate 3 decided where data lives,
this decides what it is. Locked by **Gate 4** along with the rest of \`contracts/\`.

## Convention

\`contracts/data-model/<context>.mermaid\` — one file per bounded context, named after the
context as it appears in the G4a context map. Per context: entities, ownership,
relationships, source-of-truth per entity. Cross-context references by **ID only, never
shared tables** — a relationship line that crosses a context boundary belongs in neither
file and is a Gate 3 question, not a Gate 4 one.

\`\`\`mermaid
erDiagram
    PROJECT ||--o{ WORK_PACKAGE : contains
    WORK_PACKAGE {
        uuid id PK
        uuid project_id FK
        string subject
    }
\`\`\`

## What is checked

\`npm run validate\` requires every \`.mermaid\` here to declare **at least one entity** —
an \`erDiagram\` header alone is not a data model. \`npm run gate -- lock gate-4\` refuses
to lock while this directory holds no diagram. Neither is a Mermaid validator, and neither
can check that the model is *right*: that is the Gate 4 coherence review (every API
resource maps to an entity or a declared projection; every entity is reachable from the
API or annotated \`%% internal\`).

Annotate every deliberate deviation from the reference's schema
(\`findings/ground-truth/reference-erd.mermaid\`) inline with \`%%\` — deviations change how
reference behavior maps onto the rebuild, and a structural one needs an ADR at Gate 3.

Keep this file, or delete it once the first real diagram lands — but delete it **before**
Gate 4 locks. Gate 4 hashes everything under \`contracts/\`, so removing it afterwards
fails \`npm run validate\` with \`locked file missing\` and needs a gate reopen to undo.
`);

write("parity/flows/README.md", `
# AC flows — the acceptance-criteria suite

One directory per feature, one flow file per acceptance criterion:
\`parity/flows/<feature-id>/<criterion>.yaml\`.

**Only populated under a playbook that says so** — today that is
\`playbooks/mobile-flutter.md\` §15 (a \`client-only\` mobile rebuild whose legacy app still
runs), where the flows are [Maestro](https://maestro.dev) YAML. Other target shapes keep
their AC suite in the code repo with the code it tests, and this directory stays empty.

## Why the flows live in the workbench and not in the code repo

They describe the **product** — what a user does and what must be true afterwards — which is
this repo's charter. Code repos reach them through the submodule pin they already have, and
that pin does the versioning for free: a repo checked out at \`gate-4/v1\` sees exactly the
flows that existed at that tag.

## Recorded against the legacy app FIRST

This is what makes the suite a characterization harness rather than a test suite that agrees
with whatever got built. Maestro drives the compiled binary through the accessibility layer,
so it is framework-agnostic: a flow recorded against the old app replays unchanged against the
rebuild, provided both expose the same selector strings (the selector inventory is mined at G1
— see \`g1-mining.md\`). \`g5-build.md\`'s per-slice step 0 refuses to start a slice whose flows
are missing or red against the legacy app.

A flow that genuinely cannot be recorded against the reference says so in its own header. It
is then a normal test, not parity evidence.

## The one rule with teeth

> **An assertion in a recorded flow changes only with a logged human decision.**

These files are deliberately NOT hashed into a gate — flows are recorded per slice, and
hash-locking them would mean a formal gate reopen every slice. The rule is the substitute, and
it is the same register as a reopen: a human decides, the reason is written down.

Freely allowed: new flows, new assertions, fixing a selector that never matched, deleting a
flow for a dropped feature. Needs the logged decision: **weakening or removing an assertion
that has ever been green against the legacy app.** An agent that loosens an assertion to make
a build pass has silently redefined parity, and the report still reads green.

## Running it

\`\`\`sh
maestro test parity/flows --format junit --output parity/$(date -u +%F)-ac.xml
npm run parity     # reads that XML and puts the AC pass rate in parity/<date>.md
\`\`\`

Maestro needs macOS or Linux (WSL on Windows). Android runs headless in CI; iOS runs on
simulators only, so the iOS leg needs a Mac runner.
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
# 0.2.0 added contracts/data-model/ as a checked artifact; 0.3.0 added the architecture
# playbook (sources.yaml architecture.playbook -> adr/playbook.md, one ADR per concern in
# its concerns: map). Scripts read this to decide whether a gap is an error (that version or
# newer) or a warning (older workbenches, which cannot be retro-enforced). Bump it by hand
# after backfilling.
schema_version: "0.3.0"
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
    "pause-check": "node scripts/pause-check.mjs",
    autopilot: "node scripts/autopilot.mjs",
  },
  devDependencies: { ajv: "^8.17.0", "ajv-formats": "^3.0.0", yaml: "^2.5.0" },
}, null, 2) + "\n");

write(".github/workflows/validate.yml", `
name: validate-workbench
# Unfiltered on purpose: every branch and every tag gets validated, whatever the default
# branch is called. Tags matter specifically — gate.mjs mints gate-N/vN tags that code repos
# consume as submodule pins. If you ever add a \`branches\`/\`branches-ignore\` filter here,
# add \`tags: ['**']\` alongside it: a push trigger carrying only branch filters silently
# stops firing on tag pushes, which would leave those pins unvalidated.
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

- \`npm run validate\` — schema-validate all artifacts, and structurally check
  \`contracts/\` (YAML validity, duplicate keys, every \`$ref\` resolving; every
  \`data-model/*.mermaid\` declaring entities; every ADR naming a concern its playbook maps)
- \`npm run gate -- status\` — pipeline/gate state
- \`npm run pause-check\` — safe to stop and resume in a new session? (also reports what has
  not been pushed yet)
- \`npm run autopilot -- preflight\` — is this project ready to run unattended between gates?
  (\`check\` / \`engage\` / \`log\` / \`disengage\` / \`status\` drive a run; gates always halt for you)
- Decision history = \`git log\` on adr/, locks/, matrix/

## Keep it off-machine

This workbench is the only copy of decisions that are NOT reproducible from the reference
product — the taxonomy, the ADRs, the gate history. Give it a remote early:

\`\`\`sh
gh repo create ${name}-workbench --private --source . --push
\`\`\`

Pushing is manual. \`npm run pause-check\` tells you when something has not left the machine;
run it before you stop for the day.

After every \`npm run gate -- lock <gate-id>\`, push the tag too: \`git push && git push --tags\`.
\`git push\` sends no tags, and gate tags are submodule pins that code repos check out by name —
one that stays local either breaks their checkout or leaves them on the previous contract.
`);

try { execSync("git init -q && git add -A && git commit -qm 'workbench: scaffold'", { cwd: root }); }
catch { console.warn("git init skipped (git unavailable?) — initialize manually."); }

console.log(`Workbench created: ${root}`);
console.log("Next: npm install, then fill sources.yaml and license-posture.md (G0).");
console.log("Then give it a remote — this scaffold is currently the only copy:");
console.log(`  gh repo create ${name}-workbench --private --source . --push`);
