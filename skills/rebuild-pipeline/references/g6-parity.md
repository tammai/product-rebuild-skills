# G6 — Parity loop (automated)

Run after each slice and on schedule (monthly default).

1. **AC suite**: run the tests; "is the feature done" is a test result, not a meeting.
2. **Parity diff**: `node scripts/parity.mjs` from the workbench root — coverage vs `matrix/`:
   covered / partial / missing per feature, plus scope-creep detection (built but not
   in matrix). Report lands in `parity/<date>.md`.
3. **Upstream re-mine**: re-run lane A (changelog) against the reference's latest
   release; content-hashing surfaces only real changes. New upstream features enter the
   matrix as backlog candidates flagged for the next slice boundary — they NEVER bypass
   gates or reorder the current slice.

Present the report briefly: coverage %, AC pass rate, upstream movements, creep items.
Ask the user only when a decision is needed (e.g. adopt an upstream feature into the
backlog or ignore it with reason).

## Recording progress — `plan/progress.yaml`, never the locked artifacts

At slice completion, write status to **`plan/progress.yaml`** (ungated, validated against
`schemas/progress.schema.json`):

```yaml
slices:   { S1: deployed }
features: { F-API-001: covered }
notes:    { S1: "one-line asterisk carried into the report" }
```

`parity.mjs` overlays it onto `matrix/features.yaml` and `plan/slices.yaml` — an entry here
wins, anything absent falls back to the locked `status:`.

Do **not** edit the `status:` field inside those two files. They are hashed whole by gate-1
and gate-2, so writing bookkeeping into them costs a formal reopen per slice and rewrites the
hash that dependent submodule pins consume. Gates protect decisions — the taxonomy and the
slice boundaries — not progress. (A workbench scaffolded before this file existed still works:
`parity.mjs` warns and falls back to locked statuses.)

Two behaviors worth knowing:

- **`deployed` counts as shipped** for scope-creep detection, alongside `done`. Use it when a
  slice ships with a `done_means` clause knowingly unmet, so the creep check still runs instead
  of going inert. Reserve `done` for a slice that meets its criteria outright.
- **Hand-written sections survive a re-run.** The script owns the coverage line and the Missing
  / Partial / Upstream-candidates / Slice-progress sections; any other `## ` section — the AC
  suite result, the re-mine writeup — is preserved, and re-running on the same date is
  idempotent.

Record only what an observed test or a deployed run demonstrates. A deferred acceptance
criterion is never `covered`.
