# product-rebuild-skills

A Claude Code plugin for rebuilding an existing product end-to-end — to learn the full
product development lifecycle by doing it. Point it at a reference product (usually OSS:
OpenProject, Twenty CRM, Webstudio, or a category like "CRM"), and it drives a gated
pipeline from feature mining to a verified, production-ready codebase.

**The reference can also be your own product**, which is the case for replacing a legacy app
on a new stack. And the rebuild does not have to own both halves: set `target_shape:
client-only` and the existing backend API stays where it is, becoming mined ground truth the
pipeline freezes rather than a contract it designs. A messy old React Native app rebuilt in
Flutter, backend untouched, is the same pipeline with three fields set differently at G0.

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
3. **A playbook, not a blank slate — but only for architecture.** Gate 3's decisions start
   from an *architecture playbook* your project picks at G0: one file in
   [`references/playbooks/`](skills/rebuild-pipeline/references/playbooks) declaring which
   concerns exist and where its answers live, or one you write yourself. Two ship — a Go +
   Nuxt modular monolith (the org default) and a Flutter client against an existing API — and
   an ADR is required to *diverge* from an answer, not to adopt one. Everywhere else (taxonomy,
   slicing, contracts) stays a per-product decision, deliberately.

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

**Also requires the [`bigin-skills`](https://github.com/tammai/bigin-skills) plugin** — the
baseline this pipeline builds on. It owns app scaffolding and the AI-governance harness;
from G5 onward every code repo is created by its `bigin-harness-setup` skill rather than by
hand, so the rebuild lands on the same stack and the same guardrails as everything else in
the org. Nothing before G5 touches it, but install it up front:

```bash
/plugin marketplace add tammai/bigin-skills
/plugin install bigin-skills@bigin
```

Note it is licensed PolyForm-Strict-1.0.0, unlike this plugin's MIT.

## Walkthrough: start to finish

### 1. Start

In any directory, say **"start a rebuild project"** or run `/rebuild`. The skill
interviews you:

- **Which reference?** Name a product, or a category — it will propose candidates and
  compare them on domain fit, codebase readability, and upstream activity.
- **Distribution intent?** This decides the *license posture*: private learning allows
  reading any OSS source; possible closed-source distribution later means clean-room
  treatment of copyleft references (behavior/docs/API only, no code reading). Recorded
  in `license-posture.md` before anything is mined. If the reference is code you already own,
  this collapses to a question about *your* distribution plans instead.
- **What is being rebuilt, and against which playbook?** Two fields, and the cheapest thirty
  seconds in the project: `target_shape` (`fullstack`, or `client-only` when the API already
  exists and stays) and `playbook` (a registry entry, a file of your own, or `none` to keep
  every architecture decision blank-slate). Four later phases read them — target shape alone
  changes what G1 mines, flips Gate 4 from *authoring* a contract to *transcribing* one,
  decides how G5 creates the repo, and selects Gate 5's checklist. Discovering it at Gate 4
  means a month of mining the wrong things.

It then scaffolds your **workbench** (`<name>-workbench/`): the directory tree, schemas,
gate files (all open), validation scripts, and CI. Run `npm install` inside it once.

### 2. Mining (G1) — mostly hands-off

The skill dispatches miner agents in parallel across four lanes: **ground truth** (the
reference's actual schema, routes, permissions, jobs — when the license posture allows),
**features** (changelogs, docs), **NFR** (how it behaves running), **UX flows** (how key
features actually work). Your two jobs: get the reference running locally, and verify
the drafted UX flows against it when asked. Every finding carries evidence or it gets
rejected at validation.

For a `client-only` rebuild, lane D points at the *client*: every API call site (which becomes
the frozen contract), every field the app reads or caches, and an inventory of what the old app
left on people's devices — secure-storage keys, local database, files, push registration.
That last one wants a device restored from a real backup rather than a fresh install, because a
fresh install has none of the state a two-year-old install has, which is exactly the state that
breaks on upgrade.

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

- **Gate 3 (architecture):** decisions start from the **architecture playbook you picked at
  G0** — one of [`references/playbooks/`](skills/rebuild-pipeline/references/playbooks)
  (`web-modular-monolith`, the org default: Go + Nuxt modular monolith, API-first;
  `mobile-flutter`, a Flutter client against an existing API), or a file you wrote yourself.
  The playbook's frontmatter carries the list of concerns to decide and which of its sections
  answers each one; concerns it marks `N/A` stay fully open, mirror-or-diverge against the
  reference, decided from scratch. Agents draft one ADR per concern proposing to mirror the
  playbook, and only argue for diverging when this product's shape gives a concrete reason —
  the reference's own architecture is recorded for the learning record but doesn't drive it.
  You decide each ADR. *Undocumented* divergence — from the playbook where it has an answer,
  from the reference otherwise — is the failure mode the format prevents. The playbook is
  copied into the workbench and locked with the ADRs, so the sections they cite can't shift
  under you later. Only after this gate do code repos get created — their count is an output
  of your decomposition decision. Each pins the workbench as a read-only submodule at gate tags.
- **Gate 4 (contracts):** data model first — one Mermaid ERD per bounded context, checked
  for entities and required before the gate can lock — then three interface layers (public
  API, internal, async/events). Locking cuts the tag your code repos build against.

### 5. Build (G5) — the steady-state loop

Per slice: spec agents write module specs ending in **acceptance criteria** (each one an
observable behavior mapping to exactly one test) — you review specs before code — then
backend/frontend/infra lanes build in parallel against the locked contracts. The slice
is done when it's **deployed** and its `done_means` is demonstrably true.

Code repos are created by [`bigin-skills`](https://github.com/tammai/bigin-skills)
(`bigin-harness-setup`), using the profile your locked playbook names — `go`/`nodejs` +
`nuxt`/`next`, or `flutter` from bigin-skills 1.68.0. For a client-only rebuild this lane *is*
the build, split per feature module, and "deployed" means a build a real person can install
from an internal track — not a simulator run.

### 6. Parity (G6) and the finish line (GP)

After each slice and monthly, the parity loop runs automatically: AC test results,
coverage diff against the matrix, scope-creep detection, and re-mining the reference's
changelog (it keeps shipping while you build — new features enter your backlog at slice
boundaries, never mid-slice; skipped entirely for a reference that has stopped shipping,
which is the normal case when you are replacing your own app). When the slice plan completes,
**Gate 5** verifies production readiness *by doing*: you restore a backup for real, you run an
incident drill from the runbook. Evidence, not assertion.

A shipped client gets its own checklist instead, because it breaks all three assumptions the
service one makes — you cannot roll a release back, the data at risk is on devices you cannot
reach, and someone else's review queue gates the deploy. So "restore a backup" becomes
"upgrade in place over the old app, on the oldest supported OS, once with the migration
interrupted", and the kill switch gets flipped for real. Locking Gate 5 is the finish.

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
  references/playbooks/         the architecture-playbook registry — one file per playbook,
                                each declaring its own concerns → sections map; write your own
  references/rubrics/           one scoring rubric per gate, for the judge pass at Step 5.1b
  schemas/*.schema.json         finding / feature / slice / lock schemas
  scripts/rebuild-init.mjs      workbench scaffolder
  scripts/gate.mjs              gate status / lock / reopen (hashes + tags)
  scripts/validate.mjs          schema, contract-$ref and lock-integrity validation (also in CI)
  scripts/playbook.mjs          playbook resolution + the ADR concern/citation checks
  scripts/erd.mjs               data-model checks shared by validate and gate
  scripts/basis.mjs             evidence-basis checks shared by validate and parity
  scripts/flows.mjs             the logged-decision log for AC flow assertions (unlock/relock)
  scripts/parity.mjs            G6 coverage report + AC pass rate from the suite's JUnit
  scripts/pause-check.mjs       is it safe to pause the session? (advisory, not a gate)
  scripts/autopilot.mjs         unattended-run state: preflight / check / engage / log / disengage
agents/                         miner, adr-drafter, spec-writer, rubric-judge subagents
hooks/                          PreToolUse guards: locked artifacts, recorded AC flows, and
                                the autopilot usage threshold
docs/PLAYBOOK.md                the full methodology
```

## Design rules the plugin enforces (so you don't have to)

- **No evidence, no finding.** Agents cannot write hallucinated facts into the matrix.
- **Every architecture concern gets decided, or the gate will not lock.** Your playbook's
  concern list is the ADR list: `gate.mjs lock gate-3` refuses while any of them has no ADR, and
  validation rejects an ADR citing a section the playbook does not have. "Every cross-cutting
  concern decided" stopped being a sentence and became a check.
- **The playbook you decided against is pinned to your decisions.** G4a copies it into the
  workbench and Gate 3 hashes that copy, so upgrading this plugin cannot re-point an accepted
  ADR's "§7" at different content months later.
- **Every gate review comes with a scored second opinion.** A judge subagent reads the
  artifact set against that gate's rubric and files a report next to the review, with a
  citation behind every score below 4. It is advisory on purpose — it informs the lock
  decision and never blocks it — but it closes the space between "the schemas pass" and "a
  human liked it", which is where an unusable taxonomy or a contract with no error responses
  used to slip through.
- **Evidence says where it came from, not just how sure the miner was.** Every finding's
  evidence carries `basis` — transcribed from source at the pinned commit, observed running,
  or inferred from docs. The parity report names the features standing entirely on inference,
  and Gate 4 flags a contract entry frozen on one.
- **Locked means locked.** The hook blocks edits under a locked gate's paths; the escape
  hatch is a formal, logged reopen with a reason — never a quiet edit.
- **Gates are yours.** The skill never locks a gate on its own initiative — including on
  autopilot, which halts at every one of them and hands you a written review.
- **The workbench never contains product code.** It describes the product; code repos
  consume it one-way, pinned at gate tags.
- **Every slice ships.** Deployment is part of the definition of done — it's half the
  curriculum.
- **A parity suite is recorded against the reference, not written after the rebuild.** Where
  the playbook supports it (today: a Flutter client replacing a runnable legacy mobile app),
  the acceptance-criteria flows are framework-agnostic Maestro flows in the workbench, green
  against the *old* app before the slice starts. Replayed unchanged against the rebuild, they
  measure parity; written afterwards they would only agree with whatever got built. Loosening
  an assertion to make a build pass takes a logged human decision, same register as a gate
  reopen — a guard blocks the edit, and `unlock --reason "..."` writes the decision to
  `parity/flows/DECISIONS.md` before it is allowed.
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

**Can I rebuild my own legacy app rather than someone else's product?** Yes, and it is a
better-supported case than it sounds: record `reference.kind: own-code` and
`reference.upstream: frozen`. Mining is unrestricted, the running instance is the app you
already have, and the parity loop stops tracking upstream because there is none. That trade is
in your favour — a frozen reference is a permanent arbiter for "what did the old app actually
do here", so keep it *installable* for the life of the project. Losing that always happens by
accident.

**Can it rebuild only the client, against an API we are not touching?** That is
`target_shape: client-only`. Gate 4 then locks a *transcription* of the existing API rather
than a design, anything the rebuild needs added goes in a separate `requested.yaml` (it is a
request to another team, not a contract you own), and `contracts/data-model/` describes the
on-device store instead of a server schema.

**None of the shipped playbooks fit my stack. Now what?** Write one — it is a Markdown file
with a frontmatter block declaring its concerns, and
[`references/playbooks/README.md`](skills/rebuild-pipeline/references/playbooks/README.md) has
the contract and the four rules tooling enforces. Point `architecture.playbook` at your file
(in the registry, or inside your own workbench for a project-local one). Or set it to `none`
and every Gate 3 ADR goes back to a blank-slate decision against the reference, which is how
the pipeline worked before playbooks existed.

**What if my playbook's stack has no `bigin-skills` scaffold profile?** G5 says so out loud
and falls back: the stack's own scaffolder first, then the harness in its stack-neutral
`generic` mode — which installs no CI, so your playbook's CI section is what the first slice
writes by hand. Usually that gap is a plugin version rather than a permanent fact, so check
before accepting it.
