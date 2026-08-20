# Moved

The org-default architecture playbook now lives in the playbook registry, at
`references/playbooks/web-modular-monolith.md`. Its content is unchanged; it gained a
frontmatter block declaring its stack, its `concerns:` → section map, and the criteria
under which it does not apply.

This stub exists because ADRs written before 0.11.0 cite "architecture-default.md §7" by
name, and a reader following that citation should land somewhere that says where the file
went rather than nowhere. Nothing in the pipeline reads this file.

G4a resolves the playbook from `sources.yaml`'s `architecture.playbook` and vendors it into
the workbench at `adr/playbook.md` — read that copy, not this directory, when reviewing a
project whose Gate 3 is locked.
