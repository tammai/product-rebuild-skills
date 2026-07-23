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
- **A Features**: changelog/release notes (the reference's build ORDER is a free
  curriculum — capture `first_shipped`), docs, pricing page if any.
- **B NFR**: deploy and run the reference locally (mandatory); observed limits, docs on
  scaling, status page. Aggregate into `findings/nfr/nfr-profile.yaml`: tenancy model,
  realtime, background processing, search, files, expected scale.
- **C UX flows**: operate the running product; capture trigger → steps → outcome for top
  features. Agents draft from tours/docs; the USER verifies against the live instance —
  schedule that verification explicitly with them.

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
jobs; lanes A–C complete; all findings validate; top-feature flows user-verified.
