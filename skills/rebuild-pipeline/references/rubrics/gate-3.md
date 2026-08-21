# Gate 3 rubric — architecture lock (`adr/`, including the vendored `adr/playbook.md`)

What locks: the ADRs and the playbook copy they cite. After this, code repos exist and the
stack is a fact. `gate.mjs lock gate-3` already refuses while any concern in the playbook's
`concerns:` map has no ADR, and `validate.mjs` already rejects an ADR citing a section the map
does not point at. Both are presence checks. This rubric is about whether the *content* of
those ADRs would survive contact with the build.

Read: every file in `adr/`, `adr/playbook.md` (the vendored copy, never the plugin's registry
file), `findings/nfr/nfr-profile.yaml`, and `matrix/features.yaml`.

## D1. Concern coverage against the vendored playbook map

**Asks:** beyond "an ADR exists per concern" — does each ADR actually decide the concern the
playbook maps, at the depth the section asks for?

- **5** — every concern has an ADR that answers the question its playbook section poses,
  including the ones recorded `N/A`, where the reason for `N/A` is stated rather than assumed.
- **3** — one or two ADRs restate the playbook's default without engaging with anything
  project-specific, so the decision is unexamined rather than adopted.
- **1** — an ADR names a concern and decides something else, or `N/A` is used to skip a
  concern the project genuinely has.

**Cite below 4:** the ADR file, the concern key, and the playbook section it was supposed to
answer.

## D2. Divergence justification quality

**Asks:** an ADR is required to *diverge* from a playbook default, not to adopt one. Where the
project diverged, does the reasoning hold?

- **5** — each divergence names the project fact that forced it (an NFR number, a platform
  floor, a constraint in the frozen API), states what the default would have cost, and says
  what would make the team revisit it.
- **3** — divergences are justified by preference or familiarity, which is a legitimate reason
  but is not written as one.
- **1** — a divergence is asserted with no reasoning, or the ADR diverges without noticing it
  has: it decides against the default and never mentions the default.

**Cite below 4:** the ADR file and the playbook section it diverges from.

## D3. Decision–consequence completeness

**Asks:** does each ADR say what becomes *harder* as a result?

- **5** — every ADR carries consequences in both directions, and at least one is a real cost
  the team is accepting rather than a restatement of the benefit.
- **3** — consequences are present but all positive, which means the section was filled in
  rather than thought through.
- **1** — consequences are missing, or the ADR ends at the decision.

**Cite below 4:** the ADR files with one-sided or absent consequences.

## D4. Ordering against `decide-before`

**Asks:** the playbook's `decide-before:` map says which concerns constrain which. Were they
decided in that order, and does the later ADR reflect the earlier one?

- **5** — every dependent ADR cites the decision it depends on, and is consistent with it.
- **3** — the ordering was followed but the dependent ADRs do not reference their inputs, so a
  later reopen of the upstream one would not visibly invalidate them.
- **1** — a dependent ADR contradicts the one it was supposed to be decided after.

**Cite below 4:** the pair of ADR files and the `decide-before` entry that links them.

## D5. NFR grounding

**Asks:** does the architecture answer the profile that was mined, or a generic one?

- **5** — the ADRs that should be driven by `nfr-profile.yaml` (scale, offline, tenancy,
  platform floor) cite specific values from it.
- **3** — the profile is referenced generally but no ADR turns on a number in it.
- **1** — the architecture would be identical for any product in the category, which means G1
  lane B changed nothing.

**Cite below 4:** the NFR field and the ADR that should have consumed it.
