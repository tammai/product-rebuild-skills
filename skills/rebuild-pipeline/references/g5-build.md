# G5 — Parallel spec & build, per slice

Goal: maximum safe fan-out, one slice at a time. Lane COUNT is an output of Gates 1 and
3, not a constant. Work happens in code repos; the workbench is read-only input
(submodule pinned to gate tags).

**The first time a code repo is created**, do all three of these — the repo is not set up
until they are:

1. **Register it** in the workbench's `repos.yaml` (`name` + `path` relative to the
   workbench root). `scripts/pause-check.mjs` reads this list; an unregistered repo is
   invisible to it and never checked before a session pauses.
2. **Give it a remote**, visibility per `license-posture.md` — private unless the posture is
   `permissive-reference`:
   `gh repo create <repo-name> --private --source . --push`
3. **Decide what the remote is for, and say it out loud.** Two different things get called
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

Between slices: run G6 parity, then return here for the next slice.
