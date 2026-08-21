# G5 — Parallel spec & build, per slice

Goal: maximum safe fan-out, one slice at a time. Lane COUNT is an output of Gates 1 and
3, not a constant. Work happens in code repos; the workbench is read-only input
(submodule pinned to gate tags).

**The first time a code repo is created**, do all five of these — the repo is not set up
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

1. **Specs + AC** — dispatch `spec-writer` per module in the slice. Spec inputs: the
   module's matrix features + flows + ground truth + contracts. Every spec ends with
   acceptance criteria: testable behaviors, each mapping 1:1 to an E2E/integration
   test. Where behavior is ambiguous, the RUNNING REFERENCE is the arbiter — check it,
   never guess. Specs pass user review (propose-before-act) before any code.

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

Between slices: run G6 parity, then return here for the next slice.
