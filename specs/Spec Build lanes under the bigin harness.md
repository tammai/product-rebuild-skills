# Spec: Build lanes under the bigin harness

2026-10-06 · @Tam Mai

## Problem

From G5 on, every code repo is created by `bigin-skills:bigin-harness-setup`, and the pipeline treats what it installs as non-negotiable ("the baseline is not optional and not partially adoptable", `g5-build.md`). **In the linear rebuild, none of the harness's Claude Code guards ever ran for pipeline work.** Its git hooks did. The pipeline never noticed, because nothing it checks would show the difference.

**What was checked (2026-10-06).** There are four linear code repos and one bigin-web repo; crm-rebuild is not on this machine. The harness installs two layers. **Git hooks** (`pre-commit`, `commit-msg`, and `pre-push` in two repos) are symlinked into `.git/hooks/` and run at commit time whatever directory the session started in. In the backend, `pre-commit` runs build, vet, lint and the database-free tests. Those ran. **Claude Code hooks** are registered in `.claude/settings.json` in all four linear repos, and these are the ones that never ran:

- `spec-gate-guard.mjs` on `Edit|Write|MultiEdit`: blocks an edit of more than ~20 changed lines unless the worktree's `PLAN.md` has `Status: approved`;
- `bash-guard`, `bugfix-test-guard` and `commit-msg-guard` on `Bash`;
- `injection-gate-guard` on `Bash|Write|Edit|WebFetch|mcp__.*`, and `injection-scan-guard` after them;
- `canary-seed` and `session-resume-check` at session start, `precompact-snapshot` before compaction.

In `linear-rebuild-backend`, 56 of the 68 slice commits add more than 20 lines of non-test code, and **no commit ever touched `PLAN.md`**. There are no plan archives, and the repo's one `knowledge/implementation/` record is a post-slice task from 2026-10-05. Under a live spec gate, those 56 commits could not have been written without a plan. The only `PLAN.md` history in any of these repos is in `linear-rebuild-frontend`: a UI-polish epic on `main` ("Epic unit 1 of 8"), run through `epic-workflow` and `task-workflow` in a session started inside that repo, with properly approved plans. It was not slice work.

**Why: Claude Code loads project hooks only from the directory the session started in.** The pipeline's sessions ran from `pm-rebuild/`, the parent of the workbench and every code repo, where both plugins are enabled. That directory has no hooks of its own, so a code repo's `.claude/settings.json` was never loaded. Neither were its guards, for the orchestrator or for any lane, because subagents inherit the parent session's settings. A test confirmed it. In a scratch directory, a nested repo's hook that blocks every `Write` was bypassed by a session started in the parent directory, and blocked the same write from a session started inside the repo.

So the harness was installed, and inert. The consequences, in rough order of weight:

- **The injection guards were off** for every lane reading third-party content, which is exactly the threat E7 hardened the miners against.
- **The bash and bugfix-test guards were off.** No lane's shell command was screened, and no bug fix was held to the harness's "a fix comes with a test" rule. The git `commit-msg` hook did check every commit message; only the earlier, Claude-side duplicate of that check was off.
- **The spec gate was off.** No lane ever had to show an approved plan, so nothing tied a lane's diff to the slice spec you approved.
- **It is invisible.** `g5-build.md` says the baseline "keeps what it installed", and it did keep it. A guard that is installed but never loaded reads exactly like a guard that is working, and the git hooks firing at every commit made the harness look active.

**And if the guards had loaded,** a G5 lane, whose work is all non-trivial edits, would have hit the spec gate with no plan. It would then have been blocked, written its own `PLAN.md` with `Status: approved` (`*.md` is exempt from the guard, so nothing stops that), or started `task-workflow` from the top because the repo's `CLAUDE.md` says "Non-trivial features: /task-workflow", asking a person to approve a spec they already approved. Turning the guards on without a plan source would trade an inert gate for a broken one.

The pipeline already has the human approval the spec gate wants. Autopilot stops at "spec approval before any code is written (G5)" (`autopilot.md`), and `g5-build.md` says "specs pass user review before any code". This spec makes the harness's guards actually run for pipeline work (E17a), carries the slice approval into the plan the spec gate reads (E17b), and then uses that plan for something G5 lacks: an independent check of each lane's diff against what was approved (E18).

## Goals and non-goals

**Goals**

- Every guard a code repo's harness registers runs for every pipeline tool call that touches that repo, whatever directory the session started in.
- Every build lane works under a `PLAN.md` whose `Status: approved` traces to a recorded human approval of that slice's specs. It is never written by the lane that the gate constrains.
- A lane never asks a person to approve something they already approved, and never stalls autopilot on a question the pipeline already answered.
- Every lane's diff is audited against its approved plan by an agent that did not write it, before the slice's joint run.
- The harness's guards stay `bigin-skills`' code, run as `bigin-skills` wrote them. The pipeline runs them; it does not reimplement them.

**Non-goals**

- Changing `bigin-skills`. Everything here is on the pipeline side. A cleaner fix on that side is listed under open questions, not assumed.
- Changing where sessions start, or running lanes as separate processes rooted in their worktrees. Sessions keep starting in the project's parent directory, as they do today, because the orchestrator needs the workbench and every repo in reach.
- Adopting `discovery-workflow`, `epic-workflow`, `sprint-distill` or `contract-sync`. G0–G4 already do their jobs at product scale, and their state would be a second record of decisions the workbench locks.
- Running `task-workflow` steps 1–3 (scope, spec gate, plan file) inside a lane. The pipeline has done those by the time a lane starts.
- Per-task human approval. The slice spec review stays the approval point.

**Success metrics**

| Metric | linear rebuild | Target |
|---|---|---|
| Harness Claude Code guards that ran for pipeline tool calls in code repos | 0 of 9 (the git hooks did run) | all that apply to the tool call |
| Lane `PLAN.md` files with `Status: approved` written by the lane itself | 0, because the gate never ran | 0, with the gate running |
| Lane edits blocked by the spec gate for lack of a plan | 0, because the gate never ran | 0, outside a deliberate `amending` freeze |
| Approval prompts a lane raises for an already-approved spec | 0 | 0 |
| Lane diffs audited by an independent agent before the joint run | 0 | every lane, every slice |
| `PLAN.md` approvals traceable to a workbench commit and approver | 0 | every one |

## E17a — Run each code repo's own hooks for pipeline work

The pipeline's plugin hooks do load wherever the session starts; that is how `gate-guard` protects locked workbench files today. So the plugin gains one hook that forwards to the code repo's own:

- **`hooks/scripts/repo-hooks.mjs`**, registered on `PreToolUse` and `PostToolUse` for every tool. For a tool call whose target lies inside a code repo listed in the workbench's `repos.yaml`, it reads that repo's `.claude/settings.json`. It runs each hook registered for the event whose `matcher` matches the tool, with the same stdin payload and `CLAUDE_PROJECT_DIR` set to the repo root, and returns the strictest result: block over ask over allow. A hook that blocks inside the repo blocks here, with its own message.
- **How the target repo is found.** For file tools, by the file path. For `Bash`, by a leading `cd <dir>` or a `git -C <dir>` in the command. A Bash call whose repo can't be determined runs no repo hooks. Rather than print a message nobody sees, the build-lane brief tells lanes to start every repo command with `cd <worktree> &&`. The gap is listed under open questions, not hidden. (`cd` is preferred over `git -C` because the harness's own commit-msg guard does not read a message behind `git -C <dir> commit`. That was checked against bigin-skills 1.106.0, and the repo's git `commit-msg` hook still catches it.)
- **Worktrees.** A lane's worktree counts as its main repo for the `repos.yaml` check. Registrations are read from the worktree, and fall back to the main checkout when the worktree has none, so that a fresh worktree cannot slip past its repo's guards.
- **What it does not forward.** `SessionStart` and `PreCompact` hooks belong to a session, and a pipeline session is not a session in any one code repo. Running one repo's canary or resume check for a session spanning five repos would be wrong in five different ways. They stay unforwarded, and the hook's header comment says why.
- **When it does nothing.** A session started inside the code repo already loads that repo's hooks, so forwarding there would run every guard twice. The hook exits when the session root is the repo root. It also fails open when there is no workbench, no `repos.yaml`, or no `.claude/settings.json`, and names the condition in the comment.
- **Failure mode.** A forwarded hook that crashes is reported as a block with its stderr, not swallowed. A guard that silently stopped running is the problem this exists to fix.

**Helpers.** A lane's helper agents work in their own worktrees, so each needs its own plan: `lane-plan.mjs <Sn> <lane>-h<N> --branch <helper branch>`, run from the workbench root before the helper is dispatched, and recorded like any other lane. Copying the lane's plan would carry the wrong `Branch:` and no record.

**Turning this on blocks every lane until E17b lands**, because lanes would hit a live spec gate with no plan. The two ship in the same release.

**Changes**

- `hooks/hooks.json` and `hooks/scripts/repo-hooks.mjs`, new. The header comment says what it is and why it is a hook rather than a convention, including the session-root fact and the 2026-10-06 test.
- `hooks/scripts/lib.mjs`: the `repos.yaml` reader, shared with `pause-check` and `lanes-check` if theirs can be lifted, and copied with a "change both" note otherwise.
- `references/g5-build.md`: one paragraph under "The baseline is not optional" saying the harness's guards run for lanes through this forwarder, and what is not forwarded.
- `SKILL.md`: one line, so the orchestrator knows a block from a code-repo guard is the harness, not the pipeline.

## E17b — The slice's spec approval is the lane's PLAN.md approval

**One worktree and one branch per lane.** The guard reads `PLAN.md` from the root of the worktree the edited file lives in. Two backend lanes sharing one checkout would also share one plan, and each would be governed by the other's tasks. So every lane works in its own worktree on its own branch, `slice/<Sn>-<lane>` (for example `slice/S3-billing-backend`), created by the orchestrator before dispatch. `lanes-check.mjs` already reports per worktree, so the watchdog needs no change.

**The orchestrator writes `PLAN.md`, by script, at the approval moment.** When the user approves a slice's specs, and before any lane is dispatched:

```
node scripts/lane-plan.mjs S3 billing-backend --worktree <path> --specs plan/specs/S3/billing.md,plan/specs/S3/invoicing.md
```

It writes `<worktree>/PLAN.md` in the format `task-workflow` defines, so the guard, the verifier and `task-workflow`'s cleanup all read it unchanged:

```
# Plan: S3 billing-backend

Status: approved
Branch: slice/S3-billing-backend
Approved: plan/specs/S3/billing.md, plan/specs/S3/invoicing.md @ workbench 3f2a9c1 — <user>, 2026-10-06

## Spec

{each assigned spec, verbatim from the workbench at that commit}

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | AC billing-3: … rule_id: R-BILL-002 | Not started | |
```

- **One task row per acceptance criterion**, copied verbatim with its `rule_id`. `Done` then means the same thing in the plan, in the AC→test mapping and in the per-rule parity report, so there is one unit of progress rather than three.
- **The `Approved:` line is the provenance.** The workbench commit pins exactly which spec text was approved. The approver comes from the session's git identity. A reviewer at the slice boundary can check one against the other.
- **It is a script, not an instruction,** because the whole point is that the approval is mechanical and attributable. A lane told "write a PLAN.md from the spec" is the self-approval in problem 2 with extra steps.
- **It refuses** when the specs have uncommitted changes in the workbench (the approval would point at text no commit holds), when the worktree's branch differs from the one it is told, and when a `PLAN.md` with unfinished tasks is already there. `task-workflow` has the same never-overwrite rule.
- It records `plan/lane-plans/<Sn>.yaml` in the workbench: one entry per lane with the worktree, branch, workbench commit and a sha256 of the `## Spec` section.

**A lane never edits `Status:`, `Branch:`, `Approved:` or `## Spec`.** It flips task rows and nothing else. This goes in the build-lane brief verbatim. Because the guard can't enforce it (`*.md` is exempt), the slice boundary checks it: `slice-review.mjs` re-hashes each lane's `## Spec` against `plan/lane-plans/<Sn>.yaml` and reports any mismatch. It is advisory, like the rest of the slice review, but it is named, and a mismatch is a finding for the user.

**When the spec turns out wrong mid-build.** `g5-build.md` already says that when a card and the lane's reading disagree, the lane stops. Under E17, stopping has a mechanism: the lane sets `Status: amending`, which is `task-workflow`'s own freeze. The guard then blocks the lane's own non-trivial edits, and the lane reports what is wrong. This is the one edit to `Status:` a lane may make, because it can only take permission away. The orchestrator takes it to the user. On re-approval, `lane-plan.mjs --amend` rewrites `## Spec` from the newly committed spec, appends a line to `## Amendments`, flips any invalidated `Done` rows back, and sets `Status: approved` again.

**The repo's `CLAUDE.md` line.** The build-lane brief says, verbatim: "This repo's `CLAUDE.md` sends non-trivial work to `/task-workflow`. For this lane its steps 1–3 are already done: the spec was approved in the rebuild workbench and `PLAN.md` was written from it. Do not start `task-workflow`, do not write a spec, and do not ask for approval. Work the task rows in `PLAN.md`." The repo's `CLAUDE.md` is not edited. It stays as the harness wrote it, and it stays true for any work in that repo outside the pipeline.

**Slice end.** Once every row is `Done` and the slice is deployed, `PLAN.md` leaves the worktree by `task-workflow`'s own cleanup step: a `knowledge/implementation/` record in the code repo when it has one, `.claude/memory/PLAN.archive.*` otherwise. The code repo then holds a record of what was built against which approved spec, which today it doesn't.

**Changes**

- `scripts/lane-plan.mjs`, new: write, `--amend`, and the refusals above. It carries a header comment per the repo convention.
- `scripts/slice-review.mjs`: the `## Spec` hash check, and a line per lane with its plan's task rows (`12/12 Done`).
- `references/g5-build.md`: a new step between spec approval and lane dispatch (worktree, branch, `lane-plan.mjs`), and the amend path under "Where the card and your reading disagree, stop".
- `references/subagent-briefs.md`: the build-lane brief gains the `PLAN.md` rules and the `CLAUDE.md` paragraph, verbatim.
- `references/g0-reference.md`: one line at the `bigin-skills` check saying the harness installs a plan gate in code repos and G5 satisfies it from the slice spec approval, so it is no surprise at G5.
- `references/autopilot.md`: lane dispatch after spec approval includes `lane-plan.mjs`. An `amending` report from a lane is a halt, in the same register as "a subagent that came back empty".

## E18 — Lanes run task-workflow's implement/verify loop

E17b makes the plan real. With a real plan, `task-workflow`'s step 4 (an implementer, then a fresh verifier auditing the diff against `PLAN.md`, with a capped fix loop) gives G5 something it doesn't have. Today the first independent look at a lane's code is the joint run's test results, and `rubric-judge` only reads gate artifacts. A verifier reads the diff against the approved criteria, so it catches a criterion implemented differently from its spec, or one quietly left out. Those are problems tests written by the same lane can agree with.

**Who runs the loop: the pipeline's orchestrator, not the lane.** `task-workflow` forbids dispatching the implementer as `general-purpose` or under a hand-written stand-in prompt: it must be the `bigin-skills:` agent its routing names. And a lane that ran the loop itself would need to spawn subagents of its own. So the orchestrator plays `task-workflow`'s step-4 role for each lane:

1. **Implement.** Dispatch the lane as the `bigin-skills` worker agent (`bigin-skills:standard-worker`, or the variant `model-router`'s routing names under the project's profile), carrying the build-lane brief and its worktree.
2. **Verify.** When the lane reports its rows done, dispatch a fresh `bigin-skills:verifier` with the worktree's `PLAN.md` and the lane's diff against the slice's base. It is never resumed and never shown the lane's own summary.
3. **On FAIL**, resume the same lane with the verifier's issues verbatim, then dispatch a fresh verifier. The cap is `task-workflow`'s: 3 rounds. **Cap hit is a halt**: autopilot stops and the issues go to the user, exactly as `task-workflow` stops and asks.
4. **On PASS**, the lane is done and joins the slice's joint run as today.

`task-workflow` step 5 (offering `/code-review`) is not run per lane. Whether to review is the user's call at the slice boundary, where the whole slice's diff is in front of them. Step 6 (cleanup) runs as E17b describes.

**This also routes build lanes, which today nothing routes.** `routing.mjs` resolves a model for `miner`, `rubric-judge`, `spec-writer` and `adr-drafter` only, so build lanes run on whatever the dispatch happens to inherit. Running them as `bigin-skills` worker agents puts them on the same ladder the rest of the org's code work uses. `routing.mjs` gains a `build-lane` role resolving to bigin's worker agent and a `lane-verifier` role resolving to bigin's verifier agent, both copied, not imported, like the existing ladder.

**Cost, stated before adopting it.** One verifier dispatch per lane per round, reading `PLAN.md` and the diff. That is a fraction of a lane's own spend, and the verifier is read-only. The orchestrator only dispatches and reads PASS/FAIL, so the main context grows by a few lines per lane, not by diffs. The verifier brief carries the subagent context budget like every other brief.

**Changes**

- `references/g5-build.md`: the per-lane loop above, in the per-slice sequence between dispatch and the joint run.
- `references/subagent-briefs.md`: a verifier brief (plan path, diff range, context budget, no lane summary).
- `scripts/routing.mjs`: the `build-lane` and `lane-verifier` roles.
- `references/autopilot.md`: verifier cap hit is a halt reason.
- `SKILL.md`: the `bigin-skills` baseline paragraph names what the pipeline now uses: `bigin-harness-setup`, the plan gate it installs, and the worker and verifier agents. It also names what the pipeline deliberately does not use, with one line each on why, so the next reader doesn't have to reconstruct it.

## Evals

- `eval/repo-hooks.mjs`, for E17a. It builds a parent directory holding a workbench (with `repos.yaml`) and a nested code repo, whose `.claude/settings.json` registers a stub hook that blocks `Write` and logs every call. It then feeds `repo-hooks.mjs` hook payloads directly and asserts:
  - a `Write` into the repo is blocked with the stub's message;
  - a `Write` outside every listed repo runs nothing;
  - a `Bash` with `git -C <repo>` runs the repo's Bash hooks, and one with no determinable repo runs none;
  - with the session root set to the repo itself, nothing is forwarded;
  - a crashing stub is reported as a block.

  This feeds payloads straight to the hook script and needs no model call. The end-to-end fact it rests on, that a parent-rooted session skips a nested repo's hooks, is the 2026-10-06 test, recorded in the hook's header comment.
- `eval/lane-plan.mjs`, for E17b. It scaffolds a workbench and a git repo, commits two specs, and runs `lane-plan.mjs`. It asserts:
  - `Status: approved` and `Branch:` match the patterns `spec-gate-guard.mjs` reads (`^Status:\s*(\S+)`, `^Branch:\s*(\S+)`), copied into the eval with a "change both" note;
  - one task row per acceptance criterion, with `rule_id`s preserved;
  - each refusal: dirty specs, wrong branch, unfinished plan present;
  - `--amend` logs to `## Amendments` and re-approves;
  - `slice-review.mjs` reports a hand-edited `## Spec`.
- **Once by hand, end to end:** a session started in a project's parent directory, a `bigin-harness-setup` repo with its real guards, one lane, and one ≥20-line edit that is allowed under the generated plan and blocked under `Status: amending`. The guards' logic belongs to `bigin-skills` and can change under us, so this is re-run when the installed `bigin-skills` version changes.

## Phasing

1. **E17a and E17b together (0.29.0).** E17a alone would block every lane on the spec gate, and E17b alone would write plans for a gate that never runs. Together they turn the harness on for lanes with a real approval behind its spec gate. Any existing rebuild that upgrades mid-project gets guards it has never run under. The upgrade note says so, and the first slice after upgrading should expect bash-guard, bugfix-test and spec-gate blocks on habits those guards were installed to stop.
2. **E18 (0.30.0).** It changes how lanes are dispatched and adds a step to every slice, so it ships separately. That way a problem in the loop can be backed out without losing E17.

## Open questions

- **A `bigin-skills`-side fix instead of a forwarder?** The harness could register its guards somewhere a parent-rooted session loads, but Claude Code offers no per-subdirectory hook scope, so there is no obvious place to put them. A forwarder on the pipeline's side is the fix available today. If Claude Code gains nested-project hook loading, E17a becomes redundant, and the hook should detect that and stop forwarding rather than run every guard twice.
- **Bash calls with no determinable repo.** A lane running `go test ./...` after an earlier `cd` in a separate call shows no repo in the command itself. Recommendation: the build-lane brief tells lanes to run commands as `cd <worktree> && …` or `git -C <worktree> …` in a single call, which also makes their logs readable. The forwarder reports undeterminable calls once per session rather than guessing.
- **A `bigin-skills`-side marker?** The guard could accept something like `Approved-by: external <workbench>@<sha>`, so that a pipeline-written plan is distinguishable from a task-workflow one in the code repo's history. That's cleaner, but it's a change to another plugin. Recommendation: ship E17 without it. The `Approved:` line already carries the provenance, and the guard ignores lines it doesn't read.
- **Should the `## Spec` hash mismatch fail rather than advise?** A lane that rewrote its own approved spec is the exact failure E17 exists for. But `slice-review.mjs` is advisory by design, and making one of its checks fatal changes what it is. Recommendation: advisory in the slice review, plus a line in the gate-5 review when any mismatch was ever reported. Revisit if it happens.
- **`SPECKIT = coexist` repos**, where the harness writes the guard but registers it nowhere. `lane-plan.mjs` still writes the plan, which is harmless, and E18's verifier still reads it. Nothing to change, but `g5-build.md` should say so in one line.
- **One plan per lane, or per module?** A lane can own several modules (several specs). One plan per lane keeps one plan per worktree, which is what the guard needs. Task rows carry the module in their AC id, so nothing is lost.
