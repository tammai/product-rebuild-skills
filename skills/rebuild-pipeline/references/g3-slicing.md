# G3 — Milestone slicing → GATE 2: slice-plan lock

Goal: "full features" is the fixed destination, so decide SEQUENCE, not scope.
Vertical, independently shippable slices ordered by dependency and learning value.

## Rules
- Vertical: each slice cuts data model + API + UI for a coherent feature set. Never
  "all backend first".
- Dependency-ordered: compute the graph from ground truth (entity refs, permission
  prerequisites). Typical spine: auth+tenancy → core domain loop → collaboration →
  reporting/integrations/admin. The reference's own changelog order is a sanity check.
- Learning-weighted: where the graph allows choice, prefer the slice teaching a
  lifecycle stage not yet done (first deploy, first live migration, first background
  job, first realtime feature). ASK the user which lifecycle stages they most want.
- Every slice has `done_means` phrased as user-visible behavior on a DEPLOYMENT.

Output: `plan/slices.yaml` per `schemas/slice.schema.json`. Draft with agents, order
with the user.

## Gate 2 review (present to user)
- The slice sequence with dependencies and learning goals; where you traded strict
  dependency order for learning value.
- Rule after lock: new ideas and upstream changes enter the backlog at slice
  boundaries; they never reorder slices mid-flight.

Lock only on explicit approval: `gate.mjs lock gate-2`.
