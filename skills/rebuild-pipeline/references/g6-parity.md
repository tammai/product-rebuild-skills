# G6 — Parity loop (automated)

Run after each slice and on schedule (monthly default).

1. **AC suite**: run the tests; "is the feature done" is a test result, not a meeting.

   Under `playbooks/mobile-flutter.md` §15 — a `client-only` mobile rebuild with a runnable
   legacy app — that suite has a name and a command. Run it from the workbench root against
   the rebuild's installed build:

   ```sh
   maestro test parity/flows --format junit --output parity/<date>-ac.xml
   ```

   The JUnit file lands beside the parity report, and step 2 reads it: the AC pass rate in
   `parity/<date>.md` is generated from that XML, not written by hand from a memory of the
   run. Use the same `<date>` for both or the report will not find it. Other shapes and
   playbooks run whatever their own AC suite is and record the result under a hand-written
   `## AC suite` heading, which `parity.mjs` preserves.
2. **Parity diff**: `node scripts/parity.mjs` from the workbench root — coverage vs `matrix/`:
   covered / partial / missing per feature, plus scope-creep detection (built but not
   in matrix). Report lands in `parity/<date>.md`.
3. **Upstream re-mine**: re-run lane A (changelog) against the reference's latest
   release; content-hashing surfaces only real changes. New upstream features enter the
   matrix as backlog candidates flagged for the next slice boundary — they NEVER bypass
   gates or reorder the current slice.

   **Skip this step entirely when `sources.yaml` has `reference.upstream: frozen`** — a
   legacy app being replaced has stopped shipping, so there is nothing to track. Say so in
   the report rather than silently omitting the section: "upstream frozen, no re-mine" is
   information; an absent section reads as a step that failed. Steps 1 and 2 do not change,
   and against a frozen reference they get *stronger*, because the parity target stops
   moving — a coverage number that drifts is then a fact about the rebuild, never about the
   reference.

   A frozen reference is also a permanent arbiter, which is the compensation for losing the
   re-mine: when a spec is ambiguous, the old app still answers, and it will answer the same
   way next month. Keep it installable for the life of the project — an archived build, a
   pinned commit that still compiles, a device that still has it. Losing the ability to run
   it costs more than any single finding, and it always happens by accident.

Present the report briefly: coverage %, AC pass rate, upstream movements, creep items.
Ask the user only when a decision is needed (e.g. adopt an upstream feature into the
backlog or ignore it with reason).

## The AC flows — `parity/flows/`, and the one rule with teeth

Applies under a mobile `client-only` playbook (`mobile-flutter.md` §15). Elsewhere this
section is inert.

**Where they live and why here.** `parity/flows/<feature-id>/*.yaml`, in the workbench. A
flow describes the product — what a user does and what must be true afterwards — which is the
workbench's charter, not a code repo's. Code repos reach them through the submodule pin they
already have, which also settles the versioning question for free: a repo checked out at
`gate-4/v1` sees exactly the flows that existed at that tag, and nothing else.

**Recorded against the legacy app first.** `g5-build.md`'s per-slice step 0 is the enforcement
point; the property it protects is that the suite is a *characterization* harness. A flow green
against the old app and then green against the rebuild is evidence of parity. A flow written
after the rebuild exists is evidence of nothing — it agrees with the code because it was
derived from it.

**They are not hash-locked, on purpose.** Flows are recorded per slice, so putting them inside
a gate's `protects:` would mean a formal gate reopen every slice — the bookkeeping-versus-
decisions line `plan/progress.yaml` already draws. Instead, one rule:

> **An assertion in a recorded flow changes only with a logged human decision.**

Same register as a gate reopen: a human decides, and the reason is written down. The failure
this exists to stop is specific and it is not hypothetical — an agent with a red build and a
flow in reach will loosen the assertion, and the result is indistinguishable from a build that
got better. Parity was silently redefined and the report still says green.

What is freely allowed, so the rule stays narrow enough to keep: recording new flows, adding
new assertions, fixing a selector that never matched anything, and deleting a flow for a
feature that was dropped from the matrix. What needs the logged decision: weakening or removing
an assertion that has ever been green against the legacy app.

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
