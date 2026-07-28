# G5 — Parallel spec & build, per slice

Goal: maximum safe fan-out, one slice at a time. Lane COUNT is an output of Gates 1 and
3, not a constant. Work happens in code repos; the workbench is read-only input
(submodule pinned to gate tags).

**The first time a code repo is created**, do all four of these — the repo is not set up
until they are:

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
   Scaffolding + codegen from contracts first.
3. **Frontend** — against the generated typed client; may split per feature area.
4. **Infra** — CI/CD, environments, deploy. Migrations serialize through ONE queue
   regardless of lane count.

## Guardrails you enforce as orchestrator
- No code against interfaces absent from locked contracts (hook also blocks workbench
  edits — if an agent needs a contract change, that is a Gate 4 conversation).
- CI per lane: lint, tests, security scan, license scan, AC-coverage (every AC has a test).
- Cross-lane shared changes go through one serialized review path.
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
