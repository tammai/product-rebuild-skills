# G5 — Parallel spec & build, per slice

Goal: maximum safe fan-out, one slice at a time. Lane COUNT is an output of Gates 1 and
3, not a constant. Work happens in code repos; the workbench is read-only input
(submodule pinned to gate tags).

**The first time a code repo is created**, do all six of these — the repo is not set up
until they are:

0. **Create it with `bigin-skills`, never by hand.** `bigin-skills` is this pipeline's
   baseline: it owns app scaffolding and the AI-governance harness, and this pipeline owns
   none of it. From an **empty directory**, invoke the `bigin-skills:bigin-harness-setup`
   skill. It is the single entry point — its Phase 0.5 delegates to the matching
   `*-scaffold` skill's deterministic script, then overlays the governance harness
   (`CLAUDE.md`, path-scoped `.claude/rules/`, commit-time guard hooks) on top. Do **not**
   invoke `go-scaffold`/`nuxt-scaffold`/`nodejs-scaffold`/`next-scaffold` yourself, do not
   scaffold conversationally, and do not hand-write a `CLAUDE.md` — all three produce a repo
   that diverges from every other repo in the org, which is the whole reason the baseline
   exists.

   Profile follows Gate 3's stack ADR, not a fresh decision: Go backend → `go`, Fastify
   backend → `nodejs`, Nuxt frontend → `nuxt`, Next frontend → `next`. The harness skill
   will ask if it can't detect one — answer from the locked ADR.

   **Read the profile off the locked playbook, never off the stack you see in the code.**
   `adr/playbook.md`'s `scaffold-profile:` frontmatter names it, and that is a Gate 3 fact.
   The Flutter client playbook resolves to profile `flutter`, which needs `bigin-skills`
   >= 1.68.0 — its Phase 0.5 delegates to `flutter create`, and the harness then installs the
   rules, **both** lint commands (`custom_lint` for `riverpod_lint`, `import_lint` for the
   boundaries — they are separate tools), CI, and the pre-commit gate. Check the installed
   version before assuming the profile exists.

   **The fallback, for a playbook whose stack the installed `bigin-skills` has no profile
   for.** This is the one documented exception to "never scaffold outside
   `bigin-harness-setup`", and it is keyed to that absence, not to convenience:
   - The empty-repo question offers only the profiles that plugin version ships, with no
     "none of these" answer, and its stack-neutral `generic` profile is reachable **only**
     from a directory that already contains code. So an empty directory plus an unsupported
     stack is an unsatisfiable pair of rules; pretending otherwise means either stalling or
     picking a profile that writes conventions for a stack that is not there.
   - Correct order in that case: **run the stack's own official scaffolder first** (with the
     package name and org from the locked ADR), commit it, *then* invoke
     `bigin-harness-setup` over the now-non-empty repo. It detects no marker, lands on
     `generic`, and installs `CLAUDE.md`, the path-scoped rules, and the commit-time guard
     hooks. Then add the workbench submodule.
   - **Know what `generic` skips, and close the gaps yourself from the playbook**: no
     scaffold phase, no stack conventions or testing rule, no `.vscode` settings, **no CI
     workflow at all**, and any lint/typecheck/test command it could not detect stays a
     visible `TODO`. The CI file is then yours to write, from the playbook's own CI section.
     Do it in the first slice; a repo whose harness installed a `TODO` where the test command
     goes has a commit hook that runs nothing.
   - This is **not** licence to hand-roll a repo for a stack that *does* have a profile. If
     the profile exists, use it; if the playbook names one the plugin does not have, say so
     out loud before falling back, because the gap is usually a plugin version, not a
     permanent fact.
   - Everything else in this checklist still applies unchanged either way: register in
     `repos.yaml`, remote with posture-matching visibility, confirm `pause-check` sees it,
     decide what the remote is for.

   Three things about the order, each of which breaks the run if got wrong:
   - **Scaffold into the directory while it is still empty, then add the workbench
     submodule.** Every `*-scaffold` script refuses a non-empty target directory. A repo
     that already contains the pinned workbench submodule still has no `go.mod`, so
     `bigin-harness-setup` fires Phase 0.5 anyway and the script it delegates to fails on a
     directory it considers dirty. Submodule after, always.
   - **The scaffold makes its own initial commit** (`git init` + commit is part of its
     verify pass). So step 2's `gh repo create --source . --push` runs *after* it, against
     a repo that already has history — not before.
   - **The scaffold's `openapi.yaml` is a starter file, not the contract.** `go-scaffold`
     ships a spec for its own auth kernel. Gate 4 locked the real one in the workbench's
     `contracts/`. Replacing it is the first commit after scaffolding, before any codegen
     is trusted — otherwise commit 1 already violates this phase's own guardrail ("no code
     against interfaces absent from locked contracts"), and every generated type descends
     from a spec no gate ever saw.

   **What the scaffold hands you for free, and why that is a bookkeeping problem.** A
   scaffolded backend arrives with a working auth kernel — signup, login, refresh-token
   rotation, logout, profile, admin user management — plus rate limiting, CORS and health
   probes. That is real feature-matrix surface delivered before the slice that planned it.
   Record it in `plan/progress.yaml` as delivered-by-scaffold the moment the repo exists.
   Unrecorded, it is indistinguishable from scope creep to G6's parity check, and the first
   parity report of the project opens with a false positive.

1. **Register it** in the workbench's `repos.yaml` (`name` + `path` relative to the
   workbench root). `scripts/pause-check.mjs` reads this list; an unregistered repo is
   invisible to it and never checked before a session pauses.
2. **Give it a remote**, visibility per `license-posture.md` — private unless the posture is
   `permissive-reference`:
   `gh repo create <repo-name> --private --source . --push`
3. **Confirm it is actually covered**: run `npm run pause-check` from the workbench and check
   the new repo appears by name in the report. Registering is not the same as being checked —
   a one-character typo in `path:` (or a path relative to the wrong directory) shows up as
   `registered in repos.yaml but this path does not exist … — nothing about this repo was
   checked`. Without this confirmation nothing else ever catches it, and the repo goes
   unchecked for uncommitted and unpushed work for the rest of the project.
4. **Decide what the remote is for, and say it out loud.** Two different things get called
   "the repo has a remote":
   - *Durability only* — CI runs locally or on your own infrastructure. Then **disable Actions
     on the remote**, or every push emails you a failure:
     `gh api -X PUT repos/<owner>/<repo>/actions/permissions -F enabled=false`
   - *Also running CI on the host* — then the workflow has to actually work there, which for
     this pipeline's repos it does not by default. See the trap below.

**The private-submodule trap.** A code repo that checks out with `submodules: true` will fail
on GitHub Actions the first time it is pushed, with `fatal: repository '...workbench' not
found`. That is not a missing repo and not a bad token — `GITHUB_TOKEN` is scoped to its own
repository, so a private sibling reads as 404. Fixing it properly means a read-only deploy key
on the workbench plus a manual `git submodule update` over SSH (which preserves the gate-tag
pin; a second `actions/checkout` of the workbench does not). Only worth doing if CI on the host
is actually wanted — for a durability-only remote, disabling Actions is the honest answer.

Two more reasons a workflow written for local execution fails on a hosted runner: it needs
secrets that were never set there, and it reads paths that `.gitignore` keeps out of the repo
(deploy state files are the usual culprit). Check both before assuming a green CI is one fix
away.

If the repo pins the workbench as a submodule with a **relative** URL (`../<name>-workbench`),
push the workbench remote first and keep both repos under the same owner: the relative URL
then resolves against the code repo's own remote, so a fresh
`git clone --recurse-submodules` works with no per-machine configuration.

5. **Write `.rebuild-workbench` at the repo root**, holding the path to the **live**
   workbench — one line, absolute, or relative to this repo:

   ```sh
   echo "/abs/path/to/<name>-workbench" > .rebuild-workbench
   git add .rebuild-workbench && git commit -m "chore: point at the rebuild workbench"
   ```

   This is how `runbook-guard.mjs` finds the workbench, and it cannot use the submodule for
   it: the submodule is checked out at a **gate tag**, so its `plan/progress.yaml` is frozen
   at Gate 4 and can never know which slice is in progress — slices happen after that tag.
   The marker is the live pointer; the submodule is the pinned contract. Both, for different
   jobs.

   A repo without the marker is simply unguarded — the hook fails open. That is the correct
   behaviour for every repo in the world that is not part of this project, and it is also why
   writing the marker is a checklist item rather than something inferred.

## Per-slice sequence

0. **Record this slice's AC flows against the legacy app — before any module starts.**
   Applies when the locked playbook says so: `playbooks/mobile-flutter.md` §15, i.e. a
   `client-only` mobile rebuild whose legacy app is still runnable. Other shapes and
   playbooks skip step 0 entirely; their AC suite is written with the code, as step 1 has
   always said.

   The precondition, checked before dispatching anything: every acceptance criterion in this
   slice has a Maestro flow under the workbench's `parity/flows/<feature-id>/`, and
   `maestro test parity/flows/<feature-id>` is **green against the legacy app**. If flows are
   missing or red there, recording them *is* this slice's first work — not a prerequisite
   somebody else clears.

   **Refuse to start the slice otherwise, and name the missing flows** rather than starting
   the modules and circling back. A flow written after the rebuild exists is a flow written
   against the rebuild: it asserts what was built, says nothing about the reference, and
   every later run agrees with the code by construction. That property cannot be recovered
   afterwards short of reinstalling the old app and re-recording — which is exactly the work
   that was skipped, now with a build in the way.

   Where a flow genuinely cannot be recorded — Maestro cannot drive that surface, or the
   legacy app no longer builds that screen — record *that*, per flow, in the flow file's
   header. It is then a normal test rather than a parity test and the slice proceeds. An
   unrecorded flow nobody declared is indistinguishable from one nobody wrote, which is how
   a parity suite quietly becomes a regression suite.

0a. **Record this slice's equivalence traces against the legacy system — before the backend
   lane starts.** Applies when `reference.kind: own-code` and the E4 preflight says the
   reference runs; every other project skips it and `parity.mjs` says the lane does not apply.
   This is step 0's `fullstack` branch: where a `client-only` mobile rebuild records Maestro
   flows against the old app, a rebuild that owns a backend records what the old **system**
   returned.

   For each feature in this slice, author the requests out of its UX flows and Rule Cards, then:

   ```sh
   npm run equiv -- record <feature-id>   # writes parity/equiv/<feature-id>/*.trace.yaml
   git add parity/equiv && git commit -m "equiv: record traces for <feature-id>"
   ```

   **The order is the whole property, exactly as it is for flows.** A trace recorded after the
   rebuild exists is derived from the rebuild: it asserts what was built, says nothing about the
   old system, and every later replay agrees with the code by construction. Unlike a flow, this
   one cannot be recovered at all once the legacy system is decommissioned — which on a
   replacement project is a scheduled event, not a hypothetical.

   Commit them before the lane starts. A committed trace is protected by the hook; an
   uncommitted one is still being recorded and stays editable.

0b. **Load the build runbook — S2 onward, before dispatching any lane.** Read
   `plan/BUILD_RUNBOOK.md` and pass it as a fixed input in every backend, frontend and infra
   brief (`subagent-briefs.md` part 2). It is not optional context: it is what S1 learned
   about this project's codegen, harness, reference quirks, fixtures and deploy
   prerequisites, and a lane that does not read it will rediscover all of it at full price.

   **A hook enforces this**, because an instruction the orchestrator applies to itself
   mid-slice is a budget and a hook is a limit — the same argument that made `gate-guard` a
   hook. `runbook-guard.mjs` blocks any write into a code repo while `plan/progress.yaml`
   shows a slice other than S1 `in-progress` and the runbook is absent. It finds the live
   workbench through the `.rebuild-workbench` marker at the repo root (step 5 of the repo
   checklist), and fails open when the marker is missing — so a repo created before this
   shipped is unguarded rather than broken.

1. **Specs + AC** — dispatch `spec-writer` per module in the slice, briefed per
   `subagent-briefs.md` — including part 6, the model `scripts/routing.mjs` resolved for this
   role, which is the standard tier. Spec inputs: the
   module's matrix features + flows + ground truth + contracts, **plus
   `findings/rules/<domain>.yaml` for every domain the slice touches** — a fixed input, not
   an optional one. Specs are written to `plan/specs/<Sn>/<module>.md` in the workbench (they
   describe the product; code repos reach them through the submodule pin). Every spec ends
   with acceptance criteria: testable behaviors, each mapping 1:1 to an E2E/integration
   test. Where behavior is ambiguous, the RUNNING REFERENCE is the arbiter — check it,
   never guess. Specs pass user review (propose-before-act) before any code.

   **Every acceptance criterion that implements a Rule Card carries `rule_id:`.** This is
   the join that makes lane R worth mining: without it the cards are a document nobody reads
   at the moment they are needed, which is precisely the state G1 mined them out of. It buys
   three things that did not exist before — `validate.mjs` reports the share of criteria in
   rule-bearing domains that cite no rule, `acsuite.mjs` and `parity.mjs` can say "12 of 14
   rules in `billing` are green" rather than only counting features, and a criterion that
   drifts from the reference has a locked, cited card to be wrong against.

   **Name the `rule_id` in the test too.** The AC→test mapping is 1:1, so the test that
   implements a criterion carries that criterion's rule id in its name (or its `classname`).
   That string is the only thing the JUnit output carries, and it is what the per-rule column
   groups on — a test that implements a rule but never names it is invisible to the rules
   table and reads there exactly like a rule with no test at all.

   **Where the card and your reading disagree, stop.** The card is gate-1 locked and carries
   `path` + `commit` + `line` into the reference's own source. A spec quietly specifying
   something else is the drift lane R exists to prevent, arriving by a different door.

   **Price the DEPLOY criterion's prerequisites while writing it, not when running it.**
   For each deploy AC, name what has to exist for it to run at all — which operation
   creates the state it asserts on, which credential, which network path — and check each
   one is reachable through the locked contract. A criterion nobody can execute is
   indistinguishable from a passing one right up to the end of the slice, and by then the
   code is written: one project found its two hardest deploy ACs unrunnable *after* the
   whole slice was built and pushed, for two independent reasons, one of which was a Gate 4
   reopen. Both were answerable in a minute at spec time.
2. **Backend** — one lane per bounded context touched (module or service per Gate 3).
   On the first slice this is where the repo checklist above runs (`bigin-harness-setup`,
   then the locked contract replacing the scaffold's starter spec); on every slice after,
   the repo already exists and this step starts at codegen from `contracts/`.
3. **Frontend** — same: first slice creates the repo through `bigin-harness-setup` (`nuxt`
   or `next` per Gate 3), thereafter build against the generated typed client. May split
   per feature area.

   **For a `client-only` rebuild, this lane is the whole build** and lane 2 does not exist —
   there is no backend to write. It splits per feature module instead of per bounded context,
   still one agent per module, still against a **generated** client (from the frozen
   `contracts/openapi/`, committed, with CI regenerating and diffing it). The migration work
   the `on-device-migration` ADR decided is its own module in whichever slice first touches
   session or local data — never a task appended to a feature module, because it is the one
   piece of code that runs once per user with no undo.
4. **Infra** — CI/CD, environments, deploy. Migrations serialize through ONE queue
   regardless of lane count.

## Guardrails you enforce as orchestrator
- No code against interfaces absent from locked contracts (hook also blocks workbench
  edits — if an agent needs a contract change, that is a Gate 4 conversation).
- **The baseline is not optional and not partially adoptable.** Every code repo is created
  by `bigin-skills:bigin-harness-setup` and keeps what it installed. Deleting its guard
  hooks, rewriting its `CLAUDE.md` wholesale, or swapping the scaffolded stack for a
  hand-rolled one is a Gate 3 conversation (it contradicts the locked stack ADR), not a
  lane-level decision.
- CI per lane: lint, tests, security scan, license scan, AC-coverage (every AC has a test).
  The scaffold already wrote `.github/workflows/ci.yml` with lint/test/build — this
  pipeline's extra jobs (license scan, AC-coverage) are **added to that file**, not a
  second workflow written alongside it.
- Cross-lane shared changes go through one serialized review path.
- **"Deployed" for a client app means a build a real person can install** — an internal
  TestFlight or Play internal-track release, on a device that is not the build machine, with
  the version and build number recorded. Not "it runs in the simulator", and not "CI built an
  APK". A slice whose deploy criterion is satisfied by a simulator run has skipped the half of
  the curriculum that signing, provisioning, store processing and rollout actually teach —
  and every one of those fails for the first time on the day you need it to work.
- **The slice is not done until deployed** and its `done_means` demonstrably true —
  the deploy is half the curriculum. Confirm with the user before marking a slice done,
  and record it in `plan/progress.yaml`, never in the gate-locked `plan/slices.yaml` —
  see `g6-parity.md`. Use `deployed` rather than `done` when a `done_means` clause is
  knowingly unmet, so the status stays honest without switching off creep detection.
- **A verification script names only what it RAN.** Skip modes, partial runs and
  human-blocked steps must not print a banner covering criteria they skipped, and a
  criterion whose step could not execute is reported PENDING rather than silently omitted
  from the tally. This is the same failure as a vacuous test: the artifact a human reads
  afterwards is the banner, and one that overclaims is worse than no script.

## The first slice whose deploy criterion needs the OUTSIDE WORLD to reach in

Every deploy criterion up to that point is outbound — the rebuild calls a provider — and
`localhost` serves it fine. The first inbound one (a webhook delivery, an OAuth redirect
that must resolve, a CI runner posting a result) needs something structurally different,
and it is worth naming before the slice rather than discovering mid-verification:

- **A public origin, as configuration.** The URL a provider is told to call has to be
  built from a configured base, not assembled from a request or defaulted to localhost. A
  plausible-looking default is worse than an absent one: registration succeeds and the
  silence afterwards has to be debugged.
- **A tunnel for local verification**, and it is not the same switch as any
  "allow loopback" flag the outbound side has. That one governs where *we* deliver to;
  this is where a *third party* delivers to, and loopback is never a valid answer.
- **A provider-side registration path.** Something must create the subscription and store
  whatever verifies its deliveries. Check it exists — this is the read-with-no-writer trap
  in `g4b-contracts.md`, and the inbound leg is where it hides best, because the receiver
  looks complete on its own.
- **Watch the credential's shape.** A machine credential presented by CI usually is not a
  bearer token, and sending it as one produces a 401 that reads like an infrastructure
  problem from inside a CI job. Check the scheme before blaming the tunnel.

## Between slices — the boundary is the only cheap place to change the plan

Four steps, in order, then return here for the next slice:

1. **Record the slice's outcome** in `plan/progress.yaml` — `slices:` *and* `features:`.
   Filling in only the first is the natural thing to do and it is the documented trap: every
   feature then falls through to `matrix/features.yaml`'s `status:`, which is gate-1 MINING
   output about the reference, and the two vocabularies share the words `covered`, `partial`
   and `missing` so nothing looks wrong.
2. **Run G6 parity** — `g6-parity.md`.
3. **Run the slice review** — `npm run slice-review -- <Sn>`. Generated from what is on disk,
   never composed: does the whole product still run (cumulative AC suite, and what regressed
   since the last run), what shipped, where that puts us in the order, what is pressing on the
   plan. **Advisory** — it locks nothing and blocks nothing. Present it, and say what you think.
4. **Act on the plan now, or not at all until the next boundary.** Slice *order* is
   `npm run sequence -- reorder <Sn> --before <Sm> --reason "..."` — logged, cheap, and refused
   once the next slice starts. What is IN a slice is still a gate-2 reopen.
5. **Write the build runbook (S1 only), or amend it (every boundary after).**

**After S1: write `plan/BUILD_RUNBOOK.md`.** S1 is where the locked contracts, the harness
scaffold and the reference's quirks first meet each other, and until this file exists none of
what it taught is anywhere S2's agents will read. Write it **from what the S1 lanes reported**,
not composed from memory — the same rule as the slice review, for the same reason: a runbook
that is a recollection of a build is a recollection, and it will be read as fact by an agent
that was not there.

Sections are fixed, so a later reader knows where to look and a later writer knows where to add:

```md
# Build runbook — <project>

Written at the S1 boundary from what the S1 lanes reported. Required reading for every
backend, frontend and infra lane from S2 on (`runbook-guard.mjs` enforces it). Append
amendments; never rewrite.

## Codegen from contracts/
How it was invoked, verbatim. What it got wrong, and what was done about it.

## Harness quirks
What `bigin-harness-setup` produced that needed adjusting, and why. Anything its CI wrote
that does not work for this project's shape.

## Reference behaviors the spec did not say
What the running instance turned out to do that the spec, the flows and the contracts all
missed. This section is the one that saves the most time and is written last, because it is
only visible in hindsight.

## Test fixtures
How fixtures are built, where they live, what they share, what must never be shared.

## Deploy prerequisites
What had to exist before the deploy criterion could run at all — credentials, network paths,
accounts, a store listing. Name the ones that turned out to be missing.

## Commands that worked
Verbatim, copy-pasteable, with the directory they run in.
```

**After every later slice: append `## Amendment after S<n>`, dated. Never rewrite.** The
runbook is a record of what was learned and when; rewriting it destroys the sequence, and the
sequence is what tells a reader whether a claim predates the thing they are debugging.
`slice-review.mjs`'s fifth question puts the diff since the previous boundary in front of you at
exactly the moment to answer it, and records what you did in `plan/progress.yaml`'s
`runbook_amended:` — a boundary that wrote nothing is visible, which is the point.

**The circuit breaker is on the runbook, not on the agent.** If two lanes in one slice both
report that a runbook step failed, stop dispatching, write the failure into the runbook as an
amendment, and ask the user before continuing. Two independent lanes hitting the same step is
not two bugs; it is the runbook being wrong, and every further lane you dispatch will hit it
too.

**The one thing that has no home anywhere else** is step 3's regression check. Every deploy
criterion in this phase asserts only its own slice's features, so "did S3 break S1" was a
question the pipeline could not answer — the AC pass rate is one number, and a number that moves
does not say which way or which test. The review compares this run against the previous one by
test name. Both files are already on disk; nothing new has to be run to get it.

**A finding that arrives mid-slice does not wait in someone's head.** Write it to
`plan/progress.yaml` `notes:` on the slice you are *in* — "S6 has no dependents, could come
before S4". `parity.mjs` already carries notes into its report and the slice review surfaces
them beside the reorder candidates, so an observation recorded at the moment it is real gets
acted on at the moment it is safe. That is also why `sequence.mjs` refuses to reorder while a
slice is in progress: the finding is welcome, the mid-flight reshuffle is not.
