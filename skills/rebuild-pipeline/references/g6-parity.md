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

4. **Slice review**: `npm run slice-review -- <Sn>` — the standing report for the boundary,
   written to `plan/slice-reviews/<Sn>.md`. Run it after step 2 so it can cite that report.

Present both reports briefly: coverage %, AC pass rate, upstream movements, creep items, and
from the slice review — what regressed since the last run, where the slice leaves the roadmap,
and which pending slices are orderable now. Ask the user only when a decision is needed (adopt
an upstream feature into the backlog or ignore it with reason; reorder the tail or leave it).

## The slice review — advisory, generated, and not a sixth gate

**What it adds that this phase does not.** `parity.mjs` answers *how much of the reference do
we cover* — a coverage diff against the matrix. Two questions it does not answer, and nothing
else did either:

- **Does the whole product still run?** Every per-slice deploy criterion asserts only that
  slice's own features, so a regression in an earlier slice had nowhere to surface. The review
  compares this AC run against the previous one **by test name** and names what was passing then
  and is not now. It also separates a failure that was *already* failing last run — no delta will
  ever surface that one again, and it has now survived a whole slice.
- **Where does that put us?** Position in the execution order, what is next, and which pending
  slices are orderable *right now* because their dependencies have shipped. That last one is the
  input to the reorder conversation this boundary exists for.

**Its coverage figure differs from `parity.mjs`'s, on purpose.** The review counts only
explicit `plan/progress.yaml` entries; parity fills gaps with `matrix/features.yaml`'s
`status:`. Both are right for their own question — parity's is about the reference, the
review's is about the rebuild — and the review prints the gap rather than letting two reports
quietly disagree. A matrix full of mined `covered` reads as a finished rebuild before a line of
code exists, which is exactly why a *standing* report cannot inherit that denominator.

**Generated, never written.** Every figure comes off disk. A slice review an agent composes is a
summary of what that agent believes it did — the failure `verifier`, `rubric-judge` and
g5-build.md's "a verification script names only what it RAN" all exist to prevent, and a slice
review is precisely the artifact that outlives the session that produced it. Judgement goes in
the conversation on top of the file, not inside it.

**And it is not a gate.** Gates are hash-pinned, tagged, and consumed by submodule pins; a
per-slice gate would mean a tag per slice and a formal reopen every time a review found
something. That is the bookkeeping-versus-decisions line `plan/progress.yaml` and
`parity/flows/` each drew already. So the review blocks nothing — `pause-check` mentions a
shipped slice that has none as a *note*, never as ⚠️, because a check that cries wolf about an
optional report takes the real warnings down with it. The teeth in this design are on the
**reorder**, not the review: `sequence.mjs` requires `--reason` and logs every move, so a plan
that drifts leaves a record even when nobody read the review.

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

**The mechanism, from 0.14.0.** A PreToolUse guard blocks Write/Edit on any flow file under
`parity/flows/` that git already tracks. *Committed* is the line on purpose: recording a flow
is iterative — write, run against the old app, tweak until green — and a guard that fired
through that loop would be switched off within a week. Committing the flow is the act that
says "this is the recorded reference".

To change one deliberately:

```sh
npm run flows -- unlock --reason "..."   # logged to parity/flows/DECISIONS.md
# make the change
npm run flows -- relock
```

`--reason` is required, exactly as it is for a gate reopen, and "the tests are failing" is not
one — that is the situation the rule exists for. `npm run pause-check` reports a workbench left
unlocked as unsafe to pause, because an unlock that outlives its change is a guard that is
simply off.

## Screenshots: reviewed evidence, never a gate

Visual comparison between the reference and the rebuild is worth doing and worth keeping. It is
not worth gating on, and the reason is structural rather than a matter of tolerance tuning: two
different rendering stacks do not produce the same pixels. React Native composes platform
widgets; Flutter paints its own. Text metrics, font fallback, shadow rasterisation, ripple
timing and scroll physics all differ *correctly*. A pixel gate over that produces failures on
every screen from day one, and a suite that is red for reasons nobody intends to fix gets
muted — which costs you the real regressions too.

So: capture before/after screenshots per flow, attach them to the parity report as evidence a
human looks at, and let a person say whether a difference matters. Record the verdict, not the
diff percentage. Goldens are a different tool for a different job — they catch *the rebuild*
drifting from itself on a pinned platform (`mobile-flutter.md` §15), and that comparison is
between two runs of the same renderer, which is why it can be a gate and this cannot.

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
