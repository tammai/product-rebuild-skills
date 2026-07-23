# Subagent briefing format

Every dispatch is self-contained — subagents share no conversational context. Include:

1. **Role file**: point at the agent definition (miner / adr-drafter / spec-writer).
2. **Inputs** (absolute paths): the exact workbench files to read. Never "the matrix" —
   always `workbench/matrix/features.yaml`. For miners: the `sources.yaml` entries in
   scope and the pinned reference commit. For lane-D miners specifically, also include the
   reference checkout's `graphify-out/graph.json` path when it exists (see
   `g1-mining.md`'s ground-truth graph step) so the miner queries it instead of grepping
   raw source cold. For adr-drafter (G4a): always include
   `references/architecture-default.md` as a fixed input alongside the per-ADR brief, and
   name the exact section(s) of it that apply to this concern (or `N/A` for tenancy,
   search, and backend caching, which have no org default — see
   `references/g4a-architecture.md` step 3). Never leave the drafter to infer the section
   itself. For the decomposition/stack ADR specifically, also pass along whatever the
   human said about team-composition facts bearing on Go+Nuxt vs. Fastify+Next.
3. **Output contract**: the exact output path and schema file. One output file per run.
4. **Boundaries**: what the agent must NOT do — no edits outside its output path, no
   fetching outside `sources.yaml`, no restructuring locked artifacts, no invented
   evidence. Ambiguity resolves by flagging `confidence: low`, never by guessing.
5. **Done means**: a checkable condition (validates against schema X; covers files Y).

Parallelism: dispatch independent lanes/modules in the same turn. Route model tiers if
the environment supports it: extraction → low tier; merge/spec → mid; ADR drafting →
high. On subagent output failing validation, send it back with the validator error —
do not hand-fix, the fix must come from a run that could have produced it.
