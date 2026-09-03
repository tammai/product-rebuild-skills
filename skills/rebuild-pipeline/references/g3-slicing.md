# G3 — Milestone slicing → GATE 2: slice-plan lock

Goal: "full features" is the fixed destination, so decide SEQUENCE, not scope.
Vertical, independently shippable slices ordered by dependency and learning value.

## Rules
- Vertical: each slice cuts data model + API + UI for a coherent feature set. Never
  "all backend first". For a `client-only` rebuild there is no API layer to build, so
  vertical means local store + API integration + screen — the same rule with the middle term
  changed, and "all the data layer first" is the failure it still prevents.
- Dependency-ordered: compute the graph from ground truth (entity refs, permission
  prerequisites). Typical spine: auth+tenancy → core domain loop → collaboration →
  reporting/integrations/admin. The reference's own changelog order is a sanity check.
- Learning-weighted: where the graph allows choice, prefer the slice teaching a
  lifecycle stage not yet done (first deploy, first live migration, first background
  job, first realtime feature). ASK the user which lifecycle stages they most want.
- Every slice has `done_means` phrased as user-visible behavior on a DEPLOYMENT. For a client
  app that means an installable build on a device that is not the build machine — see
  `g5-build.md`.
- **For a rebuild replacing an app that already has users**, one slice ordering constraint is
  not negotiable: whichever slice first touches session or local data carries the on-device
  migration decided at Gate 3, and its spike happens before that slice starts. Do not let it
  drift to the last slice with the rest of the release work — it is the piece that runs once
  per user with no undo, and it wants the most runway, not the least.

Output: `plan/slices.yaml` per `schemas/slice.schema.json`. Draft with agents, order
with the user.

## Gate 2 review (present to user)
- The slice sequence with dependencies and learning goals; where you traded strict
  dependency order for learning value.
- Rule after lock: new ideas and upstream changes enter the backlog at slice
  boundaries; they never reorder slices mid-flight.

Lock only on explicit approval: `gate.mjs lock gate-2`.

## Right after the lock: record the sequence

```sh
npm run sequence -- init      # writes plan/sequence.yaml, baseline = order = the locked plan
```

**What gate-2 locks and what it does not.** Gate 2 hashes `plan/slices.yaml` whole, so what is
IN each slice — `features`, `depends_on`, `done_means` — is immutable until a formal reopen.
That is right: those are the boundaries. But the file is an ARRAY, so *order* was locked by the
same hash, which made the one thing this phase calls the decision ("decide SEQUENCE, not scope")
the most expensive thing in the pipeline to revise — a reopen, a new hash, and a moved submodule
pin for every code repo, all to say "build S6 before S4".

The predictable outcome of that is not an order that never changes. It is an order that changes
in someone's head and nowhere on disk. So the sequence moves to `plan/sequence.yaml`, ungated,
where revising it is a *logged decision* — `npm run sequence -- reorder <Sn> --before <Sm>
--reason "..."`, appended to `plan/sequence-decisions.md`. Same register as a gate reopen: a
human decides, the reason is written down. Cheap in mechanism, deliberately not cheap in ceremony.

Three things the script refuses, so "cheap" never means "unconstrained":

- **While a slice is in progress.** Reordering is a between-slices act. A finding that lands
  mid-slice goes in `plan/progress.yaml` `notes:` on the slice you are *in*; it reaches the
  parity report and the next slice review by itself, and gets acted on at the boundary.
- **Moving anything in the frozen head.** Only the pending tail reorders. The past is not a plan.
- **Any order violating `depends_on`.** That field is gate-2 locked, so a violating order is a
  contradiction between two artifacts rather than a preference. The dependency graph is
  machine-checkable; the learning-value tradeoff above is not, and the script does not pretend
  otherwise — that half stays yours.

After a gate-2 reopen that adds or drops a slice, `npm run sequence -- sync` reconciles the two
files. It needs no reason: the decision was the reopen. `validate.mjs` fails on an order that is
not a permutation of the slice plan, because a slice missing from the order is a slice that
never runs.
