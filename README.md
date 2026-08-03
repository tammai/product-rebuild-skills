# product-rebuild-skills

A Claude Code plugin for rebuilding an existing product end-to-end — to learn the full
product development lifecycle by doing it. Point it at a reference product (usually OSS:
OpenProject, Twenty CRM, Webstudio, or a category like "CRM"), and it drives a gated
pipeline from feature mining to a verified, production-ready codebase.

**You interact with one thing only: the `rebuild-pipeline` skill** (or the `/rebuild`
command). It detects where the project stands, reports progress, dispatches subagents
for parallel work, and stops at every gate to ask for your decision. You never need to
remember phase mechanics or file formats.

The full methodology and its rationale live in [`docs/PLAYBOOK.md`](docs/PLAYBOOK.md).

## The pipeline in one picture

![Rebuild pipeline: G0 reference/license posture, into G1 parallel mining (ground truth, features, NFR, UX flows), into G2 feature matrix, Gate 1 taxonomy lock, G3 milestone slicing, Gate 2 slice-plan lock, G4a system design, Gate 3 architecture lock, G4b data model + contracts, Gate 4 contract lock, into G5 parallel build per slice (specs+AC, backend, frontend, infra) repeating per slice, into G6 parity loop, into GP production readiness, Gate 5 prod-ready lock.](docs/img/pipeline.png)

Green is parallel or automated work; amber is a gate — a human decision. Grey phases
are yours to drive with the skill's help.

Two ideas carry everything:

1. **Artifacts, not vibes.** Every phase reads and writes schema-validated files in a
   dedicated *workbench repo* — the pipeline's state store. `git log` on it is your
   project's decision history.
2. **Gates, not momentum.** Five points where the pipeline deliberately stops for a
   human decision. Between gates, work fans out to parallel agents. Locked artifacts
   are enforced — a hook physically blocks edits to them.

## Install

```bash
# add this repo as a marketplace, then install the plugin from it
/plugin marketplace add tammai/product-rebuild-skills
/plugin install product-rebuild-skills@product-rebuild-skills

# or for local development, point at your working copy instead:
/plugin marketplace add /path/to/product-rebuild-skills
```

Requires Node.js ≥ 20 (scaffold and gate scripts), git, and Docker (you will run the
reference product locally — it's mandatory, not optional).

## Walkthrough: start to finish

### 1. Start

In any directory, say **"start a rebuild project"** or run `/rebuild`. The skill
interviews you:

- **Which reference?** Name a product, or a category — it will propose candidates and
  compare them on domain fit, codebase readability, and upstream activity.
- **Distribution intent?** This decides the *license posture*: private learning allows
  reading any OSS source; possible closed-source distribution later means clean-room
  treatment of copyleft references (behavior/docs/API only, no code reading). Recorded
  in `license-posture.md` before anything is mined.

It then scaffolds your **workbench** (`<name>-workbench/`): the directory tree, schemas,
gate files (all open), validation scripts, and CI. Run `npm install` inside it once.

### 2. Mining (G1) — mostly hands-off

The skill dispatches miner agents in parallel across four lanes: **ground truth** (the
reference's actual schema, routes, permissions, jobs — when the license posture allows),
**features** (changelogs, docs), **NFR** (how it behaves running), **UX flows** (how key
features actually work). Your two jobs: get the reference running locally, and verify
the drafted UX flows against it when asked. Every finding carries evidence or it gets
rejected at validation.

### 3. Gates 1–2: shape the map, order the work

- **Gate 1 (taxonomy):** the skill proposes how features group into domains — this
  becomes your bounded contexts. You adjust and approve.
- **Gate 2 (slice plan):** everything will be built (that's the point), so you decide
  *order*: vertical slices, dependency-sorted, weighted toward the lifecycle lessons you
  want first (first deploy, first live migration, first background job...). Every slice
  ends deployed.

At every gate the skill presents a review — what locks, the judgment calls, the risks —
and locks only on your explicit yes: `npm run gate -- lock gate-N` under the hood.

### 4. Gates 3–4: the learning core

- **Gate 3 (architecture):** decomposition, auth, events, storage, background workers,
  and observability start from the org's default architecture
  ([`references/architecture-default.md`](skills/rebuild-pipeline/references/architecture-default.md)
  — Go + Nuxt modular monolith, API-first, by default). Agents draft an ADR per concern
  proposing to mirror that default, and only argue for diverging from it when this
  product's shape gives a concrete reason — the reference's own architecture is recorded
  for the learning record, but doesn't drive this decision. Tenancy, search, and backend
  caching have no org default at all, though, and stay fully open — mirror-or-diverge
  against the reference, decided from scratch like everything else in the pipeline. You
  decide each ADR. *Undocumented* divergence — from the default where one exists, from
  the reference otherwise — is the failure mode the format prevents. Only after this gate
  do code repos get created — their count is an output of your decomposition decision.
  Each pins the workbench as a read-only submodule at gate tags.
- **Gate 4 (contracts):** data model first — one Mermaid ERD per bounded context, checked
  for entities and required before the gate can lock — then three interface layers (public
  API, internal, async/events). Locking cuts the tag your code repos build against.

### 5. Build (G5) — the steady-state loop

Per slice: spec agents write module specs ending in **acceptance criteria** (each one an
observable behavior mapping to exactly one test) — you review specs before code — then
backend/frontend/infra lanes build in parallel against the locked contracts. The slice
is done when it's **deployed** and its `done_means` is demonstrably true.

### 6. Parity (G6) and the finish line (GP)

After each slice and monthly, the parity loop runs automatically: AC test results,
coverage diff against the matrix, scope-creep detection, and re-mining the reference's
changelog (it keeps shipping while you build — new features enter your backlog at slice
boundaries, never mid-slice). When the slice plan completes, **Gate 5** verifies
production readiness *by doing*: you restore a backup for real, you run an incident
drill from the runbook. Evidence, not assertion. Locking Gate 5 is the finish.

## Knowing where you are

Ask the skill "where are we?" anytime, or run in the workbench:

```bash
npm run gate -- status     # gate states + current phase
npm run validate           # artifacts vs schemas, contract $refs, lock integrity
npm run parity             # coverage report into parity/<date>.md
npm run pause-check        # safe to stop? (includes what hasn't been pushed off-machine)
npm run autopilot -- preflight   # ready to run unattended between gates?
```

## Autopilot

The gates are where judgment lives. Everything between them — four mining lanes, a matrix
merge, per-slice spec → backend → frontend → infra, a parity report — is work you would
otherwise advance by typing "continue". Say **"autopilot"** and the skill checks the project
is in a safe state, tells you exactly what it would run and where it would stop, and waits
for a yes. Then it works unit by unit, writing each result to disk and committing before
starting the next.

It stops at **every gate**, with the review written to `plan/gate-reviews/gate-N.md` so the
decision doesn't depend on scrollback. It also stops on trouble — a failing validation, a
subagent that came back empty, or any of the non-gate calls that are yours to make (license
posture, spec approval, marking a slice done, adopting an upstream feature).

And it watches the clock. At 80% of your 5-hour usage window it pauses itself: saves, commits,
pushes, runs the pause check, and asks whether to continue after the reset or stop there.
That threshold is enforced by a hook rather than by good intentions — the write is blocked,
mid-slice, whether or not the unit felt nearly finished.

```bash
npm run autopilot -- preflight    # is this safe to start?
npm run autopilot -- status       # what did the last run do, and where did it stop?
```

One-time setup: the 5-hour figure is piped by Claude Code to your **status line only**, so it
has to be persisted to disk before anything else can read it. `preflight` prints the block to
add if it's missing. It needs a Claude Pro/Max plan, and an interactive session — no status
line means no signal, so autopilot can't run headless.

## What's in this plugin

```
.claude-plugin/plugin.json      manifest
commands/rebuild.md             /rebuild — run or resume the pipeline
skills/rebuild-pipeline/        THE skill you interact with
  SKILL.md                      orchestration protocol (state → report → act, gate rules)
  references/g*.md              one file per phase, loaded only when that phase runs
  schemas/*.schema.json         finding / feature / slice / lock schemas
  scripts/rebuild-init.mjs      workbench scaffolder
  scripts/gate.mjs              gate status / lock / reopen (hashes + tags)
  scripts/validate.mjs          schema, contract-$ref and lock-integrity validation (also in CI)
  scripts/parity.mjs            G6 coverage report
  scripts/pause-check.mjs       is it safe to pause the session? (advisory, not a gate)
  scripts/autopilot.mjs         unattended-run state: preflight / check / engage / log / disengage
agents/                         miner, adr-drafter, spec-writer subagents
hooks/                          PreToolUse guards: locked artifacts, and the autopilot
                                usage threshold
docs/PLAYBOOK.md                the full methodology
```

## Design rules the plugin enforces (so you don't have to)

- **No evidence, no finding.** Agents cannot write hallucinated facts into the matrix.
- **Locked means locked.** The hook blocks edits under a locked gate's paths; the escape
  hatch is a formal, logged reopen with a reason — never a quiet edit.
- **Gates are yours.** The skill never locks a gate on its own initiative — including on
  autopilot, which halts at every one of them and hands you a written review.
- **The workbench never contains product code.** It describes the product; code repos
  consume it one-way, pinned at gate tags.
- **Every slice ships.** Deployment is part of the definition of done — it's half the
  curriculum.
- **The work leaves the machine.** Every repo gets a remote when it is created, private
  unless the license posture says otherwise, and the pause check tells you when something
  still hasn't been pushed. Months of decisions that re-mining cannot reproduce should not
  live on one disk.

## FAQ

**Can I use this for a commercial competitive product?** It's built for rebuild-to-learn.
The license posture step will force the right questions, but competitive-intelligence
workflows are out of scope.

**What if I disagree with a locked decision later?** Reopen the gate with a reason —
`npm run gate -- reopen gate-3 --reason "..."`. It's logged, downstream staleness is
surfaced, and history stays honest.

**Multiple projects?** One workbench per project, always. The plugin (schemas, scripts,
process) is the shared part; every workbench pins the schema version it was created with.
