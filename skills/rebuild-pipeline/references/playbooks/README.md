# Architecture playbook registry

One file per playbook. A project picks one at G0 (`sources.yaml` → `architecture.playbook`),
G4a vendors it to the workbench at `adr/playbook.md`, and Gate 3 hashes that copy along with
the ADRs. The pipeline knows nothing about any playbook's content — it reads the frontmatter.

| Playbook | Target shape | Stack | Scaffold |
|---|---|---|---|
| `web-modular-monolith` (org default) | `fullstack` | Go + Nuxt modular monolith, API-first; Fastify + Next.js alternate | `bigin-skills` profiles `go`/`nodejs` + `nuxt`/`next` |
| `mobile-flutter` | `client-only` | Flutter client against an existing HTTP API; Riverpod + go_router + Drift + generated dio client | `flutter` (needs `bigin-skills` >= 1.66.0; `generic` fallback below that) |

`web-modular-monolith` is the default when `architecture.playbook` is empty. `none` disables
the mechanism: every G4a ADR becomes a blank-slate decision against the reference alone.

## Writing your own

A playbook is a normal Markdown document with one required frontmatter block. Put it either
here (to share across projects) or inside the workbench (to keep it project-local, in which
case `architecture.playbook` holds its path rather than its name).

```yaml
---
playbook: my-playbook          # must match architecture.playbook exactly
stack: "one line, for the Gate 3 review"
target-shape: fullstack        # fullstack | client-only
scaffold-profile: "go, via bigin-skills:bigin-harness-setup"   # or: none
not-applicable-when:
  - "the criteria under which this playbook is the wrong choice"
concerns:
  authn-authz: "§7"            # concern key -> the section(s) that answer it
  data-modeling: "N/A"         # or N/A, where this playbook has no answer
decide-before:
  offline-sync: "local-persistence, api-client"   # decide the values before the key
---
```

Four rules the tooling enforces, and one it cannot:

1. **`concerns:` is the ADR list.** Every key needs an ADR before Gate 3 can lock, and every
   ADR names its key in a `concern:` field. This is what makes "every concern decided" a
   check instead of a sentence. Choose keys deliberately: a concern you leave out is a
   decision nobody will be asked to make.
2. **Section tokens are the citation vocabulary.** An ADR may only cite a `§` that appears
   somewhere in your `concerns:` map. Keep the map and the section bodies in sync — renumbering
   one without the other silently re-points every ADR that cited it.
3. **`target-shape:` must match the project's.** Validation fails on a mismatch rather than
   letting a fullstack playbook govern a client-only rebuild.
4. **`N/A` is a real answer, not a gap.** It says "this playbook deliberately has no standing
   answer here, decide it against the reference" — which is different from forgetting the
   concern, and reads differently in a Gate 3 review.

What no check can do: tell you a section that *looks* right is the right one. §8 means storage
in one playbook and auth in another, and a plausible wrong citation passes every check there
is. That is why the chosen playbook is vendored into the workbench and locked, rather than
referenced from here.

**Keep the frontmatter simple.** It is parsed by a zero-dependency line reader (`gate.mjs`
runs without the workbench's `node_modules`), so scalars, one list, and two single-level maps
are all it supports — no anchors, no folded scalars, no flow mappings.
