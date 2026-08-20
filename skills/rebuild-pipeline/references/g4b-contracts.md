# G4b — Data model + contracts → GATE 4: contract lock

Order matters: data model FIRST (Gate 3 decided where data lives; this decides what it
is), then three contract layers. Data model drafts sequentially; contracts then draft
per context in parallel.

## Which mode this phase runs in — read `sources.yaml` before drafting anything

`architecture.target_shape` decides whether this phase *authors* a contract or *freezes* one:

- **`fullstack`** — the rebuild owns both sides. Everything below reads as written: three
  layers drafted from the ADRs, Gate 4 locks a design.
- **`client-only`** — the API exists, is not changing, and belongs to someone else. Then
  `contracts/openapi/` is a **transcription of observed reality**, mined at G1 from the old
  client's call sites (and the server's own spec, where one exists). Gate 4 locks
  ground truth, not a design. Four consequences, each of which someone gets wrong the first
  time:
  1. **Nothing here is negotiable by drafting.** A gap between what the rebuild needs and
     what the API gives is a *finding*, recorded in the gate review with the workaround it
     forces. Drafting the endpoint you wish existed produces a contract that generates a
     client that 404s.
  2. **Mark the file's provenance in it.** A `description:` stating "transcribed from
     <reference> at <commit>, not owned by this project; changes to this file describe the
     server, they do not request anything of it". Six months on, this is the difference
     between a reader treating it as a spec to satisfy and as an observation to trust.
  3. **The parts the rebuild genuinely needs added** — a minimum-supported-version endpoint
     for forced upgrade, a remote flag for a kill switch (the `release-rollout` ADR at G4a
     will have named these) — go in a **separate file**, `contracts/openapi/requested.yaml`,
     never merged into the transcription. It is a request to another team, and mixing it into
     observed reality is how a client gets built against an endpoint nobody agreed to.
  4. **`contracts/data-model/` describes the DEVICE**, not the server: the local store's
     shape — what is cached, what is user-authored-but-unsent, what is derived. Its
     starting draft is the old client's local schema
     (`findings/ground-truth/reference-erd.<name>-local.mermaid`), not the server ERD.
     The `internal/` layer is the interface between the app's feature modules; the
     `asyncapi/` layer covers push payloads, realtime channels and deep links — the messages
     the app receives without asking. If none exist, say so in the gate review; an empty
     directory and a decision recorded as empty are different states.

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
- **API → ERD, AT PROPERTY GRANULARITY.** Then walk it again, one *property* at a time: for
  every property of every schema the phase adds or changes, **which column holds it?** Each
  answer must be a column or an explicitly named derivation ("computed at read time from X",
  "resolved through the id", "an RFC constant"). *A property that is neither is a storage
  promise with no storage.*

  **This is not the same pass as the one above, and doing only the resource-level one is how a
  project shipped a filterable, "stored verbatim" field with no column.** The resource level
  asked "does `ScimUser` map to an entity?" — it did. Nobody asked which column held
  `externalId`. Every artifact validated: the OpenAPI schema was complete, the data model was
  complete, and the two never referenced each other on that field. It was found by *building*
  the handler, one gate too late.

  Write the derivations down by name. A clean pass with unstated exceptions is the failure mode
  — the exceptions are where the next gap will be.
- **In `client-only` mode this walk asks a different question, and it is the more useful
  one.** Not "does the API expose this entity" — the API is fixed and the answer changes
  nothing — but **"which API field, or which user action, populates this local column, and
  which screen reads it?"** A local column with no writer is a cache that stays empty; one
  with no reader is storage the app pays to migrate forever. Both are cheap now and neither
  is visible in a code review of one feature. Run it per column, and write the derivations
  down by name — the same discipline the property-level pass demands above, for the same
  reason.
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
- **THE TERMINAL STEP OF EACH OPERATION, not just the operation.** For every operation the
  phase adds, ask what its **last line** has to produce — the value the caller was actually
  promised — and whether something exists that produces it. Enumerating operations and
  enumerating their terminal steps are different questions, and the second is the one that gets
  skipped.

  The case that named this: a SAML ACS whose spec said it *"returns the identical
  `AuthTokenPair` that `/auth/login` returns"*. The callee check asked what the ACS needed,
  found that it had to create a user, and added `EnsureFederatedUser` to the callee's
  interface. **Nothing added a method that issues a session** — and sessions lived in the
  callee's schema, so the caller could not write one. `EnsureFederatedUser` makes the *person*;
  nothing made the *session*. The two obligations sat one sentence apart in the same spec
  paragraph and were treated as one. Found by building the handler, one gate too late.

  Tabulate it: operation | what the terminal step produces | producer | ✅/gap.
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
In `client-only` mode, open with the mode itself: what was transcribed vs. what is being
requested (`requested.yaml`), the gaps the frozen API forces the rebuild to work around, and
the fact that locking here locks an *observation* — if the server changes, this reopens as
ground truth moving, not as a design change. Then, in both modes:

Data model with deviations-from-reference and the coherence check's outcome in **all three**
passes — API → ERD at resource level, API → ERD at **property** level, and ERD → API-or-internal
(name any projection, derivation or `%% internal` entity by hand — a clean pass with
unstated exceptions is the failure mode); the callee check's outcome including its
**terminal-step** table; the three layers and their codegen status;
the change policy after lock: additive changes allowed within the tag series, breaking
changes reopen Gate 4 for the affected contract only and cut a new major gate tag.

Lock only on explicit approval: `gate.mjs lock gate-4`. Locking cuts the tag code repos
pin to (e.g. `gate-4/contracts-v1`).
