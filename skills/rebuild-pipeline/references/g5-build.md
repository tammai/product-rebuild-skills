# G5 — Parallel spec & build, per slice

Goal: maximum safe fan-out, one slice at a time. Lane COUNT is an output of Gates 1 and
3, not a constant. Work happens in code repos; the workbench is read-only input
(submodule pinned to gate tags).

**The first time a code repo is created**, add it to the workbench's `repos.yaml`
(`name` + `path` relative to the workbench root) — `scripts/pause-check.mjs` reads this
list to know which repos to check for uncommitted work before a session pauses. An
unregistered repo is invisible to that check.

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
  the deploy is half the curriculum. Confirm with the user before marking a slice done
  in `plan/slices.yaml` (status field).

Between slices: run G6 parity, then return here for the next slice.
