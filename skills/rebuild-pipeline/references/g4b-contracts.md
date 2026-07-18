# G4b — Data model + contracts → GATE 4: contract lock

Order matters: data model FIRST (Gate 3 decided where data lives; this decides what it
is), then three contract layers. Data model drafts sequentially; contracts then draft
per context in parallel.

## Data model
Per context: entities, ownership, relationships, source-of-truth per entity. Start from
the reference's schema (lane D) and ANNOTATE every deliberate deviation — deviations
change how reference behavior maps onto the rebuild. Cross-context references by ID
only, never shared tables.

## Contract layers → `contracts/`
1. `openapi/` — public API surface; single source of truth for generated types.
2. `internal/` — between contexts: in-process interfaces if co-located, per-service
   specs if separated (per Gate 3).
3. `asyncapi/` — every event/queue message schema, versioned.

All three CI-validated. Everything in G5 must trace to contract elements; anything not
in a contract does not exist.

## Gate 4 review (present to user)
Data model with deviations-from-reference; the three layers and their codegen status;
the change policy after lock: additive changes allowed within the tag series, breaking
changes reopen Gate 4 for the affected contract only and cut a new major gate tag.

Lock only on explicit approval: `gate.mjs lock gate-4`. Locking cuts the tag code repos
pin to (e.g. `gate-4/contracts-v1`).
