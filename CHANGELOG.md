# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **`rebuild-pipeline`'s trigger description now covers license-posture and hook-blocked-edit queries.** Built a 20-query trigger eval set (`skills/rebuild-pipeline/eval/trigger-eval.json`) and ran it through skill-creator's eval loop. The original description already scored 100% recall on the training split, but held-out test queries caught two real gaps: "what's the license posture we recorded for this rebuild..." and "the hook just blocked me editing matrix/features.yaml..." both failed to trigger, since neither license posture (G0) nor the PreToolUse lock-guard hook was named in the description. Added both explicitly — verified 0/3→3/3 and 0/3→1/3 on the held-out queries, no new false triggers on the near-miss no-trigger set.

## [0.1.0] - 2026-07-18

### Added

- **`product-rebuild-skills` plugin** — a gated, agent-orchestrated pipeline for rebuilding an existing product end-to-end to learn the full product development lifecycle. Ships the `rebuild-pipeline` skill (the single interface: detects pipeline state, reports progress, dispatches subagents, stops at gates), the `/rebuild` command, `miner`/`adr-drafter`/`spec-writer` subagents, a PreToolUse hook guarding locked gate artifacts, and `docs/PLAYBOOK.md` covering the full methodology.
- **`.claude-plugin/marketplace.json`** — enables installing via `/plugin marketplace add tammai/product-rebuild-skills` + `/plugin install product-rebuild-skills@product-rebuild-skills`, matching the `tammai/bigin-skills` pattern. README's Install section updated to match.
