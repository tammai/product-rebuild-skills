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

## The callee check — run before every Gate 4 lock, including reopens

Ask, per module the slice touches: **which other modules does it CALL, and does each
callee's `internal/` contract actually expose the method being called?**

Do it as an explicit pass, not by reading the ADRs. An ADR's "contract changes" section
describes changes to the module the ADR is *about* — the caller. The gaps hide in the
**callees**: a module the new work depends on, owned by nobody in this phase, whose
interface silently lacks the one method the caller needs. Nothing flags it, because
every artifact in the phase is internally consistent; the mismatch only exists *between*
a caller's assumption and a callee's surface.

Two patterns that produce these, both worth checking by name:

- **A new writer for columns added this phase.** If the data model gains a field, some
  module has to set it. A required column whose only writer is a `Params` struct that
  does not carry it is a constraint that can never be satisfied — and a unique index on
  it will sit permanently unpopulated while reading as enforcement.
- **A cross-module write.** Module boundaries forbid writing another module's schema, so
  the write must go through that module's `Service` — which may expose reads only. Check
  every "X's data is created by Y" sentence in the data model against Y's actual
  interface.

Also check that no *capability* has two owners: if two contract files each claim the same
job, both implementations get built and the duplicate is a runtime bug, not a merge
conflict. Grep the phase's new prose for the same responsibility described twice.

If the phase's specs are already written, their §1 sections are the highest-signal input
here — but the point of this check is to run it *before* spec-writing, since a spec that
stops to flag a missing callee method has already cost the slice a gate reopen.

## Gate 4 review (present to user)
Data model with deviations-from-reference; the three layers and their codegen status;
the change policy after lock: additive changes allowed within the tag series, breaking
changes reopen Gate 4 for the affected contract only and cut a new major gate tag.

Lock only on explicit approval: `gate.mjs lock gate-4`. Locking cuts the tag code repos
pin to (e.g. `gate-4/contracts-v1`).
