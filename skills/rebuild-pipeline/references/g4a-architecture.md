# G4a — System design → GATE 3: architecture lock

Goal: decide the system's shape as an explicit MIRROR-OR-DIVERGE exercise against the
reference. Most of the lifecycle learning concentrates here; budget real user time.

Inputs: locked taxonomy, locked slice plan, `nfr-profile.yaml`, lane-D architecture facts.

## Decision sequence (draft in parallel, decide sequentially)
1. Bounded contexts from taxonomy domains.
2. Decomposition per context: monolith / modular monolith / services — per-product
   decision by ADR. The reference's own choice is evidence, not a verdict. Never inject
   a default answer; the playbook mandates HOW to decide, not WHAT.
3. Cross-cutting concerns, one ADR each as applicable: authn/authz, tenancy, events/
   queues, storage, search, files/media, background workers, caching, observability.
4. Infra topology derived from decomposition.

Every ADR states: reference-approach (lane-D evidence) → mirror | diverge → rationale
(incl. learning goal if diverging) → consequences (incl. lane-D facts invalidated by
divergence) → reversal-condition. Undocumented divergence is the #1 failure mode of
the whole playbook — enforce the field.

Dispatch drafts to the `adr-drafter` agent (one per ADR, parallel). Present each to the
user for decision IN DEPENDENCY ORDER; later ADRs cite earlier ones.

## Gate 3 review (present to user)
Context map, decomposition per context, every ADR's mirror/diverge one-liner, topology
diagram. What locks: no new service, datastore, or queue downstream without reopening.
After lock: NOW code repos may be created (count comes from decomposition); wire each
to consume the workbench as a read-only submodule pinned to gate tags.

Lock only on explicit approval: `gate.mjs lock gate-3`.
