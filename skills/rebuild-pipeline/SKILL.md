---
name: rebuild-pipeline
description: Orchestrates the full product-rebuild pipeline — rebuilding an existing product end-to-end, ending in production-ready code. The reference can be OSS (OpenProject, Twenty CRM, Webstudio), a category (CRM / project management / web builder), or an app the user already owns and is replacing on a new stack (e.g. a legacy React Native app rebuilt in Flutter). Use this skill whenever the user wants to start a rebuild project, decide license posture for a reference product, clone/rebuild/reimplement an existing product, continue or resume a rebuild, check rebuild progress, run any pipeline phase (mining, feature matrix, slicing, architecture ADRs, contracts, slice build, parity check, production readiness), lock/reopen a gate, or got blocked by the PreToolUse hook editing a locked artifact and needs to know how to proceed. Also use it when the user asks to run the rebuild on autopilot, to work unattended or without being asked at every step, to check whether the project is ready for autopilot, or to pause/resume/stop an autopilot run — and when a run was blocked because the 5-hour usage window hit its threshold. Also trigger when the user runs /rebuild or mentions the workbench, gates, slices, license posture, or the parity loop of a rebuild project. This is the ONLY skill the user should need to touch — it routes all work to phase references and subagents.
---

# Rebuild Pipeline Orchestrator

You are the single interface between the user and the rebuild pipeline. The user should
never have to remember phase mechanics, file formats, or which agent does what — that is
your job. Your loop on every invocation: **detect state → report progress → act or ask.**

The pipeline (full rationale in `${CLAUDE_PLUGIN_ROOT}/docs/PLAYBOOK.md` — read it once
per project, not every session):

```
G0 Reference + license posture
G1 Parallel mining (ground truth / features / NFR / UX flows)
G2 Feature matrix        ── GATE 1: taxonomy lock
G3 Milestone slicing     ── GATE 2: slice-plan lock
G4a System design (ADRs) ── GATE 3: architecture lock
G4b Data model+contracts ── GATE 4: contract lock
G5 Build, per slice      (specs+AC / backend / frontend / infra)
G6 Parity loop           (automated, scheduled)
GP Production readiness  ── GATE 5: prod-ready lock (terminal)
```

**What a project decides once, at G0, that four later phases read.** `sources.yaml` carries
an `architecture:` block: which **playbook** G4a decides against
(`references/playbooks/*.md`, or a path to one the user wrote — see below) and the rebuild's
**target shape** (`fullstack`, or `client-only` when the API already exists and stays put).
Both are cheap to answer at G0 and expensive to discover late: target shape flips G4b from
*drafting* a contract to *transcribing* one, and it selects GP's checklist.

**G4a is playbook-driven, not hardcoded.** The playbook supplies the standing answers and
— through its frontmatter `concerns:` map — the list of ADRs the phase owes. The org default
(`playbooks/web-modular-monolith.md`, Go + Nuxt modular monolith) applies when none is named;
`playbooks/mobile-flutter.md` serves a Flutter client against an existing API. G4a vendors the
chosen file to `adr/playbook.md`, inside gate-3's `protects:`, so the sections its ADRs cite
cannot shift under a locked gate. Never carry a concern list or a section number between
projects: §8 means storage in one playbook and auth in another.

**Baseline dependency — `bigin-skills`.** This pipeline produces decisions, contracts and
specs; it does not know how to create a repo. From G5 onward, every code repo is created by
the `bigin-skills:bigin-harness-setup` skill — a single entry point that scaffolds the app
(delegating to `go-`/`nuxt-`/`nodejs-`/`next-scaffold` per the stack locked at Gate 3) and
overlays the AI-governance harness. Never scaffold conversationally, never call the
`*-scaffold` skills directly, and never hand-write a `CLAUDE.md` into a code repo. Every
shipped playbook names a profile `bigin-skills` can build — the org-default web playbook maps to
`go`/`nodejs` + `nuxt`/`next`, the Flutter client playbook to `flutter` (needs `bigin-skills`
>= 1.66.0) — on purpose: G4a decides, `bigin-skills` builds. **The one exception** is a locked
playbook naming a stack the *installed* plugin has no profile for: `bigin-harness-setup` cannot
start from an empty directory without one, so G5 runs the stack's own scaffolder first and the
harness second in its `generic` profile. That is a version gap to state out loud, not a
standing arrangement — the procedure and what `generic` skips are in `references/g5-build.md`
step 0. Confirm the plugin is installed at G0
(it is needed at G5, and discovering it missing months in is the expensive way to find out).

## Orchestration Protocol

Run these steps in order at the start of every session that touches the pipeline.

### Step 1 — Locate the workbench

The workbench repo is the pipeline's state store. Look for `locks/pipeline.yaml` in the
current directory, then in `./workbench/`. If no workbench exists, the project hasn't
started: offer to run onboarding (Step 4a).

### Step 2 — Detect state

Run, with the workbench root as cwd: `node scripts/gate.mjs status`

Always the workbench's own `scripts/` copy, never the plugin's. Every script except
`rebuild-init.mjs` reads and writes cwd-relative paths, and `validate.mjs`/`parity.mjs`
additionally need the workbench's `node_modules` — the plugin ships no dependencies.

This prints each gate's state (open/locked, date, artifact hashes) and derives the
**current phase**: the first phase whose entry gate is locked but whose own exit gate
is not. Trust the script's output over your memory of the conversation — sessions
resume days apart.

### Step 3 — Report progress, always

Before doing anything, give the user a short progress picture: current phase, what has
been locked (with dates), what the phase needs to exit, and what is blocked behind it.
Keep it to a few lines. The user must never wonder "where are we?".

### Step 4 — Act

Route on the current phase. Read ONLY the matching reference file — they are
per-phase by design to keep context lean:

| Phase | Read | Typical work |
|---|---|---|
| Not started | `references/g0-reference.md` | Onboarding interview, scaffold workbench |
| G1 | `references/g1-mining.md` | Dispatch miner subagents per lane |
| G2 | `references/g2-matrix.md` | Merge findings, draft taxonomy, Gate 1 review |
| G3 | `references/g3-slicing.md` | Dependency graph, slice plan, Gate 2 review |
| G4a | `references/g4a-architecture.md` (+ the playbook `sources.yaml` names, vendored to `adr/playbook.md` — its `concerns:` map is the ADR list) | Vendor the playbook, dispatch ADR drafts, Gate 3 review |
| G4b | `references/g4b-contracts.md` | Data model (`contracts/data-model/`), three contract layers, Gate 4 |
| G5 | `references/g5-build.md` | Per-slice fan-out to build subagents |
| G6 | `references/g6-parity.md` | Parity report, upstream re-mine |
| GP | `references/gp-production.md` | Readiness checklist, Gate 5 review |

**4a — Onboarding (no workbench).** Interview the user: which reference product, why,
distribution intent (this decides license posture), whether the reference is third-party or
an app they already own, and the `architecture:` block — target shape and playbook (see g0
reference for all of it). Then scaffold:
`node ${CLAUDE_PLUGIN_ROOT}/skills/rebuild-pipeline/scripts/rebuild-init.mjs <project-name>`
and walk the user through the generated `sources.yaml` and `license-posture.md`. Before
leaving G0, give the workbench a remote and push it (g0 reference has the commands) —
visibility follows the posture just decided.

**4b — Delegation.** You orchestrate; subagents execute. Dispatch phase work to the
agents in `${CLAUDE_PLUGIN_ROOT}/agents/` (miner, adr-drafter, spec-writer) using the
briefing format in `references/subagent-briefs.md`. Run independent lanes in parallel.
Do the work inline only when it is small (a single merge, a single review pass) or when
subagents are unavailable in the current environment.

**4c — When intent is ambiguous, ask — with options.** If the user's request could mean
several things ("continue" during G5 could mean: next module in this slice, start next
slice, or run parity), present the concrete options rather than guessing.

### Step 5 — Gate protocol (never self-approve)

Gates are human decisions. When a phase's exit criteria are met:

1. Run `node scripts/validate.mjs` from the workbench root — all artifacts must pass schema
   validation first. From 0.6.5 this also structurally checks `contracts/`: YAML validity,
   duplicate keys, and every `$ref` resolving; from 0.7.0, that every
   `contracts/data-model/*.mermaid` declares entities; from 0.11.0, that every ADR names a
   concern its vendored playbook maps and cites only sections that map points at. It is NOT a full OpenAPI/AsyncAPI or
   Mermaid validator — passing it does not mean the spec is semantically correct, only that
   it is not broken in the ways that silently reach a code repo.
2. Present a **gate review** to the user: what is being locked, the key decisions inside
   it, open risks, and what becomes immutable afterward.
3. Only after explicit user approval, run `node scripts/gate.mjs lock <gate-id>`.
4. **Push the lock commit *and* its tag**: `git push && git push --tags`. Both are needed —
   `git push` sends no tags, and `--follow-tags` does not help because gate tags are
   lightweight. The tag is not a label: code repos pin this workbench as a submodule at
   `gate-N/vN`, so one that never leaves the machine either breaks their checkout or leaves
   them silently building against the previous contract. Nothing pushes on your behalf.
5. Never lock a gate on your own initiative, and never edit files under a locked gate's
   `protects:` paths — the PreToolUse hook will block you, and the correct response to
   that block is to propose reopening the gate to the user, not to work around it.
   This holds under autopilot too: a run reaching a gate writes its review to
   `plan/gate-reviews/gate-N.md` and stops there (Step 6).

Reopening (`gate.mjs reopen <gate-id> --reason "..."`) is allowed but is a formal,
logged event; require the user to state the reason.

### Step 6 — Autopilot, if the user asks for it (opt-in, off by default)

Autopilot runs the mechanical stretches between gates unattended — mining lanes, drafts,
per-slice module builds, parity — checkpointing to disk after every unit, and **halting at
every gate**. It changes nothing about Step 5: it never locks a gate, and the list of
non-gate human decisions it must also stop for is in the reference file.

When the user asks for autopilot, read `references/autopilot.md` and follow it. Never
engage without running `node scripts/autopilot.mjs preflight` and getting an explicit
confirmation of the brief — the word "autopilot" is a request to be told what a run would
do, not consent to run it.

If `plan/autopilot.yaml` exists with `status: paused`, say so in Step 3 along with why it
stopped, and offer to resume. Its `engaged_phase` and `paused.next_action` are breadcrumbs
for a human reading the file — `gate.mjs status` remains the authority on where the project
actually is.

### Step 7 — Pause safety check (before ending a session)

When the user signals they're pausing, stopping, or ending the session — or you notice a
natural stopping point (a slice just finished, a gate review just landed) — run:
`node scripts/pause-check.mjs` (from the workbench root)

This is NOT one of the five hash-pinned gates — it locks nothing, has no gate-guard
enforcement, and is safe to run any number of times. It reports, across the workbench and
every repo registered in `repos.yaml`: uncommitted/untracked git changes, work that has not
left the machine (no remote, unpushed commits including on a detached HEAD, unpushed tags,
stash entries), any gate left mid-decision (reopened but not re-locked), and docker-compose
stacks or host-native dev servers left running. Report
its verdict to the user plainly. If it flags issues, resolve them (commit or explicitly
flag draft work, decide on a reopened gate, stop or consciously keep services running)
before the session ends — don't just relay the warning and move on. It also can't check
one thing by itself: confirm out loud that nothing non-trivial exists only in this
conversation (a partial ADR, a draft matrix, in-flight findings) that hasn't reached disk.

## Conventions (apply everywhere)

- Checkpoint discipline: write in-progress, unlocked work to disk in the workbench
  proactively — a partial ADR, a draft matrix, in-flight findings — without waiting to be
  asked. Do this whenever a chunk of non-trivial content only exists in conversation and
  the turn is ending (user signals they're pausing/stopping, or a natural sub-step just
  finished). Draft files on disk survive a new session; chat text does not. This is safe
  because gates protect *locked* artifacts only — draft files can be freely overwritten.
- Artifact-first: every phase output is a schema-validated file in the workbench. If it
  isn't validated, the phase isn't done.
- Evidence rule: no finding without an evidence pointer (URL, or path+commit for lane D).
- Propose-before-act: show plans (taxonomy, slice order, ADR decisions, specs) before
  writing them as final artifacts.
- The workbench describes the product; it never contains product code. Code repos are
  created only after Gate 3 and consume the workbench as a read-only submodule pinned
  to gate tags.
- Off-machine by default: every repo this pipeline creates gets a remote at creation time,
  visibility per `license-posture.md` (private unless the posture is `permissive-reference`).
  The pipeline's output is months of decisions that re-mining cannot reproduce, so a
  single-disk copy is a real risk, not a hypothetical one — push it, and keep pushing it.
  A remote is for durability; whether the host also runs CI is a *separate* decision, asked
  explicitly at G0 and per repo at G5. For a durability-only remote, disable the host's CI —
  these repos' workflows are written for local or self-hosted execution and fail on a hosted
  runner (private-submodule checkout, unset secrets, gitignored paths), so leaving them
  enabled just emails a failure on every push.
- All model-facing artifacts are English.

## Failure modes to actively prevent

- Leaving non-trivial in-progress work only in chat when a session is ending — persist
  it as a draft file first (see checkpoint discipline above).
- Skipping state detection and acting on stale conversational memory.
- Doing lane work inline that should fan out to parallel subagents.
- Nudging the user toward locking a gate to "make progress" — gates gain value from
  being deliberate.
- Editing locked artifacts instead of proposing a reopen.
- Letting the user drift into product code before Gate 3 locks decomposition.
- Carrying a playbook's concern list or section numbers over from another project instead of
  reading the vendored `adr/playbook.md`. A citation that names a section the playbook never
  maps is caught by `validate.mjs`; a plausible-looking wrong one is not caught by anything.
- Creating a code repo by hand — running `npm create`/`go mod init` directly, calling a
  `*-scaffold` skill instead of `bigin-harness-setup`, or writing a `CLAUDE.md` yourself.
  (`g5-build.md` step 0's fallback is the sole exception, and it is keyed to the installed
  plugin genuinely lacking a profile for the locked playbook's stack — not to a judgment call
  at G5, and not to a stack whose profile merely needs a plugin upgrade.)
  The repo is then off the org baseline in ways nothing downstream detects, and the
  governance gates the harness installs are silently absent for the life of the project.
- Trusting codegen from the scaffold's starter `openapi.yaml`. Gate 4's locked contract
  replaces it before any generated type is built on.
- Ending a session without running the pause safety check (Step 7), or running it but not
  acting on what it flags.
- Engaging autopilot on a partial preflight, or on an inferred yes — "can you autopilot
  this?" asks for the brief; only an explicit approval of that brief starts a run.
- Resuming an autopilot run from `plan/autopilot.yaml`'s `next_action` instead of
  re-deriving the phase with `gate.mjs status`. It is a breadcrumb written before a pause,
  and the project may have moved since.
- Pushing past the usage threshold because the current unit felt nearly done. That is the
  exact moment the rule exists for, and the hook will block the write regardless.
- Letting a project run for weeks with no remote, then treating "back it up" as a chore for
  later. The cost of the loss grows every phase; the fix takes one command at G0.
- Creating a public remote for a rebuild whose posture does not allow distribution. Pushing
  it publicly *is* distribution, whatever the intent — a copyleft reference makes that a
  licensing problem and a proprietary one a terms problem, so it needs a G0 reopen first,
  not a `--public` flag.
