# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The callee check at G4b** (`skills/rebuild-pipeline/references/g4b-contracts.md`) — an explicit pass before every Gate 4 lock, including reopens: for each module the slice touches, which modules does it *call*, and does each callee's `internal/` contract actually expose the method being called? Found the hard way on the Linear rebuild's S9, where seven gaps all had this shape and cost a second gate-4 reopen after the specs were already written. The mismatch is invisible from inside the phase — every artifact is internally consistent, and the gap exists only *between* a caller's assumption and a callee's surface. Names the two patterns that produce most of them (a field added this phase whose only writer is a `Params` struct that doesn't carry it; a cross-module write through a read-only `Service`) plus a duplicate-ownership grep, since two contract files claiming the same job ships as a runtime bug rather than a merge conflict.

### Fixed

- **`gate.mjs lock` no longer lets its tag point at content the lock never hashed** (found
  2026-07-25). It computes `artifact_hashes` from the **working tree**, then commits with
  `git add <lockfile> && git commit` — staging only the lock file. Any artifact edited but not
  yet committed was therefore hashed into the lock while the `gate-N/vN` commit still contained
  the *previous* text, and code repos pin that tag as a submodule. Hit twice in one session on
  the Linear rebuild (gate-3 and gate-4), both times caught only by hand-comparing `shasum`
  against the lock and re-pointing the tag with `git tag -f`. `lock` now runs `git status
  --porcelain` before hashing and refuses if anything outside the lock file itself is dirty,
  telling the caller to commit or stash first — rather than `git add -A`, which would sweep
  unrelated in-progress work into the "gate-N: locked" commit uninvited.

- **Gate tags are now immutable and versioned (`gate-N/v1`, `v2`, ...) instead of a force-moved
  `gate-N/v1`.** Code repos consume the workbench as a submodule pinned by commit, and resolve
  that pin's name with `git describe --exact-match`. A submodule clone that had already fetched
  `gate-4/v1` kept resolving it to the OLD commit after a reopen, so the consumer's contract-sync
  reported success while still pinning the previous contract — the exact drift the ceremony
  exists to make impossible. Found during S9 stage 4 (`plan/backlog.md`); nothing was mis-synced
  only because neither reopen that day touched `openapi.yaml`. A moving `latest` alias was
  rejected for the same reason: any mutable ref reintroduces "the name resolves differently
  depending on when you last fetched." `lock` now mints the next `vN` and never moves an existing
  one, printing a re-pin reminder (`git fetch --tags && git checkout --detach <tag>`) whenever a
  gate is locked again after a reopen.

### Changed

- **`adr-drafter` now emits a `contract changes this implies` section** (`agents/adr-drafter.md`) — previously not part of the agent's structure at all, so its coverage depended on whatever the orchestrator happened to put in the brief. Now a standard section, required to enumerate the modules the decision makes the ADR's module a *caller* of — naming methods that don't exist yet, as "adding it is a PR against Y's file by its owner" — plus what is deliberately unchanged, and which existing file's wording a moved responsibility makes wrong.

## [0.3.4] - 2026-07-23

### Added

- **Ground-truth graph step for G1 lane D** (`skills/rebuild-pipeline/references/g1-mining.md`) — before dispatching lane-D miners, clone the pinned reference commit and run `/graphify` on it once (code-only corpus, AST extraction, no LLM cost) to produce a navigable knowledge graph of entities, routes, permission checks, and job classes. Miner briefs now carry the graph path (`subagent-briefs.md`) so miners query it with `graphify query`/`path`/`explain` instead of grepping raw source cold — findings still cite path + pinned commit as evidence, the graph is a navigation aid only. Skipped entirely under clean-room license posture, where the reference repo is already deny-listed.

## [0.3.3] - 2026-07-23

### Fixed

- **`gate.mjs`'s `yamlStr()` quoted values containing a newline without escaping it** —
  `needsQuoting()` flagged an embedded `\n` as needing quotes, but the escaper only handled
  `\` and `"`, so a multi-line title/reason/locked_by produced a quoted value spanning two
  physical lines. `get()`'s single-line regex then captured only the first line and
  `unquote()` found no closing quote, silently truncating the value and corrupting the line
  that followed. Added `\n` ↔ literal-`\n`-escape handling alongside the backslash/quote
  escaping so a quoted value always stays on one physical line.
- **`pause-check.mjs` read gate titles through its own un-synced copy of `parseLock`/`get`** —
  it never picked up `gate.mjs`'s `unquote()`, so once a title needed quoting its "reopened
  but not re-locked" message printed the raw quoted/escaped form (e.g.
  `gate-4 ("Contract lock: v2 revision")`) instead of the plain title. Added the matching
  `unquote()` to pause-check.mjs.

## [0.3.2] - 2026-07-23

### Fixed

- **`pause-check.mjs` missed host-native dev servers left running** — it only checked
  docker-compose stacks, so a `pnpm dev`/`go run`-style process (exactly the shape this
  same session's deployment-topology ADR made the frontend's normal deploy path) went
  undetected while still bound to its port. Added a per-repo check that looks for any
  running process whose command line references the repo's own absolute path — works
  for any dev command/port convention without needing to know either one. Caught live:
  a `pnpm dev` frontend server was still running on `localhost:3000` after the pipeline
  had already reported "safe to pause."

## [0.3.1] - 2026-07-23

### Fixed

- **`gate.mjs reopen` wrote invalid YAML whenever `--reason` contained a colon** (e.g.
  `"Add ADR-0011: deployment topology..."`) — a very likely shape for a real reason,
  since it broke on the very first real reopen this pipeline did. The hand-rolled writer
  interpolated the raw string as an unquoted YAML plain scalar; a colon-space inside it
  reads as a nested mapping, and `validate.mjs`'s real YAML parser then fails the file.
  `title` and `locked_by` had the same latent bug, just not yet triggered. Added a
  `yamlStr()` helper that conditionally double-quotes (only when a value actually needs
  it, so existing simple values keep round-tripping byte-for-byte) and a matching
  `unquote()` on the read side. Caught by, and fixed via, the linear rebuild project's own
  ADR-0011 gate-3 reopen.

## [0.3.0] - 2026-07-23

### Added

- **Pause-safety check** (`skills/rebuild-pipeline/scripts/pause-check.mjs`, orchestrator
  Step 6 in `SKILL.md`) — a repeatable, advisory readiness check for whether it's safe to
  pause the pipeline and resume in a new session. Reports git-dirty state across the
  workbench and every repo registered in `repos.yaml`, any gate left mid-decision
  (reopened but not re-locked), and docker-compose stacks left running, plus a reminder to
  confirm nothing non-trivial exists only in conversation. Deliberately NOT a sixth
  hash-pinned gate — it locks nothing and has no PreToolUse enforcement, since "is it safe
  to pause" is a live, repeatable question, not an artifact to protect. `repos.yaml`'s
  format is now documented (`name`/`path` entries) in both `rebuild-init.mjs`'s generated
  stub and `g5-build.md`, which now also instructs registering each code repo there as
  it's created — previously the file was generated but never referenced again, so real
  projects were leaving it as an empty stub indefinitely.

## [0.2.1] - 2026-07-19

### Added

- **Checkpoint discipline convention** (`skills/rebuild-pipeline/SKILL.md`) — the orchestrator now proactively writes in-progress, unlocked work (a partial ADR, a draft matrix, in-flight findings) to the workbench as soon as a chunk of non-trivial content only exists in conversation, rather than waiting to be asked. This closes a gap in the pipeline's designed resumability: state detection already trusts the filesystem over chat memory across sessions, but nothing previously obliged mid-phase drafts to actually reach disk before a session ended. Safe by construction — gates protect only *locked* artifacts, so draft files remain freely overwritable.

## [0.2.0] - 2026-07-19

### Added

- **Org-default architecture for G4a** (`skills/rebuild-pipeline/references/architecture-default.md`) — a modular-monolith, API-first playbook (default Go + Nuxt; alternate Fastify + Next.js) now seeds decomposition and most cross-cutting-concern ADRs. This is a scoped, deliberate exception to the pipeline's general "never inject a default" stance: `adr-drafter` and `references/g4a-architecture.md` treat the playbook's answer as the starting proposal, and an ADR is required to *diverge* from it rather than to adopt it (a third `silent-default` value covers concerns the default addresses in general but not a specific sub-question). Coverage is uneven by design, not by oversight: authn/authz, events/queues, storage, files/media, background workers, and observability each cite the exact playbook section that answers them; tenancy, search, and backend/cross-cutting caching have no org-default answer at all and stay fully open, mirror-or-diverge against the reference only, exactly as before this change. A one-time applicability check (the playbook's own "when this does NOT apply" clause) gates the whole mechanism per project. The reference product's own architecture (lane D) stays in the ADR as informational/learning context for concerns with a default, but no longer drives those decisions — a pure tech-stack/language swap forced by the fixed default stack doesn't count as reference-divergence, only an observable behavior/guarantee difference does. The decomposition/stack ADR also now asks the human directly about team-composition facts (stack familiarity) that might favor the Fastify + Next.js alternate, since no other artifact in the pipeline records that. Taxonomy (G2), slicing (G3), and contracts (G4b) are unaffected — still per-product, blank-slate decisions.

### Changed

- **`rebuild-pipeline`'s trigger description now covers license-posture and hook-blocked-edit queries.** Built a 20-query trigger eval set (`skills/rebuild-pipeline/eval/trigger-eval.json`) and ran it through skill-creator's eval loop. The original description already scored 100% recall on the training split, but held-out test queries caught two real gaps: "what's the license posture we recorded for this rebuild..." and "the hook just blocked me editing matrix/features.yaml..." both failed to trigger, since neither license posture (G0) nor the PreToolUse lock-guard hook was named in the description. Added both explicitly — verified 0/3→3/3 and 0/3→1/3 on the held-out queries, no new false triggers on the near-miss no-trigger set.

## [0.1.0] - 2026-07-18

### Added

- **`product-rebuild-skills` plugin** — a gated, agent-orchestrated pipeline for rebuilding an existing product end-to-end to learn the full product development lifecycle. Ships the `rebuild-pipeline` skill (the single interface: detects pipeline state, reports progress, dispatches subagents, stops at gates), the `/rebuild` command, `miner`/`adr-drafter`/`spec-writer` subagents, a PreToolUse hook guarding locked gate artifacts, and `docs/PLAYBOOK.md` covering the full methodology.
- **`.claude-plugin/marketplace.json`** — enables installing via `/plugin marketplace add tammai/product-rebuild-skills` + `/plugin install product-rebuild-skills@product-rebuild-skills`, matching the `tammai/bigin-skills` pattern. README's Install section updated to match.
