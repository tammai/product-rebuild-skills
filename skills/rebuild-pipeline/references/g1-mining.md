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

## Orchestration
- Dispatch miners with the brief format in `subagent-briefs.md`; one output file per run
  under `findings/<lane>/`.
- After each batch: run `validate.mjs`; reject schema violations back to the lane, do not
  hand-fix silently.
- Findings are content-hashed by the validator; re-runs are idempotent.

## Exit criteria
Reference running locally (user-confirmed); lane D complete for schema/routes/permissions/
jobs; lanes A–C complete; all findings validate; top-feature flows user-verified.
