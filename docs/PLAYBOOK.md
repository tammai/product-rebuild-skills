# Product Rebuild Playbook

**Purpose:** a repeatable process for rebuilding an existing product end-to-end as a way to learn the full product development lifecycle. The input is a reference product (typically OSS — an OpenProject, a Twenty CRM, a Webstudio — or a well-understood category like CRM, project management, web builder). The output is a completed, full-featured, production-ready codebase.

**Scope:** reference selection through a running parity loop, including an explicit production-readiness gate. Out of scope: go-to-market, pricing, growth.

**Design goals:**

1. Every phase reads and writes machine-readable artifacts with fixed schemas, so agents can run every automatable step without human glue work.
2. Human judgment is concentrated into five explicit gates. Everything between gates is parallelizable.
3. Nothing downstream of a gate may contradict what the gate locked. Changing a locked decision means formally reopening the gate, not patching around it.
4. Divergence from the reference is welcome — that is where the learning is — but only *documented* divergence. Every architectural departure gets an ADR; undocumented drift is the failure mode. (Exception, scoped to G4a only: architecture/stack decisions default to the org playbook in `architecture-default.md` — see section 6. This goal governs everywhere else, and still governs the *reference*-divergence axis within G4a, plus the three G4a concerns the org playbook doesn't cover at all.)
5. "Full features" is the declared end state, so scoping decisions are about *sequence*, never about cutting the destination.

---

## 1. Operating model

### 1.1 Pipeline at a glance

```
G0 Reference selection + license posture
G1 Parallel mining          (lanes: ground truth / features / NFR / UX flows)
G2 Feature matrix           ── GATE 1: taxonomy lock
G3 Milestone slicing        ── GATE 2: slice-plan lock
G4a System design           ── GATE 3: architecture lock (mirror-or-diverge ADRs)
G4b Data model + contracts  ── GATE 4: contract lock
G5 Parallel spec & build    (lanes: specs+AC / services / frontend / infra), per slice
G6 Parity loop              ── feeds back into G1 on a schedule
GP Production-readiness     ── GATE 5: prod-ready lock (terminal)
```

### 1.2 Humans vs. agents

| Work type | Owner | Notes |
|---|---|---|
| Ground-truth extraction from reference source (G1) | Agents, mid tier | Deterministic targets: migrations, routes, jobs |
| Extraction from docs/tours/changelogs (G1) | Agents, low tier | Fixed output schema |
| Dedupe / merge (G2) | Agents | Minimal — source access makes presence deterministic |
| Dependency analysis & slice drafting (G3) | Agents | Human orders and locks the slices |
| Mirror-or-diverge ADR drafting (G4a) | Agents, high tier | Human decides every ADR |
| Contract drafting (G4b) | Agents | Human locks |
| Spec + AC drafting, code, tests (G5) | Agents | Gated by CI and verify hooks |
| Parity diff, upstream tracking (G6) | Fully automated | Test suite + matrix diff + changelog re-mine |
| Production-readiness verification (GP) | Mixed | Restore drills and incident dry-runs are human |
| All five gates | Human only | Non-delegable |

### 1.3 Artifact-first rule

Every phase boundary is a file (or set of files) with a schema, validated in CI. If a phase's output cannot be validated by a script, the phase is not done. Prose documents (ADRs, specs) carry structured frontmatter so tooling can index them.

---

## 2. Phase G0 — Reference selection + license posture

**Goal:** pick the reference and record the legal posture of the rebuild *before* any agent reads anything.

### 2.1 Select the reference

- **1 primary reference.** Prefer OSS with an active repo, real deployments, and a public changelog — you get ground truth (lane D) for free.
- **Optionally 1 secondary reference**, used only for UX-flow comparison where the primary's UX is weak or dated.
- Selection criteria: domain you want to learn, codebase you can actually read (size, language familiarity), active upstream (so the parity loop has something to track), and a deployment story you can study.

### 2.2 License posture — decide distribution intent now

The rebuild's relationship to the reference source depends on one decision that must be recorded at G0, not discovered at launch:

- **Internal / learning / private use:** reading any OSS source (including GPL/AGPL) as a reference is low-risk. Full lane-D mining allowed.
- **Intending to distribute closed-source later:** treat copyleft references clean-room — mine behavior via the running product, docs, and API surface only; do not read the code. Restrict lane D accordingly.
- **Permissive reference (MIT/Apache/BSD):** no restriction either way; you may even vendor code, with attribution.

Record the decision as `license-posture.md` with the chosen mode and its consequences for lane D. This playbook is process, not legal advice; if distribution plans are ambiguous, get a professional opinion before locking G0.

### 2.3 Enforcement

- `sources.yaml` lists exactly what agents may fetch/clone, derived from the posture above.
- If clean-room mode: the reference repo goes on the harness blocklist (pre-tool-use hook), same mechanism, inverted purpose.
- License scanning in CI on the rebuild's repos from day one.

**Exit criteria:** reference chosen with rationale; `license-posture.md` recorded; `sources.yaml` written; harness hooks configured to match.

---

## 3. Phase G1 — Parallel mining

**Goal:** an exhaustive, evidence-backed inventory of what the reference *is*. With source access, this phase trades inference for ground truth. Lanes run in parallel: one agent per lane × source.

### 3.1 Lane D — Ground truth (dominant lane when source is allowed)

Mine the reference codebase for deterministic facts:

- **Data model:** migrations / schema files → entities, relationships, constraints, tenancy columns
- **API surface:** route definitions, OpenAPI/GraphQL schemas, serializers
- **Permission matrix:** roles, policies, guards — extracted as a features × roles table
- **Background processing:** job classes, queues, schedules
- **Events & integrations:** webhooks emitted, inbound integrations, feature flags
- **Operational surface:** config options, env vars, seed data, upgrade scripts

Lane D output uses the same finding schema as other lanes but with `confidence: high` by default and `evidence` pointing to file paths + commit hash instead of URLs.

### 3.2 Supporting lanes

- **Lane A — Features:** changelog and release notes (feature *history* — what order the reference itself built things in is a free curriculum), docs, pricing page if one exists (which features the vendor considers premium).
- **Lane B — NFR profile:** observed behavior of a running instance (deploy the reference locally — this is mandatory, not optional), documented limits, status page if hosted, scaling docs. Output aggregates into `nfr-profile.yaml`: tenancy model, realtime needs, background processing, search, file handling, expected scale.
- **Lane C — UX flows:** operate the running reference; capture flows for top features (trigger → steps → outcome). Agents draft from tours/docs; a human verifies against the live instance. Secondary reference (if any) is mined here only.

### 3.3 Fixed output schema (raw finding)

```yaml
# findings/<lane>/<source-id>.yaml
- id: ref-schema-0042
  lane: ground-truth | feature | nfr | flow
  name: "Invite member"
  summary: "One-sentence description"
  evidence:
    - path: "db/migrate/2024_add_invites.rb"   # lane D
      commit: "abc1234"
    - url: "https://docs.../invites"            # other lanes
  flow:                                          # lane C only
    trigger: "..."
    steps: ["...", "..."]
    outcome: "..."
  confidence: high | medium | low
```

Rules: no evidence, no entry (dropped at ingest); findings are content-hashed so re-runs are idempotent; deploying and using the reference locally is an exit requirement, not a nice-to-have.

**Exit criteria:** reference running locally; lane D extraction complete (schema, routes, permissions, jobs); lanes A–C complete; all findings validate; top-feature flows human-verified against the live instance.

---

## 4. Phase G2 — Feature matrix → GATE 1: taxonomy lock

**Goal:** one canonical map of the reference: features grouped into a domain taxonomy, each with ground-truth links and flow descriptions. With a single reference and source access, presence is deterministic — the work here is *organization*, not inference.

### 4.1 Steps

1. **Merge lanes:** join lane D facts with lane A/C context per feature; dedupe is minimal.
2. **Canonical naming** (agent draft, human spot-check).
3. **Taxonomy** (human decision): group features into domains. This is the first draft of your bounded contexts — G4a inherits it. Important: cut domains the way *you* would design the system, not necessarily the way the reference's codebase is organized; if you keep the reference's module structure, that is itself a mirror decision to note.
4. **Attach flows and ground truth:** every feature links its flows, its schema entities, its routes, and its permission rows.

### 4.2 Feature matrix schema

```yaml
# matrix/features.yaml
- id: F-INV-001
  name: "Invite member"
  domain: "membership"
  ground_truth:
    entities: ["Invite", "Membership"]
    routes: ["POST /api/v3/invites"]
    permissions: ["admin", "project_admin"]
    jobs: ["InviteExpiryJob"]
  flows: [FL-INV-001]
  history: { first_shipped: "v9.2", evidence: [ref-changelog-0117] }
  confidence: high
```

### 4.3 GATE 1 — taxonomy lock

Human locks the domain list, boundaries, and canonical names. Agents may add findings into the taxonomy afterward but may not restructure it.

**Exit criteria:** matrix validates; every feature has ground-truth or documentary evidence; flows attached for top features; taxonomy signed off.
---

## 5. Phase G3 — Milestone slicing → GATE 2: slice-plan lock

**Goal:** since "full features" is the fixed destination, the decision here is *sequence*, not scope. Slice the matrix into vertical, independently shippable milestones ordered by dependency and learning value.

### 5.1 Slicing rules

- **Vertical slices:** each slice cuts through data model, API, and UI for a coherent set of features — never "all backend first."
- **Dependency-ordered:** agents compute a dependency graph from ground truth (entity references, permission prerequisites); typical spine: auth + tenancy → core domain loop (the one workflow the product exists for) → collaboration surface → reporting / integrations / admin.
- **Learning-weighted:** when dependencies allow multiple orders, prefer the slice that teaches the lifecycle stage you haven't done yet (first deploy, first migration on live data, first background job, first realtime feature).
- **Independently shippable:** every slice ends deployed and usable, even if the audience is one user. Shipping cadence is the point of the exercise.
- The reference's own changelog history (lane A) is a sanity check: the order the reference built things in is usually a viable order.

### 5.2 Slice plan schema

```yaml
# plan/slices.yaml
- id: S1
  name: "Auth + workspace tenancy"
  features: [F-AUTH-001, F-AUTH-002, F-WS-001]
  depends_on: []
  learning_goals: ["first deploy", "session model", "tenancy pattern"]
  done_means: "deployed; a user can sign up, create a workspace, log in"
- id: S2
  name: "Core project loop"
  features: [F-PRJ-001, F-TSK-001, F-TSK-002]
  depends_on: [S1]
  learning_goals: ["first live migration", "domain modeling"]
  done_means: "deployed; create project, add tasks, assign, complete"
```

### 5.3 GATE 2 — slice-plan lock

The slice sequence is locked. New ideas and upstream reference changes (from G6) enter the backlog for insertion at future slice boundaries — they never reorder slices mid-flight.

**Exit criteria:** every matrix feature appears in exactly one slice; dependency graph acyclic; each slice has `done_means` and learning goals; plan signed off.

---

## 6. Phase G4a — System design → GATE 3: architecture lock

**Goal:** decide the system's shape against the **org-default architecture**
(`skills/rebuild-pipeline/references/architecture-default.md` — default Go + Nuxt modular
monolith, API-first; Fastify + Next.js alternate) where a default exists, with the
reference product's own architecture (lane D) recorded as informational context rather
than the decision driver for those concerns. This is a deliberate, scoped exception to
design goal 4 above: for decomposition/stack and most cross-cutting concerns, there *is*
a default answer, and the ADR exists to justify departing from it — not to derive it from
scratch each time. The org default doesn't cover everything, though (see 6.1 step 4):
tenancy, search, and backend/cross-cutting caching have no org-default answer at all, and
stay fully blank-slate, mirror-or-diverge-against-the-reference decisions, exactly as
every G4a concern worked before this default existed. (Taxonomy, slicing, and contracts
stay per-product, blank-slate decisions too.) This phase is still the most expensive layer
to change later — hence its own gate, before any contract exists.

Inputs: locked taxonomy (Gate 1), locked slice plan (Gate 2), `nfr-profile.yaml`, the
reference's observed architecture from lane D, and `architecture-default.md`.

### 6.1 Decision sequence

0. **Applicability check (once, before any ADR is drafted):** confirm
   `architecture-default.md`'s own "when this does NOT apply" criteria (team under ~10
   engineers, no PMF, no concrete decoupled-API-first driver) don't describe this rebuild.
   If they do, skip the org-default mechanism entirely for this project — every ADR below
   reverts to the pipeline's original blank-slate model. Record the outcome as a one-line
   note carried into the Gate 3 review.
1. **Bounded contexts:** confirm/adjust taxonomy domains into contexts. Each context owns its data and vocabulary.
2. **Decomposition:** default is **modular monolith** per the org default. Before drafting this ADR, ask the human directly whether any team-composition fact (stack familiarity, existing React/Node investment) favors the Fastify + Next.js alternate — this is the one fact the pipeline never persists elsewhere, so it's asked here every time, and recorded inline in this ADR's rationale. Otherwise propose modular monolith / Go+Nuxt as the baseline; diverging requires a concrete reason from this product's NFR profile or shape — e.g. a hard scaling/isolation requirement, or an architectural-shape mismatch (e.g. the reference is fundamentally event-sourced with no queryable current-state table) — not just "the reference did it differently." Note the reference's own choice for the record; it's evidence about the *product domain*, not a vote on the rebuild's architecture.
3. **Mirror-or-diverge, two axes per concern with a default:** every such ADR states (a) mirror-or-diverge **the org default** — the actionable axis, gated — and (b) mirror-or-diverge **the reference's own approach** — informational, for the learning record and for tracking which lane-D ground-truth facts a *behavioral* reference-divergence invalidates (a pure tech-stack/language swap forced by the fixed org-default stack doesn't count). These are independent: an ADR can mirror the org default while diverging from the reference (the common case), or diverge from the org default for a documented reason. Undocumented divergence from the org default is the primary failure mode this gate enforces against, for the concerns that have a default.
4. **Cross-cutting concerns** — coverage is uneven, cite the exact section rather than assuming one section covers every concern:
   - authn/authz → §7; background workers → §7+§8+§10 (decide **before** events/queues); events/queues → §7+§8 (decide **after** background workers, citing it for the job-queue substrate the outbox relay runs on); storage → §8; files/media → §8; observability → §10.
   - **tenancy, search, backend/cross-cutting caching → no org default exists.** These three have no org-default axis (`org-default: N/A`) and are decided the original way: mirror-or-diverge against the reference only.
5. **Infra topology:** deployment units, environments, CI/CD shape — derived from the decomposition.

### 6.2 ADR format

```markdown
# ADR-007: <decision>
status: accepted | superseded-by-ADR-0XX
org-default: <cited section(s) of architecture-default.md, or N/A for tenancy/search/caching>
decision: mirror-default | diverge-from-default | silent-default   (or mirror | diverge, for N/A concerns)
reference-approach: <what the reference does, lane-D evidence — informational unless org-default is N/A>
rationale: <required in depth when diverging from the org default — name the NFR/shape fact, the rejected mirror-default alternative, and any prior ADR depended on; incl. learning goal if also diverging from the reference>
consequences: <trade-offs accepted; lane-D facts invalidated by any behavioral divergence from the reference>
reversal-condition: <observable fact that would reopen this>
```

`silent-default` is for a concern the org default addresses in general but not this
specific sub-question: propose a policy, flag it as newly introduced rather than sourced,
skip the depth requirement (nothing to diverge from), but still explain the choice.

Agents draft ADRs in parallel (except background workers before events/queues) — always with `architecture-default.md` as a fixed input, with the exact applicable section(s) or `N/A` named per concern so the drafter never has to infer it — the human decides sequentially (later ADRs depend on earlier ones). This gate is the bottleneck by design — budget real time for it, especially any divergence-from-default proposal.

### 6.3 GATE 3 — architecture lock

Locks the applicability-check outcome, context map, decomposition, all cross-cutting ADRs, and topology. No new service, datastore, or queue downstream without reopening.

**Exit criteria:** applicability check recorded; every context has a decomposition ADR; every cross-cutting concern decided (org-default-based or, for tenancy/search/caching, reference-based) or marked N/A within its own axis; every ADR with an org default states mirror/diverge/silent-default against it with evidence; the three N/A concerns state mirror/diverge against the reference; topology diagram exists.

---

## 7. Phase G4b — Data model + contracts → GATE 4: contract lock

**Goal:** the interfaces that make G5 fan-out safe. Order: **data model first** (Gate 3 decided where data lives; this decides what it is), then three contract layers.

### 7.1 Data model

Per context: entities, ownership, relationships, source-of-truth assignment. The reference's schema (lane D) is the starting draft; every deliberate deviation from it is annotated (it will matter when reading reference behavior later). Cross-context references via IDs, never shared tables.

### 7.2 Three contract layers

1. **Public contract** — API surface for frontend/external consumers (e.g. OpenAPI); single source of truth for generated types.
2. **Internal contracts** — interfaces between contexts (in-process if co-located, per-service specs if separated, per Gate 3).
3. **Async contracts** — schemas for every event/queue message (AsyncAPI or equivalent), versioned and CI-validated.

### 7.3 Rules

- Data model drafted sequentially; contracts then drafted per context in parallel.
- Everything in G5 traces to contract elements; anything not in a contract does not exist.
- After the gate: additive changes allowed; breaking changes reopen the gate for the affected contract only.

**Exit criteria:** data model reviewed with deviations-from-reference annotated; all three layers validate and codegen in CI; breaking-change policy documented.

---

## 8. Phase G5 — Parallel spec & build (per slice)

**Goal:** maximum safe fan-out, executed slice by slice. The four lane *types* expand into N actual lanes; the count is an output of Gates 1 and 3, not a playbook constant.

### 8.1 Lane types

1. **Specs + acceptance criteria** — one agent per module in the current slice. Each spec derives from the module's matrix features, their flows, their ground truth, and the relevant contracts. Every spec ends with **AC**: a testable behavior list (e.g. "inviting an already-registered email returns error E-409"). Each AC maps 1:1 to an E2E/integration test. Where behavior is ambiguous, the running reference instance is the arbiter — check it, don't guess. Specs pass propose-before-act review before code.
2. **Backend** — one lane per bounded context touched by the slice (whether contexts are modules or separate services per Gate 3), building against contracts. Scaffolding and codegen first.
3. **Frontend** — against the generated typed client; may split per feature area.
4. **Infra** — CI/CD, environments, deployment. Mostly one lane; schema migrations serialize through a single migration queue regardless of lane count.

### 8.2 Guardrails

- Contract-first: no code against an interface absent from a locked contract.
- CI on every lane: lint, tests, security scan, license scan, AC-coverage check (every AC has a test).
- Cross-lane shared changes go through one serialized review path.
- **Every slice ends deployed.** The deploy is part of the slice, not an afterthought — it's half the curriculum.

**Exit criteria (per slice):** all specs approved; all ACs green; contract conformance passes; slice deployed and its `done_means` demonstrably true.

---

## 9. Phase G6 — Parity loop

**Goal:** keep the rebuild converging on the reference automatically, and keep the matrix honest while the reference continues shipping.

1. **AC test suite:** "is the feature really done" is a test run, not a meeting.
2. **Parity diff:** rebuild coverage vs. the matrix — covered / partial / missing per feature, plus anything built that isn't in the matrix (scope-creep detector).
3. **Upstream tracking:** re-mine the reference's changelog and release notes on a schedule (e.g. monthly; content-hashed, so only real changes surface). New upstream features enter the matrix as backlog candidates for future slice boundaries — they never bypass the gates.

**Output:** a recurring parity report: AC pass rate, matrix coverage, upstream movements, scope-creep items.

---

## 10. Phase GP — Production readiness → GATE 5: prod-ready lock

**Goal:** close the gap that learning projects habitually skip. Feature-complete ≠ production-ready; this gate exists so the difference is verified, not assumed. Run it when the slice plan completes (and a lightweight version at each slice's deploy).

Checklist — each item verified by doing, not by asserting:

- **Security posture:** authn/authz reviewed against the permission matrix from lane D; secrets management; dependency and container scanning green; basic hardening (headers, rate limits, input validation) tested.
- **Data safety:** automated backups running; **restore actually performed** into a clean environment and verified; migration rollback procedure exercised once.
- **Observability:** structured logs, error tracking, basic metrics and alerts; you can answer "is it up, is it erroring, is it slow" without SSH.
- **Operations:** deployment is one command/pipeline; rollback documented and rehearsed; upgrade path for future versions written; runbook for the top 3 failure modes.
- **Docs:** install/deploy doc good enough that someone else could run it; architecture doc reflects final ADR state.
- **Incident dry-run:** one simulated failure (kill the DB, fill the disk) handled using only the runbook.

**Exit criteria:** every checklist item has evidence (a log, a recording, a doc link); gate signed off. This is the terminal gate — after it, the result matches the promise: completed, full-featured, production-ready.

---

## 11. Parallelization & automation map

| Phase | Parallel across | Automated | Human |
|---|---|---|---|
| G0 | — | license scan, source allowlist | reference choice, license posture |
| G1 | lanes × sources | extraction, hashing, validation | run the reference; verify flows |
| G2 | — | merge, naming draft | **GATE 1: taxonomy** |
| G3 | — | dependency graph, slice drafts | **GATE 2: slice order** |
| G4a | ADR drafting | drafts, consistency checks | **GATE 3: every ADR** |
| G4b | contracts per context | codegen, validation | data model review, **GATE 4** |
| G5 | modules × backend × FE × infra | code, tests, scans, AC checks | spec approvals, PR review |
| G6 | re-mining lanes | tests, parity diff, report | reading the report |
| GP | checklist items | scans, backup jobs | **GATE 5**; restore & incident drills |

Serialization points, by design: the five gates, the data model draft, the migration queue, cross-lane shared changes, and the human drills in GP. Everything else runs concurrently.

## 12. Failure modes to watch

- **Reading code instead of running the product** — lane D without lanes B/C produces a rebuild of the schema, not the product. Mitigation: running instance is a G1 exit requirement.
- **Undocumented divergence** — from the org-default architecture, for decomposition and the six cross-cutting concerns that have one (section 6, the gated axis there); from the reference, for tenancy/search/caching (no org default exists for these — they keep the original reference-mirror-or-diverge gate) and everywhere outside G4a. Mitigation: the applicable mirror-or-diverge field(s) are mandatory in every G4a ADR; review enforces it.
- **Horizontal slicing** — "all backend first" delays every lifecycle lesson to the end. Mitigation: slice schema requires `done_means` phrased as user-visible behavior on a deployment.
- **Taxonomy churn after Gate 1 / architecture by accident in G5** — same as ever: gate reopening is formal and logged; new infra requires an ADR.
- **AC theater** — vague criteria that always pass. Mitigation: each AC names one observable behavior and maps to exactly one test; when ambiguous, the reference instance arbitrates.
- **Skipping GP** — declaring victory at feature parity. Mitigation: the playbook's definition of done *is* Gate 5, and its items require evidence produced by doing.
- **Chasing upstream mid-slice** — the reference ships something shiny and the plan reorders itself. Mitigation: upstream changes only enter at slice boundaries.
