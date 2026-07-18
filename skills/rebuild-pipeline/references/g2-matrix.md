# G2 — Feature matrix → GATE 1: taxonomy lock

Goal: one canonical map — features × ground truth × flows, grouped into a domain
taxonomy. With source access, presence is deterministic; the work is ORGANIZATION.

## Steps
1. Merge lanes per feature (agentable): join lane-D facts with lane A/C context; keep all
   evidence. Dedupe is minimal with a single reference.
2. Canonical naming: agent drafts, user spot-checks.
3. Taxonomy — USER decision, propose-before-act: group features into domains. The
   taxonomy is the first draft of bounded contexts (G4a inherits it). Advise the user:
   cut domains the way THEY would design the system; keeping the reference's module
   structure is itself a mirror decision worth noting for G4a.
4. Attach per feature: flows, entities, routes, permission rows, `first_shipped`.

Output: `matrix/features.yaml` per `schemas/feature.schema.json`.

## Gate 1 review (present to user)
- Domain list + boundaries, with the 3–5 judgment calls you made and alternatives.
- Coverage stats: features total, with ground truth, with flows, low-confidence count.
- What locks: domain structure and canonical names. Agents may still ADD findings into
  the taxonomy afterward, never restructure it.

Lock only on explicit approval: `gate.mjs lock gate-1`.
