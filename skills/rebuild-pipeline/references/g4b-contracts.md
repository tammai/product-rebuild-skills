# G4b — Data model + contracts → GATE 4: contract lock

Order matters: data model FIRST (Gate 3 decided where data lives; this decides what it
is), then three contract layers. Data model drafts sequentially; contracts then draft
per context in parallel.

## Data model → `contracts/data-model/<context>.mermaid`

One Mermaid `erDiagram` per bounded context, named after the context in G4a's context map.
Per context: entities, ownership, relationships, source-of-truth per entity. Start from
the reference's schema — `findings/ground-truth/reference-erd.mermaid` — and ANNOTATE every
deliberate deviation inline with `%%`: deviations change how reference behavior maps onto
the rebuild, and a *structural* one (flattening a hierarchy, merging entities, dropping a
table the reference has) needed an ADR back at Gate 3, not a comment here. Cross-context
references by ID only, never shared tables — a relationship line crossing a context
boundary belongs in neither file and is a Gate 3 question.

Mermaid rather than prose because it is the one format that is diffable, renders in every
review surface, and states cardinality in the notation instead of in a sentence someone has
to interpret. A wrong FK on a diagram is a one-line edit; found after Gate 4 it is a
migration.

`npm run validate` requires every diagram here to declare **at least one entity** — an
`erDiagram` header alone is not a data model, and a scaffold stub would otherwise satisfy
the check forever. `gate.mjs lock gate-4` refuses to lock while this directory holds no
diagram: gate status is `open|locked` with nothing between, so a check that fires on
`locked` would report the gap only after the tag is cut. Neither is a Mermaid validator and
neither can tell you the model is *right* — that is the coherence review below.

## Contract layers → `contracts/`
1. `openapi/` — public API surface; single source of truth for generated types.
2. `internal/` — between contexts: in-process interfaces if co-located, per-service
   specs if separated (per Gate 3).
3. `asyncapi/` — every event/queue message schema, versioned.

All three CI-validated. Everything in G5 must trace to contract elements; anything not
in a contract does not exist.

**What `npm run validate` does and does not cover** (from 0.6.5; data model from 0.7.0): it
parses every `contracts/**.yaml`, rejects duplicate keys, and resolves **every `$ref`** — including
cross-file ones — so a pointer at nothing fails here rather than as a codegen error in a
code repo after the gate is locked and the tag is pinned. For OpenAPI documents it also
checks `operationId` presence and uniqueness, that every operation declares responses, and
that every referenced security scheme is declared. It is **not** a full OpenAPI/AsyncAPI
validator (that needs a dependency the plugin does not ship): passing it means the contract
is not broken in the ways that travel silently downstream, **not** that it is semantically
right. Nothing here substitutes for the callee check below, which no script can do.

## The coherence check — run before every Gate 4 lock, including reopens

The data model and the public API are locked by the same gate and drift from each other
between drafts, because they are written by different agents from the same ADRs. Walk it in
**both** directions — one direction alone passes on a contract that is half-built:

- **API → ERD.** Every resource the OpenAPI surface exposes maps to an entity, or to an
  explicitly named *projection* of entities (a read model joining two tables is fine; say so
  in a `%%` note on the diagram). A resource that maps to nothing is either a table nobody
  drafted or an endpoint nobody needs — both are cheaper to settle now than in a slice.
- **ERD → API-or-internal.** Every entity is either reachable from the public API or
  annotated `%% internal` with the reason (outbox rows, audit trails, join tables). An
  unreachable entity that nobody marked internal is the shape of a feature that was designed
  and then forgotten — it will be built, migrated, and never read.

Neither direction is scriptable: "maps to" is a judgment about naming and intent, which is
why this is a review step and not a check in `validate.mjs`. Same reasoning as the callee
check below — and like it, run it as a step, not as a habit you intend to have.

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
- **A read with no writer ANYWHERE — not only for fields added this phase.** The dangerous
  version is a field an *existing* module already reads that no phase ever gave a writer:
  every artifact validates, every test passes, and the feature is absent while looking
  present in every code review.

  **The detector is one grep and it works: a field only a test writes is a field nothing
  writes.** Grep each field the phase depends on across the whole tree and look at what the
  write sites actually are. Raw SQL in a fixture reads as reasonable test setup, which is
  precisely why it survives review — the fixture supplies by hand what production never
  supplies at all.

  One project hit this four times in nine slices: two provenance columns, a connection's
  repository selection, then the two values its inbound webhook receiver reads to
  authenticate a delivery. That fourth one cost a Gate 4 reopen mid-slice, and it was found
  by someone asking what a deploy criterion needed — not by a test. The first three were
  already written down, and so was the detector. **Run it as a step, not as a habit you
  intend to have.**
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
Data model with deviations-from-reference and the coherence check's outcome in both
directions (name any projection or `%% internal` entity by hand — a clean pass with
unstated exceptions is the failure mode); the three layers and their codegen status;
the change policy after lock: additive changes allowed within the tag series, breaking
changes reopen Gate 4 for the affected contract only and cut a new major gate tag.

Lock only on explicit approval: `gate.mjs lock gate-4`. Locking cuts the tag code repos
pin to (e.g. `gate-4/contracts-v1`).
