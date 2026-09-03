# Subagent briefing format

Every dispatch is self-contained — subagents share no conversational context. Include:

1. **Role file**: point at the agent definition (miner / adr-drafter / spec-writer).
2. **Inputs** (absolute paths): the exact workbench files to read. Never "the matrix" —
   always `workbench/matrix/features.yaml`. For miners: the `sources.yaml` entries in
   scope and the pinned reference commit. For lane-D miners specifically, also include the
   reference checkout's `graphify-out/graph.json` path when it exists (see
   `g1-mining.md`'s ground-truth graph step) so the miner queries it instead of grepping
   raw source cold. For adr-drafter (G4a): always include
   the workbench's **`adr/playbook.md`** as a fixed input alongside the per-ADR brief — the
   vendored copy, never the plugin's registry file — plus the **concern key** and the exact
   **section(s)** the playbook's `concerns:` map gives for it (or `N/A` where it has no
   answer). Never leave the drafter to infer the section itself: numbering is per-playbook,
   so an inferred section is wrong in a way that reads as right. For the decomposition/stack
   ADR specifically, also pass along whatever the human said about team-composition facts
   bearing on the playbook's default versus its alternate. Pass `target_shape` too when it is
   `client-only` — it changes what the drafter may propose about the API (see the agent file).
3. **Output contract**: the exact output path and schema file. One output file per run.
4. **Boundaries**: what the agent must NOT do — no edits outside its output path, no
   fetching outside `sources.yaml`, no restructuring locked artifacts, no invented
   evidence. Ambiguity resolves by flagging `confidence: low`, never by guessing.
5. **Done means**: a checkable condition (validates against schema X; covers files Y).
6. **Model + tier**: the `model` and `tier` `scripts/routing.mjs` resolved for this role, stated
   in the brief as well as passed on the Agent call. On the record it is checkable after the
   fact; passed only as a parameter it is not, and a dispatch that silently ran on the wrong
   rung looks exactly like one that ran on the right one.

## The judge brief (`rubric-judge`, at every gate — Step 5.1b)

Same five parts, with these values. It runs once per gate attempt, after `validate.mjs`
passes and before the gate review is written.

1. **Role file**: `${CLAUDE_PLUGIN_ROOT}/agents/rubric-judge.md`.
2. **Inputs**: the **gate id**; the **rubric** `${CLAUDE_PLUGIN_ROOT}/skills/rebuild-pipeline/references/rubrics/gate-N.md`;
   the absolute paths of the artifacts under that gate's `protects:`; and the supporting
   paths the rubric's own header says to read (findings, the NFR profile, the vendored
   `adr/playbook.md`, the latest parity report — they differ per gate, so take them from the
   rubric rather than from this list). For gate 4, say which mode G4b ran in — a
   `client-only` transcription is scored on two dimensions a `fullstack` draft is not.
3. **Output contract**: `plan/gate-reviews/gate-N-rubric.md`, in the format the role file
   specifies. Not schema-validated — it is a report for a human, not a pipeline artifact.
4. **Boundaries**: read-only over every input; no edits to the artifacts being scored (they
   are about to be hashed); no file written other than the output path; no recommendation to
   lock or not to lock. Uncertainty goes in the report's "What I could not check" section
   rather than being resolved by guessing.
5. **Done means**: every dimension the rubric defines has an integer score, and every score
   below 4 carries a file-plus-line or file-plus-id citation. Send a report back with the
   uncited dimensions named if it does not — same rule as a schema violation, and for the
   same reason: the fix has to come from a run that could have produced it.

One thing to get right when you dispatch it: **do not paste the gate review into the brief**.
The judge scores the artifacts, and a judge that has read your summary of them will grade the
summary.

Its rung is no longer a judgement call in this file — `routing.mjs` maps it to the verifier tier
and the agent file pins `effort: high`, on the reasoning that scoring a whole artifact set is
omission-hunting and omissions are what effort buys. What used to be written here as "route it
to a high tier" is now the resolved value you pass.

Parallelism: dispatch independent lanes/modules in the same turn. On subagent output failing
validation, send it back with the validator error — do not hand-fix, the fix must come from a
run that could have produced it.

## Which model each role runs on

This used to read "route model tiers if the environment supports it: extraction → low tier;
merge/spec → mid; ADR drafting → high" — a rule with no mechanism behind it, describing a state
of affairs that was true of nothing: the four agent files carried no `model:`, so every dispatch
inherited the orchestrator's own model regardless of what this paragraph said.

`scripts/routing.mjs` is that mechanism. It maps each role to a tier once, resolves the tier
through the project's `.claude/model-routing.json` ladder, and prints the `model` to pass. Run it
once per session (SKILL.md step 4b has the command) and read the values off it — do not re-derive
a tier from the shape of the task, and do not infer a role's rung from the old sentence above.

The tiers it assigns, and the argument for each, are in the script's `ROLE_TIERS`. The shape of
the mapping is worth knowing before you read it: **extraction is not the cheap tier here.**
`validate.mjs` can tell that a finding is schema-valid but not that it is true, so a wrong
finding that parses ships — which puts the miner on the same footing as the judge, and both at
full effort on a cheaper model rather than the reverse.
