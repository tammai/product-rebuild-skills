---
name: rebuild-pipeline
description: Orchestrates the full product-rebuild pipeline — rebuilding an existing product (usually OSS, e.g. OpenProject, Twenty CRM, Webstudio, or a category like CRM / project management / web builder) to learn the complete product development lifecycle, ending in production-ready code. Use this skill whenever the user wants to start a rebuild project, decide license posture for a reference product, clone/rebuild/reimplement an existing product, continue or resume a rebuild, check rebuild progress, run any pipeline phase (mining, feature matrix, slicing, architecture ADRs, contracts, slice build, parity check, production readiness), lock/reopen a gate, or got blocked by the PreToolUse hook editing a locked artifact and needs to know how to proceed. Also trigger when the user runs /rebuild or mentions the workbench, gates, slices, license posture, or the parity loop of a rebuild project. This is the ONLY skill the user should need to touch — it routes all work to phase references and subagents.
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

## Orchestration Protocol

Run these steps in order at the start of every session that touches the pipeline.

### Step 1 — Locate the workbench

The workbench repo is the pipeline's state store. Look for `locks/pipeline.yaml` in the
current directory, then in `./workbench/`. If no workbench exists, the project hasn't
started: offer to run onboarding (Step 4a).

### Step 2 — Detect state

Run: `node ${CLAUDE_PLUGIN_ROOT}/skills/rebuild-pipeline/scripts/gate.mjs status`

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
| G4a | `references/g4a-architecture.md` (+ `references/architecture-default.md`, the org default every ADR mirrors or diverges from) | Dispatch ADR drafts, Gate 3 review |
| G4b | `references/g4b-contracts.md` | Data model, three contract layers, Gate 4 |
| G5 | `references/g5-build.md` | Per-slice fan-out to build subagents |
| G6 | `references/g6-parity.md` | Parity report, upstream re-mine |
| GP | `references/gp-production.md` | Readiness checklist, Gate 5 review |

**4a — Onboarding (no workbench).** Interview the user: which reference product, why,
distribution intent (this decides license posture — see g0 reference). Then scaffold:
`node ${CLAUDE_PLUGIN_ROOT}/skills/rebuild-pipeline/scripts/rebuild-init.mjs <project-name>`
and walk the user through the generated `sources.yaml` and `license-posture.md`.

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

1. Run `node .../scripts/validate.mjs` — all artifacts must pass schema validation first.
2. Present a **gate review** to the user: what is being locked, the key decisions inside
   it, open risks, and what becomes immutable afterward.
3. Only after explicit user approval, run `node .../scripts/gate.mjs lock <gate-id>`.
4. Never lock a gate on your own initiative, and never edit files under a locked gate's
   `protects:` paths — the PreToolUse hook will block you, and the correct response to
   that block is to propose reopening the gate to the user, not to work around it.

Reopening (`gate.mjs reopen <gate-id> --reason "..."`) is allowed but is a formal,
logged event; require the user to state the reason.

### Step 6 — Pause safety check (before ending a session)

When the user signals they're pausing, stopping, or ending the session — or you notice a
natural stopping point (a slice just finished, a gate review just landed) — run:
`node ${CLAUDE_PLUGIN_ROOT}/skills/rebuild-pipeline/scripts/pause-check.mjs`

This is NOT one of the five hash-pinned gates — it locks nothing, has no PreToolUse
enforcement, and is safe to run any number of times. It reports, across the workbench and
every repo registered in `repos.yaml`: uncommitted/untracked git changes, any gate left
mid-decision (reopened but not re-locked), and docker-compose stacks left running. Report
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
- Ending a session without running the pause safety check (Step 6), or running it but not
  acting on what it flags.
