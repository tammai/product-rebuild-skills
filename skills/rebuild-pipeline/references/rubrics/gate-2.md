# Gate 2 rubric — slice-plan lock (`plan/slices.yaml`)

What locks: the slice boundaries and their order. Everything after this builds one slice at a
time in this sequence, so the score is about whether the *order is buildable* and whether each
slice's finish line is a test result rather than an opinion.

Read: `plan/slices.yaml`, `matrix/features.yaml`, and `findings/nfr/nfr-profile.yaml`.

## D1. Dependency soundness

**Asks:** can each slice actually be built when its turn comes?

`validate.mjs` already rejects cycles and unknown ids. This dimension is about the
dependencies that are *real but undeclared*: a slice whose features need an entity, an auth
mechanism or a background worker that a later slice introduces.

- **5** — every slice's features are satisfiable from its own scope plus its declared
  `depends_on`, and the walk was done feature by feature rather than by slice title.
- **3** — one or two slices depend on something later that nobody declared, but the fix is a
  reorder rather than a re-cut.
- **1** — the order cannot be built as written; a slice needs something from two slices ahead.

**Cite below 4:** the slice id, the feature inside it, and the thing it needs that arrives
later.

## D2. Slice size balance

**Asks:** are the slices comparable enough that "we finished a slice" means something?

- **5** — feature counts and rough scope are within a small factor of each other, and any
  deliberate outlier (a spike, a migration) is labelled as one.
- **3** — one slice is two or three times any other, with no reason given.
- **1** — a single slice holds most of the matrix, so the plan is really one milestone wearing
  a plan's clothes.

**Cite below 4:** the slice ids and their feature counts.

## D3. `done_means` testability

**Asks:** could a person who was not in the room verify each clause, and would two of them
agree on the answer?

- **5** — every clause names an observable: a test that runs, a deploy that a real person can
  install, a number with a threshold. No clause contains "works", "properly", "as expected".
- **3** — most clauses are checkable, one or two are judgment calls dressed as criteria.
- **1** — `done_means` restates the slice title.

**Cite below 4:** the exact clause text and its slice id.

## D4. First-slice risk placement

**Asks:** does the plan learn the expensive things early?

The pipeline's whole argument is that deployment is half the curriculum. A plan that defers
every hard thing — the first deploy, the first inbound webhook, the on-device migration, the
first store submission — to the last slice has front-loaded the comfortable work.

- **5** — at least one genuinely risky element (deploy path, migration, external integration,
  platform floor) lands in slice 1 or 2, and the plan says why that one.
- **3** — the first slice is real but entirely inbound-safe; the first hard thing is slice 4+.
- **1** — every risk is in the final slice, where discovering it costs the whole plan.

**Cite below 4:** which risks land where, by slice id.
