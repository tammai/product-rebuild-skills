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
