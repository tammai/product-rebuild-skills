# G1 — Parallel mining

Goal: exhaustive, evidence-backed inventory of what the reference IS. One miner
subagent per lane × source, all in parallel. Findings use `schemas/finding.schema.json`;
no evidence, no entry.

## Lanes
- **D Ground truth** (dominant when license posture allows source access): migrations/
  schema → entities; routes/OpenAPI → API surface; policies/guards → permission matrix
  (features × roles); job classes → background processing; webhooks/flags → events;
  config/env/seeds → operational surface. Evidence = path + commit hash.
  Pin the reference commit once in `sources.yaml` and use it for every lane-D run.
  Lane D additionally produces **`findings/ground-truth/reference-erd.mermaid`** — see below.
- **A Features**: changelog/release notes (the reference's build ORDER is a free
  curriculum — capture `first_shipped`), docs, pricing page if any.
- **B NFR**: deploy and run the reference locally (mandatory); observed limits, docs on
  scaling, status page. Aggregate into `findings/nfr/nfr-profile.yaml`: tenancy model,
  realtime, background processing, search, files, expected scale.
  For a `client-only` target shape those six fields describe a system this rebuild does not
  own, so mine them as *constraints* and add the ones that actually drive a client's
  architecture: **offline expectations** (what worked with no network, and where), **sync
  and conflict behavior**, **push and background execution**, **device and OS floor** (the
  oldest OS the install base still runs — it decides the framework floor), **cold-start
  time**, **app size**, **battery/data sensitivity**, and **accessibility settings the app
  respected** (text scale, reduce-motion). Every one of these is a G4a input under the
  Flutter playbook and none is derivable from the server.
- **C UX flows**: operate the running product; capture trigger → steps → outcome for top
  features. Agents draft from tours/docs; the USER verifies against the live instance —
  schedule that verification explicitly with them.

## Mining a client, not a server (`target_shape: client-only`)

When the rebuild replaces one client of an API that stays put, lane D's targets move. The
API is no longer something to design — it is ground truth to transcribe, and G4b will freeze
the transcription. Mine, from the OLD CLIENT's source:

- **Every call site**: method, path, query and body shape, headers, auth scheme, and which
  screen triggers it. This becomes `contracts/openapi/` at G4b (see `g4b-contracts.md`'s
  external-contract mode). A server-side OpenAPI document, if one exists, is better evidence
  — but the client's call sites are what the client actually depends on, which is a smaller
  and more honest set, and the gap between the two is worth recording.
- **Response handling**: every field the client reads, and every field it *writes to local
  state*. This is the input to the property-level coherence check at Gate 4, and it is where
  a rebuild finds the fields nothing consumes.
- **The on-device stores**, itemized, because they are migration surface and the highest-risk
  ADR at G4a depends on this list being complete: secure-storage keys (service/account names
  as the old stack wrote them), key-value keys, local database schema and its file location,
  files written to disk, push registration. **Verify against a device restored from a real
  backup, not a fresh install** — a fresh install has none of the state a two-year-old
  install has, which is exactly the state that will break.
- **Client-side behavior with no server counterpart**: local validation rules, caching and
  staleness, retry policy, offline queues, deep-link and URL-scheme routing, notification
  payload handling, biometric gates, analytics events. All of it is parity surface and all of
  it is invisible in the API. This is the category a client rebuild loses features to.
- **The selector inventory**: every `testID` (React Native) or accessibility identifier the
  old client sets, with the screen and the element it names — plus the elements that have
  none. These are call-site-adjacent surface, and they are mined here for one specific
  reason: under `playbooks/mobile-flutter.md` §15 the acceptance-criteria flow suite is
  **recorded against the old app and replayed against the rebuild**, which works only if both
  apps expose the same selector strings. The rebuild assigns the identical string to its own
  accessibility identifier; the inventory is the contract between the two.
  Mine it in this pass. Flows are recorded per slice from G5 onward, and an inventory that
  arrives then leaves two bad options — edit already-recorded flows (the one edit the
  assertion rule forbids) or match on visible text (which breaks on any copy change, for
  reasons that have nothing to do with parity). Record the gaps as findings too: an element
  with no `testID` is a flow that needs another way in, and that is cheap to know now and
  expensive to discover while a flow is red.
- **Platform integration**: permissions requested, background modes, share/intent handlers,
  widgets/extensions, deep-link domains, app-store metadata that encodes behavior (minimum
  OS, supported devices).

Lane B/C still run against the old app on a device. Lane A's changelog is usually the app's
own release notes plus its git history; for `reference.upstream: frozen` there is nothing to
re-mine later (see `g6-parity.md`), which makes THIS pass the only one — mine it as though
nobody will come back to it, because nobody will.

## Reference ERD (lane D) → `findings/ground-truth/reference-erd.mermaid`

The per-feature `entities:` lists in the feature matrix are names; what G4b needs from the
reference is **shape** — which entity owns which, what is optional, where the hierarchy is.
Transcribe it as one Mermaid `erDiagram`.

- **Descriptive, not a design artifact.** It records what the reference *is*, so it lives in
  `findings/` with the rest of lane D and is deliberately **not** gate-locked: G6 upstream
  re-mining updates it as the reference moves, and a locked copy would make every upstream
  schema change a Gate 1 reopen. The rebuild's own model is `contracts/data-model/`, locked
  at Gate 4 — keep the two apart.
- **Partial by design.** Only entities relevant to the feature matrix. A reference mined for
  one subsystem gets that subsystem's tables, not its full schema; note the boundary in a
  `%%` comment so a later reader does not mistake absence for evidence of absence.
- **Where to find it:** a migrations directory (Rails `db/schema.rb`, Django
  `*/migrations/`, `migrations/*.sql`), ORM model classes, or a published schema/ER page in
  the docs — in that order of trust. Cite path + pinned commit in the `%%` header, same
  evidence rule as every other lane-D finding.
- **For a `client-only` rebuild there are two ERDs and they are not interchangeable.** The
  server's shape, inferred from API responses (mark it `%% inferred` — the client cannot see
  nullability or ownership), and the OLD CLIENT's local store, transcribed from its schema
  files, which is the one the rebuild's own `contracts/data-model/` actually descends from.
  Write both: `reference-erd.<name>-api.mermaid` and `reference-erd.<name>-local.mermaid`.
  Conflating them produces a local store shaped like a server schema, which is how a mobile
  app ends up doing joins on a phone.
- Under **clean-room posture** there is no source to transcribe: build it from the API and
  docs, mark it `%% inferred`, and expect lower fidelity on ownership and nullability.

Where a rebuild mines more than one reference, one file per reference:
`reference-erd.<name>.mermaid`, using the name from `sources.yaml`.

## Ground-truth graph (lane D, source-access postures only)

Before dispatching lane-D miners, build a knowledge graph of the reference source so they
navigate it instead of grepping cold. Skip this whole section under clean-room posture
(`license-posture.md` restricts lane D to no-code sources) — the repo is on the deny list,
there is nothing to graph.

1. Clone the pinned reference: `graphify clone <sources.yaml reference.repo>`, then
   `git -C <local-path> checkout <sources.yaml reference.pinned_commit>` so the tree on
   disk matches the commit every finding will cite.
2. Run `/graphify <local-path>` once on that checkout to produce
   `<local-path>/graphify-out/graph.json` (code-only corpus — AST extraction, no LLM cost).
3. Include the graph path in every lane-D miner brief (see `subagent-briefs.md`). Miners
   use `graphify query "<question>"` / `graphify path` / `graphify explain` against it as
   the primary way to locate entities, routes, permission checks, job classes, and their
   relationships — faster than raw grep and it surfaces connections (e.g. which guard
   gates which route) a linear read can miss.
4. The graph is a navigation aid, not the evidence — findings still cite path + the pinned
   commit hash directly, same as before. If `pinned_commit` changes later (re-pin), re-run
   `graphify update <local-path>` before re-mining rather than rebuilding from scratch.

## Orchestration
- Dispatch miners with the brief format in `subagent-briefs.md`; one output file per run
  under `findings/<lane>/`.
- After each batch: run `validate.mjs`; reject schema violations back to the lane, do not
  hand-fix silently.
- Findings are content-hashed by the validator; re-runs are idempotent.

## Exit criteria
Reference running locally (user-confirmed); lane D complete for schema/routes/permissions/
jobs, including `reference-erd.mermaid`; lanes A–C complete; all findings validate;
top-feature flows user-verified.

For `client-only`: add the API call-site inventory, the on-device store inventory verified
against a restored device, the client-side-behavior list (offline, deep links,
notifications, local validation), and the selector inventory — each as findings with
evidence, not as a summary. The architecture playbook's `on-device-migration` concern cannot
be decided at G4a without the second of those, G4b cannot freeze a contract without the
first, and under a mobile playbook G5 cannot record a slice's AC flows without the last.
