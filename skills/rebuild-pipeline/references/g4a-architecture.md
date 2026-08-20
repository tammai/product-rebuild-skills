# G4a — System design → GATE 3: architecture lock

Goal: decide the system's shape. G4a is **playbook-driven**: a project selects one
architecture playbook, and that playbook — not this file — supplies the standing answers
and the list of concerns to decide. This file is the procedure; the playbook is the content.

## Step 0 — Resolve, check, and vendor the playbook (once, at G4a entry, before any ADR)

1. **Resolve.** Read `architecture.playbook` from `sources.yaml`. It names either an entry
   in the plugin's registry (`references/playbooks/<name>.md`) or a path inside the
   workbench for a playbook the user wrote themselves. Absent or empty → the org default,
   `playbooks/web-modular-monolith.md`. Explicit `none` → no playbook applies; skip to the
   blank-slate model in step 0b.
2. **Applicability check.** Read the playbook's own `not-applicable-when:` list from its
   frontmatter and confirm none of its criteria describe this rebuild. Record the outcome as
   a one-line note carried into the Gate 3 review. If a criterion *does* apply, say so and
   ask the user: either switch playbooks (some other registry entry may fit) or set
   `architecture.playbook: none` and take step 0b.
3. **Vendor it.** Copy the resolved playbook to `adr/playbook.md`. This is not
   housekeeping: `adr/` is inside gate-3's `protects:`, so the vendored copy is hashed into
   the lock. Every ADR cites section numbers, and a plugin upgrade can renumber sections
   under a locked gate — the vendored copy is what makes an accepted ADR's citation still
   mean in a year what it meant on the day it was accepted. `gate.mjs lock gate-3` refuses
   to lock while `sources.yaml` names a playbook and this file is missing.
4. **Read its frontmatter as the phase's own inputs**: `concerns:` is the list of ADRs this
   phase owes, `decide-before:` is the order constraints between them, `target-shape:` must
   match `sources.yaml`'s (`npm run validate` fails on a mismatch), and `scaffold-profile:`
   is what G5 will need at repo-creation time.

**0b — no playbook applies.** Every ADR below reverts to the pipeline's original model: a
blank-slate decision against the reference's lane-D evidence only, `org-default: N/A`
throughout, `decision: mirror | diverge` against the reference. The concern list then comes
from the canonical list for the project's target shape (below) rather than from a playbook.

## The two evidence sources, and why they stay separate

- **The playbook** (`adr/playbook.md`): the standing answer for the concerns its `concerns:`
  map points at sections of. Where an answer exists it is the *starting* answer, not a
  candidate to re-derive — an ADR is required to **diverge**, not to adopt. A concern mapped
  `N/A` has no answer at all; that concern's ADR has no playbook axis.
- **The reference product** (lane-D evidence): what the product being rebuilt actually does.
  For concerns *with* a playbook answer this is informational/learning framing — it does not
  drive the decision, but every ADR still records it, because that is what makes divergence
  from the *reference* legible later (which ground-truth facts a divergence invalidates).
  For `N/A` concerns it is the ONLY axis.

So a concern with a playbook answer has two independent axes: mirror-or-diverge **the
playbook** (actionable — budget real user time here) and mirror-or-diverge **the reference**
(informational — no gate consequence beyond noting invalidated lane-D facts). A pure
tech-stack/language swap forced by the playbook's fixed stack — the reference was React
Native and the rebuild is Flutter, the reference was Ruby and the rebuild is Go — is *not
itself* a reference-divergence event and needs no invalidation note. Only an observable
behavior or guarantee difference counts.

Inputs: locked taxonomy, locked slice plan, `nfr-profile.yaml`, lane-D architecture facts,
`adr/playbook.md`.

## Decision sequence (draft in parallel except where `decide-before:` says otherwise)

1. **Bounded contexts** from taxonomy domains. For a `client-only` target shape these are
   the app's feature modules; the *server's* contexts are not this project's to decide.
2. **Decomposition** per context, per the playbook's decomposition sections. Before drafting
   this ADR, ask the human directly whether any team-composition fact (stack familiarity,
   existing investment in a framework) favors the playbook's **alternate** column over its
   default — this pipeline has no other artifact that ever records team facts, so ask it
   here, every time, and record the answer inline in this ADR's rationale. Otherwise propose
   the playbook's default unless something about this product's NFR profile or the
   reference's own shape gives a concrete reason to diverge — e.g. a hard scaling/isolation
   requirement the reference itself hit and worked around, or an architectural-shape mismatch
   (the reference is fundamentally event-sourced with no queryable current-state table, and
   forcing a CRUD schema would mean re-deriving projections it already computes). Note the
   reference's own choice either way, for the record.
3. **One ADR per concern in the playbook's `concerns:` map.** The map is the authority on
   which section(s) apply — pass the exact value from it to the drafter so the drafter never
   has to infer a section. Honour `decide-before:`: a concern listed there is drafted only
   after the concerns it names, and its ADR cites them by ID. Concerns mapped `N/A` are
   decided the original way — mirror-or-diverge against the reference only.
4. **Infra topology** derived from the decomposition: deployment units, environments,
   CI/CD shape. For `client-only`, this is build flavors, signing identities, and release
   channels rather than services and datastores.

**Do not carry a concern list in your head between projects.** The org-default web playbook
maps eleven concerns (§7 auth, §8 storage, §10 observability, four `N/A`); the Flutter client
playbook maps twenty-one, and **only three keys appear in both** — `decomposition`,
`files-media`, `data-modeling`. The other eighteen, from `state-management` and `offline-sync`
to `platform-floor` and `on-device-migration`, have no counterpart at all. Citing "§7 for
auth" against a playbook whose §7 is the API client is the exact failure the vendored copy and
`npm run validate`'s citation check exist to catch — and the check can only catch a section a
playbook does not have, not a plausible-looking wrong one.

**When no playbook applies (step 0b), the canonical concern list by target shape:**

- `fullstack`: decomposition, authn-authz, background-workers, events-queues, storage,
  files-media, observability, data-modeling, tenancy, search, caching.
- `client-only`: decomposition, state-management, navigation, di-composition, api-client,
  authn-session, local-persistence, offline-sync, background-tasks-push, files-media,
  design-system, error-contract, observability-crash, localization, secrets-config,
  platform-integration, platform-floor, store-compliance, release-rollout, data-modeling,
  and — whenever the rebuild ships as an update over the existing install —
  on-device-migration.
  Three of those are easy to omit and expensive to omit: `platform-floor` (the framework's
  minimum OS versus the install base — a percentage of real users who cannot receive the
  rebuild at all, which bounds forced upgrade and the migration's whole population),
  `store-compliance` (privacy manifests and data-safety declarations, re-derived from the new
  dependency set, and a submission blocker upstream of any rollout plan), and `localization`
  (every user-visible string, plus plurals, formats and RTL — parity surface that no other
  concern covers).

**`data-modeling` is `N/A` in both shipped playbooks, and that is deliberate.** A playbook
governs how a row is *built* (IDs, audit columns, soft delete, migrations) and says nothing
about which entities exist or how they relate, so the storage/persistence ADR does not cover
it and citing that section here is a miscite. The reference's own schema is the only axis.
Raise an ADR for any **structural** divergence from
`findings/ground-truth/reference-erd.mermaid` — flattening a hierarchy, merging or splitting
entities, dropping a table a mined feature depends on. Renames, type/nullability changes, and
the ID/audit conventions the playbook already dictates are not structural and need no ADR;
they get a `%%` annotation at G4b. The ADR cites the reference ERD by path and names the
target `contracts/data-model/<context>.mermaid` it constrains — that file does not exist yet
(G4b draws it), so name it as the artifact this decision binds, not as evidence.

## ADR fields

Every ADR states:
- `concern:` the exact key from the playbook's `concerns:` map (or from the canonical list,
  under step 0b). One ADR per key; `npm run validate` fails on a missing or unknown key, and
  `gate.mjs lock gate-3` refuses to lock while a mapped concern has no ADR. This is what
  turns "every cross-cutting concern decided" from a prose exit criterion into a check.
- `org-default:` the section(s) the map names for this concern, or `N/A`. Validation
  rejects a `§` token the vendored playbook's map never points at.
- `decision:` `mirror-default` | `diverge-from-default` | `silent-default` — the third value
  is for a concern the playbook addresses in general but is silent on for this specific
  sub-question (the job queue is chosen, but cron-scheduling policy is not addressed
  anywhere; the local store is chosen, but its migration-test policy is not): propose a
  policy, flag it as newly introduced rather than sourced from the playbook, explain the
  choice like any engineering decision, but skip the divergence-depth rationale below —
  there is nothing to diverge from. For `N/A` concerns, this field is the pipeline's original
  `mirror | diverge` against the reference instead.
- `reference-approach:` what the reference does (lane-D evidence) — informational for
  concerns with a playbook answer; decision-driving for `N/A` concerns.
- `rationale:` grounded in the NFR profile and prior accepted ADRs (cite them by ID).
  Required *in depth* when diverging from the playbook — "in depth" means naming: (a) the
  specific NFR-profile field or product-shape fact driving the divergence, (b) the
  mirror-default alternative, explicitly, and why it was rejected, and (c) any prior ADR this
  depends on, cited by ID. A rationale missing any of the three is not in depth. Include the
  learning goal if also diverging from the reference.
- `consequences:` costs accepted, and — for any *behavioral* divergence from the reference —
  which lane-D ground-truth facts it invalidates.
- `reversal-condition:` an observable fact that would reopen this decision.

Undocumented divergence from the playbook is the #1 failure mode to enforce against for
decomposition and every concern with an answer. For the `N/A` concerns, undocumented
divergence from the *reference* is still the thing that gates.

## Two concerns that only exist for a client-only rebuild, and are easy to under-weight

- **`on-device-migration`.** If the rebuild ships under the same bundle ID as the app it
  replaces, first launch reads secrets, key-value state, a local database and files left by
  the *previous* app, once per user, on a device nobody can inspect, with no server-side
  undo. It is the only decision in this phase that cannot be rolled back per user, so it
  gets an ADR even when the answer is "we ship a new bundle ID and migrate nothing" —
  *especially* then, because that answer has an install-base consequence and belongs in
  `consequences:` rather than in a release note. Its spike belongs before the first slice
  that touches session or local data, not in G5.
- **`release-rollout`.** A kill switch and a forced-upgrade path both need a server-side
  signal, and for a client-only rebuild against a frozen API that signal usually does not
  exist yet. Deciding this at G4a is what gets it into G4b as a required contract addition,
  rather than discovering it during the first bad release when the only remaining lever is
  waiting for users to update voluntarily.

## Dispatch

Send drafts to the `adr-drafter` agent (one per ADR, parallel except where `decide-before:`
serializes them) — pass `adr/playbook.md`'s path, the exact `concerns:` value for that
concern (or `N/A`), and the concern key itself, alongside the per-ADR brief. Present each to
the user for decision IN DEPENDENCY ORDER; later ADRs cite earlier ones.

## Gate 3 review (present to user)

Which playbook was selected and the applicability-check outcome (step 0), the context map,
decomposition per context, every ADR's mirror/diverge/silent-default one-liner (plus its
reference-mirror/diverge note where that is informational, or its full mirror/diverge status
for `N/A` concerns), and the topology diagram. Say plainly that the playbook copy itself is
being locked alongside the ADRs, and what that means: after the lock, the file the ADRs cite
cannot move even if the plugin's registry copy does.

What locks: no new service, datastore, queue, deployment target or top-level module
downstream without reopening. Run `npm run validate`, then lock only on explicit approval:
`gate.mjs lock gate-3`, then `git push && git push --tags`.
