# Subagent briefing format

Every dispatch is self-contained — subagents share no conversational context. Include:

1. **Role file**: point at the agent definition (miner / adr-drafter / spec-writer).
2. **Inputs** (absolute paths): the exact workbench files to read. Never "the matrix" —
   always `workbench/matrix/features.yaml`. For miners: the `sources.yaml` entries in
   scope and the pinned reference commit. For lane-D miners specifically, also include the
   reference checkout's `graphify-out/graph.json` path when it exists (see
   `g1-mining.md`'s ground-truth graph step) so the miner queries it instead of grepping
   raw source cold. For adr-drafter (G4a): always include
   the workbench's **`adr/playbook.md`** as a fixed input alongside the per-ADR brief — the
   vendored copy, never the plugin's registry file — plus the **concern key** and the exact
   **section(s)** the playbook's `concerns:` map gives for it (or `N/A` where it has no
   answer). Never leave the drafter to infer the section itself: numbering is per-playbook,
   so an inferred section is wrong in a way that reads as right. For the decomposition/stack
   ADR specifically, also pass along whatever the human said about team-composition facts
   bearing on the playbook's default versus its alternate. Pass `target_shape` too when it is
   `client-only` — it changes what the drafter may propose about the API (see the agent file).
3. **Output contract**: the exact output path and schema file. One output file per run.
4. **Boundaries**: what the agent must NOT do — no edits outside its output path, no
   fetching outside `sources.yaml`, no restructuring locked artifacts, no invented
   evidence. Ambiguity resolves by flagging `confidence: low`, never by guessing.
5. **Done means**: a checkable condition (validates against schema X; covers files Y).
6. **Model + tier**: the `model` and `tier` `scripts/routing.mjs` resolved for this role, stated
   in the brief as well as passed on the Agent call. On the record it is checkable after the
   fact; passed only as a parameter it is not, and a dispatch that silently ran on the wrong
   rung looks exactly like one that ran on the right one.

## Context budget (every brief, part 4 — verbatim)

One audit day cost ~200M tokens, ~85M of it a single drafter that read the parent session's
transcript. Every subagent turn re-bills the whole context so far, so one large read early in a
run is paid again on every later turn. Put this in **every** brief's Boundaries, as written:

- **Never read session transcripts or scratchpad dumps**: nothing under `~/.claude/projects/`
  (`*.jsonl`), no scratchpad or temp-dir file you did not write in this run. What you need from
  the conversation is in this brief; if it is not, report what is missing instead of looking
  for it.
- **No single tool result over ~20K characters.** Find with Grep, then read the range with
  `sed -n 'A,Bp'` or Read `offset`/`limit`. Never `cat` or whole-read a file you only need
  part of — contracts (`openapi.yaml`), ADR sets, route files, logs.
- **Read each file once.** Write the facts you need (path:line plus the quoted text) into your
  notes as you go and work from those; re-opening the same file for each criterion is the
  failure this rule exists for.

**Orchestrator side — state the context inline.** A gate-reopen proposal, an ADR draft or a
lane brief carries what the agent needs *in the brief*: the decision being reopened and why,
the paths and sections that matter, the relevant excerpt. "See the conversation above" is a
brief that sends the agent to the transcript. If a lane would need a large input (a big log,
a generated dump), cut it to the relevant range first and pass the path to that cut.

## The judge brief (`rubric-judge`, at every gate — Step 5.1b)

Same five parts, with these values. It runs once per gate attempt, after `validate.mjs`
passes and before the gate review is written.

1. **Role file**: `${CLAUDE_PLUGIN_ROOT}/agents/rubric-judge.md`.
2. **Inputs**: the **gate id**; the **rubric** `${CLAUDE_PLUGIN_ROOT}/skills/rebuild-pipeline/references/rubrics/gate-N.md`;
   the absolute paths of the artifacts under that gate's `protects:`; and the supporting
   paths the rubric's own header says to read (findings, the NFR profile, the vendored
   `adr/playbook.md`, the latest parity report — they differ per gate, so take them from the
   rubric rather than from this list). For gate 4, say which mode G4b ran in — a
   `client-only` transcription is scored on two dimensions a `fullstack` draft is not.
3. **Output contract**: `plan/gate-reviews/gate-N-rubric.md`, in the format the role file
   specifies. Not schema-validated — it is a report for a human, not a pipeline artifact.
4. **Boundaries**: read-only over every input; no edits to the artifacts being scored (they
   are about to be hashed); no file written other than the output path; no recommendation to
   lock or not to lock. Uncertainty goes in the report's "What I could not check" section
   rather than being resolved by guessing.
5. **Done means**: every dimension the rubric defines has an integer score, and every score
   below 4 carries a file-plus-line or file-plus-id citation. Send a report back with the
   uncited dimensions named if it does not — same rule as a schema violation, and for the
   same reason: the fix has to come from a run that could have produced it.

**Pre-extract an evidence bundle for large contracts.** For gates whose artifacts are big
(gate 3 ADR sets, gate 4 `openapi.yaml`, specs), write the sections the rubric's dimensions
touch into `plan/gate-reviews/gate-N-evidence.md` before dispatching: **verbatim excerpts**
only, each headed `path:startLine-endLine`, never a summary of them (the paragraph below
applies to the bundle too). Pass the bundle as an input beside the artifact paths. The judge
scores from it and opens the full file only for a targeted range when a dimension needs what
the excerpt left out — it is a starting point, not a limit on what the judge may check.
One run on 8 judge dispatches read `openapi.yaml` 25 times; the bundle is how that becomes 1.

One thing to get right when you dispatch it: **do not paste the gate review into the brief**.
The judge scores the artifacts, and a judge that has read your summary of them will grade the
summary.

Its rung is no longer a judgement call in this file — `routing.mjs` maps it to the worker tier
and the agent file pins `effort: high`, on the reasoning that scoring a whole artifact set is
omission-hunting and omissions are what effort buys. What used to be written here as "route it
to a high tier" is now the resolved value you pass.

## The build-lane brief (backend, frontend and infra lanes — G5)

Same six parts. Parts 2 and 5 carry this, **verbatim** — a lane that has to infer how often to
run the slow suites runs all of them after every batch, which is the failure it exists to stop.

**Test cadence** (part 5, from `g5-build.md` "Test cadence within a slice"):

| When | Run | Don't run |
|---|---|---|
| While building | lint, type-check, unit and fixture tests for touched files; integration tests for touched packages; the ONE E2E for the criterion being worked on, if it is a UI-level one (`--grep` / `-run`) | the E2E set; the full backend suite |
| The joint run, if this lane is named for it | `node scripts/lanes-check.mjs stamp` from the workbench root, then ONE run of the cumulative suite — all unit and integration/API suites, then the E2E set (latest smoke journey plus each slice's one UI-level E2E) — JUnit to `parity/<local-date>-ac.xml` | extra "clean" full runs |
| After the joint run, for failures this lane owns | `node scripts/lanes-check.mjs stamp --rerun`, then ONLY the failed specs, JUnit to `parity/<local-date>-ac-rerun.xml` | another full run |

`<local-date>` is today on this machine's own calendar, not UTC. Redeploy only when an E2E test
needs the new build, and say so before and after. Commit before stamping: a dirty tree makes every
pass on rerun report as unverified, because no commit names the code that ran.

**Long runs** (part 5):

- Start any command expected to take more than about 2 minutes with Bash `run_in_background: true`,
  output to a log file. The process exit is the completion signal. A Monitor is never the only
  signal that a long run ended — it expires after at most 30 minutes.
- Whenever you wake, for any reason, first check whether your own run's process is alive. If it
  ended, read the result and act on it before anything else.
- Never end a turn "waiting for the notification" unless your own background process is still
  running.
- Report a run's result to the orchestrator in the same turn the run ends.

**The plan and the repo's guards** (part 4, verbatim):

- You work in `<worktree>` on branch `slice/<Sn>-<lane>`, under the `PLAN.md` at its root. The rebuild
  pipeline wrote that plan from the slice specs the user approved. Its `Status: approved` is what the
  repo's spec gate reads before it allows any edit over ~20 lines.
- This repo's `CLAUDE.md` sends non-trivial work to `/task-workflow`. For this lane, steps 1–3 are
  already done: the spec was approved in the rebuild workbench and `PLAN.md` was written from it. Do
  not start `task-workflow`, do not write a spec, and do not ask for approval. Work the task rows in
  `PLAN.md`, one per acceptance criterion, and set each to `Done` when its test passes.
- Edit only the task rows' Status and Notes. Never edit `Status:`, `Branch:`, `Approved:` or `## Spec`,
  and never write a new `PLAN.md`. If the spec is wrong or contradicts a Rule Card or a contract,
  set `Status: amending`, which blocks your own non-trivial edits, and report what is wrong. That is
  the only `Status:` edit you may make.
- The repo's own guards (spec gate, bash guard, bugfix-test, commit-msg, injection gate) run for
  you. A block from one of them is the repo's rule: follow its message, and never edit
  `.claude/guards/` or `.claude/settings*.json`.
- Start every shell command that acts on the repo with `cd <worktree> && …`, in the same call. The
  guards can only see which repo a command acts on when the command says so. Use `cd`, not
  `git -C`: the repo's commit-message guard does not read a message behind `git -C <dir> commit`.

**Helpers** (part 4). A lane may run helper agents only in their own worktrees, with disjoint file
ownership, unique test database and role prefixes, and test pools capped and closed in cleanup —
one harness once leaked 34 connections and exhausted Postgres for every lane. Only the lane merges
to main. A helper's worktree needs its own plan, because the spec gate reads one per worktree. Before
dispatching a helper, run from the workbench root `npm run lane-plan -- <Sn> <lane>-h<N> --worktree
<helper worktree> --branch <helper branch> --specs <the specs it builds>`. Never copy your own
`PLAN.md` into the helper's worktree: a copy carries the wrong `Branch:` and no record of its own.

Parallelism: dispatch independent lanes/modules in the same turn. On subagent output failing
validation, send it back with the validator error — do not hand-fix, the fix must come from a
run that could have produced it.

## Which model each role runs on

This used to read "route model tiers if the environment supports it: extraction → low tier;
merge/spec → mid; ADR drafting → high" — a rule with no mechanism behind it, describing a state
of affairs that was true of nothing: the four agent files carried no `model:`, so every dispatch
inherited the orchestrator's own model regardless of what this paragraph said.

`scripts/routing.mjs` is that mechanism. It maps each role to a tier once, resolves the tier
through the project's `.claude/model-routing.json` ladder, and prints the `model` to pass. Run it
once per session (SKILL.md step 4b has the command) and read the values off it — do not re-derive
a tier from the shape of the task, and do not infer a role's rung from the old sentence above.

The tiers it assigns, and the argument for each, are in the script's `ROLE_TIERS`. The shape of
the mapping is worth knowing before you read it: **extraction is not the cheap tier here.**
`validate.mjs` can tell that a finding is schema-valid but not that it is true, so a wrong
finding that parses ships — which puts the miner on the same footing as the judge, and both at
full effort on a cheaper model rather than the reverse.
