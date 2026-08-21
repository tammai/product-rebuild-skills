# Gate 1 rubric — taxonomy lock (`matrix/features.yaml`)

What locks: the domain structure and the canonical names. Agents may add findings into this
taxonomy afterwards; they may never restructure it. So the score is about whether the
*structure* will still be usable in six months, not whether every feature is present — G3
can add features, it cannot re-cut domains without a reopen.

Read: `matrix/features.yaml`, every file under `findings/`, and
`findings/ground-truth/reference-erd*.mermaid`.

## D1. Coverage against the findings

**Asks:** does every finding reach the matrix, and does every matrix entry descend from one?

- **5** — every lane-D finding maps to a feature or is explicitly out of scope with a reason;
  no feature cites evidence that is not in `findings/`.
- **3** — a handful of findings are unaccounted for, and the omissions look incidental rather
  than considered.
- **1** — whole finding files have no representation in the matrix, or features exist with no
  evidence at all.

**Cite below 4:** finding ids that reach no feature, and feature ids whose evidence resolves
to nothing.

## D2. Granularity consistency

**Asks:** are features cut at a comparable size, or does one domain hold "Authentication"
while another holds "Password field shows a strength meter"?

- **5** — a reader can predict, from any three features, roughly how big a fourth will be.
- **3** — one or two domains are visibly finer or coarser than the rest, without a stated
  reason.
- **1** — granularity varies by an order of magnitude within a single domain, which makes
  every downstream count (coverage %, slice size) meaningless.

**Cite below 4:** the specific feature ids at each end of the spread, in the same domain.

## D3. Orphan entities

**Asks:** does every entity in the reference ERD appear in some feature's `ground_truth`, and
does every entity a feature names exist in the ERD?

- **5** — both directions clean, or every exception is annotated (`%% internal`, out of scope).
- **3** — a few entities appear in the ERD and in no feature; nobody has said whether that is
  scope or an oversight.
- **1** — features name entities the reference does not have, which means the taxonomy is
  partly invented.

**Cite below 4:** entity names, and the ERD file or feature id each is missing from.

## D4. Naming collisions and drift

**Asks:** does one concept have one name?

- **5** — canonical names are consistent across features, flows and the ERD; near-synonyms
  have been collapsed deliberately, and the reference's own term is recorded where it
  differs.
- **3** — two or three concepts carry a second name somewhere.
- **1** — the same concept appears under different names in different domains, so contracts
  and specs will inherit both.

**Cite below 4:** each pair of names and where each appears.

## D5. Domain boundaries as a first draft of contexts

**Asks:** G4a inherits these domains as the starting point for bounded contexts. Would it?

- **5** — the cuts follow how the *rebuild* should be designed; where they mirror the
  reference's module structure, that mirroring is called out as a decision.
- **3** — the cuts are the reference's directory layout, unexamined.
- **1** — domains cross-cut each other, so no context map can descend from them without a
  re-cut.

**Cite below 4:** the domains involved and the features that sit awkwardly across them.
