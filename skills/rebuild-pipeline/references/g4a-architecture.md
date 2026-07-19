# G4a — System design → GATE 3: architecture lock

## Step 0 — Applicability check (once, at G4a entry, before any ADR is drafted)
Confirm `architecture-default.md`'s own "when this does NOT apply" criteria (team under
~10 engineers, product-market fit not yet established, no concrete decoupled-API-first
driver) don't describe this rebuild. If they do, the org-default mechanism is skipped
entirely for this project: G4a reverts to the pipeline's original model — every ADR below
is a blank-slate decision against the reference's lane-D evidence only, with no org-default
axis at all. Record the outcome of this check as a one-line note carried into the Gate 3
review. Everything below assumes the org default applies.

Goal: decide the system's shape. Two evidence sources feed every ADR here, and they play
different roles — keep them separate:

- **Org default** (`references/architecture-default.md`): the org's standing answer for
  decomposition, stack, and *most* cross-cutting concerns (default Go + Nuxt modular
  monolith, API-first; Fastify + Next.js alternate). Where a default exists, it's the
  starting answer, not a candidate to re-derive — an ADR is required to **diverge** from
  it, not to adopt it. Not every concern has a default (see step 3) — where one doesn't
  exist, that concern's ADR has no org-default axis at all.
- **Reference product** (lane-D evidence): what the product being rebuilt actually does.
  For concerns *with* an org default, this stays purely informational/learning framing —
  it does NOT drive the decomposition/stack decision, but every ADR still records it,
  because it's what makes divergence from the *reference* legible later (ground-truth
  facts a divergence invalidates). For the concerns with no org default (step 3), this is
  the ONLY axis, exactly as before this change existed.

So for concerns with an org default, each ADR has two independent axes: mirror-or-diverge
**the org default** (actionable — budget real user time here) and mirror-or-diverge **the
reference** (informational — no gate consequence beyond noting invalidated lane-D facts,
and note: a pure tech-stack/language swap forced by the fixed org-default stack, e.g. the
reference used Ruby and the rebuild uses Go, is *not itself* a reference-divergence event
and needs no invalidation note — only an observable behavior/guarantee difference counts).

Inputs: locked taxonomy, locked slice plan, `nfr-profile.yaml`, lane-D architecture facts,
`references/architecture-default.md`.

## Decision sequence (draft in parallel except where noted, decide sequentially)
1. Bounded contexts from taxonomy domains.
2. Decomposition per context: default is **modular monolith** per the org default. Before
   drafting this ADR, ask the human directly whether any team-composition fact (stack
   familiarity, existing React/Node investment, etc.) favors the Fastify + Next.js
   alternate over Go + Nuxt — this pipeline has no other artifact that ever records team
   facts, so ask it here, every time, and record the answer inline in this ADR's
   rationale. Otherwise propose modular monolith / Go+Nuxt unless something about this
   product's NFR profile or reference architecture gives a concrete reason to diverge —
   e.g. a hard scaling/isolation requirement the reference itself hit and worked around,
   or an architectural-shape mismatch (e.g. the reference is fundamentally event-sourced
   with no queryable current-state table, and forcing a CRUD schema would mean
   re-deriving projections the reference already computes). Note the reference's own
   choice either way, for the record.
3. Cross-cutting concerns — org-default coverage is uneven; cite the exact section(s)
   below rather than assuming one section covers every concern:
   - **authn/authz** → §7 (Auth/Permission engine)
   - **background workers** → §7 (job queue) + §8 (the transactional-outbox relay runs on
     it) + §10 (queue depth/failure metrics). Decide this one **before** events/queues.
   - **events/queues** → §7 (event bus) + §8 (outbox, inbox/dedup, event schema
     versioning, dead-letter handling). Decide **after** background workers, and cite that
     ADR for the job-queue substrate the outbox relay runs on.
   - **storage** → §8 (ID strategy, audit columns, soft delete, migrations)
   - **files/media** → §8 (file/attachment storage)
   - **observability** → §10 (Observability & Health Checks)
   - **tenancy, search, caching (backend/cross-cutting)** → no org default exists for
     these in `architecture-default.md` (its only "caching" content is the frontend
     query-layer, not a backend strategy). These three ADRs have no org-default axis:
     org-default field is `N/A`, and the decision is made the original way — mirror-or-
     diverge against the reference's own architecture only.
4. Infra topology derived from decomposition.

## ADR fields
Every ADR states:
- `org-default:` the section(s) cited above for this concern, or `N/A` (tenancy, search,
  backend caching).
- `decision:` `mirror-default` | `diverge-from-default` | `silent-default` — the third
  value is for a concern that *has* an org default in general but is silent on this
  specific sub-question (e.g. the job queue is chosen, but cron-scheduling policy isn't
  addressed anywhere in the playbook): propose a policy, flag it as newly introduced
  rather than sourced from the playbook, explain the choice like any engineering
  decision, but skip the divergence-depth rationale below — there's nothing to diverge
  from. For `N/A` concerns, this field is the pipeline's original `mirror | diverge`
  against the reference instead.
- `reference-approach:` what the reference does (lane-D evidence) — informational for
  concerns with an org default; decision-driving for `N/A` concerns.
- `rationale:` grounded in the NFR profile and prior accepted ADRs (cite them by ID).
  Required *in depth* when diverging from the org default — "in depth" means naming: (a)
  the specific NFR-profile field or product-shape fact driving the divergence, (b) the
  mirror-default alternative, explicitly, and why it was rejected, and (c) any prior ADR
  this depends on, cited by ID. A rationale missing any of the three isn't in depth.
  Include the learning goal if also diverging from the reference.
- `consequences:` costs accepted, and — for any *behavioral* divergence from the
  reference — which lane-D ground-truth facts it invalidates.
- `reversal-condition:` an observable fact that would reopen this decision.

Undocumented divergence from the org default is the #1 failure mode to enforce against
for decomposition and the six concerns with a default. For tenancy, search, and caching —
the three `N/A` concerns — undocumented divergence from the *reference* is still the
thing that gates, exactly as before this change existed.

Dispatch drafts to the `adr-drafter` agent (one per ADR, parallel — except background
workers before events/queues) — pass the exact section(s) or `N/A` from the table above
alongside the per-ADR brief, so the drafter never has to infer which section applies.
Present each to the user for decision IN DEPENDENCY ORDER; later ADRs cite earlier ones.

## Gate 3 review (present to user)
Applicability-check outcome (step 0), context map, decomposition per context, every ADR's
default-mirror/diverge/silent-default one-liner (plus its reference-mirror/diverge note
for concerns where that's informational, or its full mirror/diverge status for the three
`N/A` concerns), topology diagram. What locks: no new service, datastore, or queue
downstream without reopening. After lock: NOW code repos may be created (count comes from
decomposition); wire each to consume the workbench as a read-only submodule pinned to gate
tags.

Lock only on explicit approval: `gate.mjs lock gate-3`.
