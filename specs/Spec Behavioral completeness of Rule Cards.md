# Spec: Behavioral completeness of Rule Cards

2026-10-06 · @Tam Mai

## Problem

Rule Cards (E5, lane R) make the reference's business rules explicit, cited and judged before G5. They check **precision** well: `rubric-judge` opens every transcribed citation and sets `verification: re-derived`. They do not check **completeness**. Three kinds of rule can go missing without any check failing, and a fourth problem is that we have no measure of how many rules lane R misses.

AgentModernize ([arXiv 2605.17535](https://arxiv.org/abs/2605.17535)) solves the same problem with a Behavioral Specification Graph (BSG): operation nodes with pre- and postconditions, typed inputs and outputs, an `error_behavior` on each node, edges labelled `sequence`/`conditional`/`parallel`/`error`, and a separate set of global invariants. It reports 91.2% recall and 89.7% precision against a gold-standard rule set. It also reports only 9.4% end-to-end behavioral equivalence. Extraction was not the bottleneck; turning rules into working code was. We already have that downstream chain (`rule_id` on acceptance criteria → one test → per-rule parity), so this spec does **not** adopt the graph. It adopts the four parts of the BSG that would close gaps in our cards.

- **Invariants have no kind.** "An invoice's total equals the sum of its line items" holds after every operation, not on one trigger. The five kinds (`calculation`, `validation`, `eligibility`, `state-transition`, `derivation`) all assume a trigger, and the schema says "a rule that needs a sixth kind is usually two rules". So a miner splits the invariant into one card per operation that happens to preserve it. Each card passes, and the property they share is written down nowhere. A rebuild can then add a new operation that breaks it without any card noticing.
- **Error paths are not asked for.** The lane R brief in `agents/miner.md` asks for "the calculation, the validation, the eligibility check, the state machine". Nothing asks for what a rescue block, a fallback default, a retry or a compensating write does. The paper calls this the hardest class to extract ("implicit rules buried in defaults, error handlers, and cross-module dependencies"), and today it is also a class nobody aims at.
- **A state machine is N cards with no whole.** Each `state-transition` card is one edge, in prose. Nothing puts an entity's edges together, so a state no transition reaches, or a state with no card leaving it, is invisible. The Gate 1 rubric (D6, score 3) already names "no `state-transition` cards for an entity whose lane-D findings clearly describe a state machine" as a gap. The judge finds it by reading, if it finds it at all.
- **Recall is a proxy.** The lane R exit criterion (`g1-mining.md`) is "every `calculation` and `eligibility` route lane D found has at least one Rule Card". That counts routes with *a* card, not rules found. A route with five rules and one card passes. We have never measured lane R against a known answer, so we cannot tell whether a brief change helps.

## Goals and non-goals

**Goals**

- An invariant can be written as one card, and G5 is told to test it wherever its entities are written.
- The lane R brief names error paths and defaults as targets, and validation reports how many cards cover them.
- Every entity's state machine is assembled from its cards and checked for unreachable and dead-end states, before Gate 1.
- Lane R's recall and precision are measured numbers from a fixture with a known answer, so a brief or schema change can be judged by its effect.

**Non-goals**

- A graph format for rules. Flow order already lives in UX flows (lane C) and contracts (G4b). Edges on cards would be a third description of the same flow, and the three would drift.
- Typed inputs and outputs on cards. That is G4b's job. Gate 1 locks cards before contracts exist, so typing them there would freeze a shape before it is designed.
- Any new failure that could make an already-locked Gate 1 unreachable or invalid. Every new check here is advisory, or applies only to fields that are new and optional.
- Automating the miner run inside the eval. The scorer is deterministic; dispatching the miner stays a manual step.

**Success metrics**

| Metric | Today | Target |
|---|---|---|
| Invariants written as one card | not expressible | every application-enforced invariant the reference has |
| Error-path cards per rule-bearing domain | not counted | counted and reported; ≥ 1 wherever lane D found documented error responses |
| Entities whose state machine is checked as a whole | 0 | every entity with ≥ 2 `state-transition` cards that carry `transition` |
| Lane R recall on the fixture | unmeasured | measured each release that touches lane R; ≥ 0.9 overall |
| Lane R recall on the fixture's error-path and invariant rules | unmeasured | reported separately; ≥ 0.75 |

## E13 — `invariant`: a sixth kind

**Schema** (`schemas/rule.schema.json`):

- `kind` gains `invariant`. Its description: "holds after every operation that writes its entities, rather than on one trigger".
- For `kind: invariant`, `when` becomes optional (an `if`/`then` on `kind`), and `entities[]` becomes required with `minItems: 1`. An invariant with no entity has nothing it is a property *of*. `given` states the scope ("for every INVOICE in status `issued` or later"). `then` states the property with concrete values ("`total` equals the sum of its LINE_ITEM `amount`, to 2 decimal places").
- The "usually two rules" sentence in `kind`'s description is narrowed to the five trigger kinds, and points at `invariant` for properties that hold everywhere.

**Boundary with lane D.** An invariant the reference's database already enforces (a `CHECK`, a unique index, a foreign key, `NOT NULL`) is lane D's, transcribed into the schema findings and the ERD, and does **not** get a card. Without this line every column constraint becomes a card and the real application-level invariants get lost among them. The brief says so, and the judge flags cards that only restate a schema constraint.

**Downstream.**

- `g5-build.md`: a module spec that writes any entity named by an invariant card includes at least one acceptance criterion citing that card's `rule_id`. The test performs that module's write and then asserts the property. One invariant is therefore cited from several slices, and that is the point: each new writer is a new way to break it.
- `validate.mjs`, in the `rule_id` coverage block: list invariant cards that no acceptance criterion cites yet. This is advisory, like the rest of that block, because before the slice that first writes the entity it is expected.
- `acsuite.mjs` and `parity.mjs` already print `kind` in their per-rule groups and need no change.
- Gate 1 rubric, D6: a 3 now also covers "invariants the reference enforces in application code that appear only as per-operation cards", citing the cards that share the property.

**Changes**

- `schemas/rule.schema.json`: the enum value, the `if`/`then`, the narrowed description.
- `agents/miner.md`: one bullet under the rules lane, including the lane D boundary.
- `references/g1-mining.md`: lane R's kind list.
- `references/g5-build.md`: the invariant rule for module specs.
- `references/rubrics/gate-1.md`: the D6 wording.
- `scripts/validate.mjs`: the uncited-invariant list.

## E14 — Error paths and defaults as lane R targets

No new kind. An error path is still a `validation` (a rejection), a `state-transition` (to a failed or cancelled state), a `derivation` (a fallback default) or a `calculation` (a retry backoff). What changes is that the brief names these as targets and the card records which path it is on.

**Schema.** Add an optional `path_kind: { enum: [normal, error, default] }` that defaults to `normal`. It is named `path_kind` and not `path`, because an evidence entry's `path` already means a file, and a card carrying both would be read wrongly. `error` covers what happens when an operation fails: rescue, rollback, compensation, retry, the error response. `default` covers what happens when an input is missing: the fallback value, the implied setting. It is a field and not a kind because it describes a different axis. A state transition can be on the error path, and so can a validation.

**Brief** (`agents/miner.md`, rules lane): a new bullet, **"Read the failure side of every rule-bearing route."** For each route you carded, open its error handlers and the defaults it applies to missing input, and card what they do with concrete values. A `rescue` that swallows an exception and returns an empty list is a rule. So is a nil amount that becomes `0`. A rebuild drops both silently, because no test was ever written for them. Mark these cards `path_kind: error` or `path_kind: default`.

**Reporting.** `validate.mjs` prints the count per domain beside its card total: `billing: 14 cards (11 normal, 2 error, 1 default)`. This is advisory. A domain with zero error-path cards is not invalid, but a Gate 1 reviewer should see the zero.

**Rubric.** Gate 1 D6 gains a line: a domain whose lane D route findings document error responses (non-2xx statuses, error codes) but which has no `path_kind: error` cards scores at most 3. Cite the routes.

**Changes**

- `schemas/rule.schema.json`: the `path_kind` field.
- `agents/miner.md`: the bullet above.
- `references/g1-mining.md`: one sentence under lane R pointing at it.
- `scripts/validate.mjs`: the per-domain split in the `ok` line.
- `references/rubrics/gate-1.md`: the D6 line.

## E15 — State machines checked as a whole

A check needs structure, and `given`/`when`/`then` is prose. So `state-transition` cards gain an optional structured part, and `validate.mjs` assembles it.

**Schema.** An optional `transition` object on `kind: state-transition`:

```yaml
transition:
  entity: WORK_PACKAGE        # must also appear in entities[]
  field: status
  from: [new, in_progress]    # "(none)" for creation
  to: closed
```

It is **optional**, not required. Requiring it would fail every existing `state-transition` card the next time `validate.mjs` runs after `upgrade.mjs`, and on a workbench past Gate 1 those cards are under a locked path. The fix would then need a gate reopen to add a field nobody asked for at the time. New lane R runs are told to fill it in, and `validate.mjs` prints a hint for a `state-transition` card without one: "not part of the state-machine check".

**Check** (`validate.mjs`, after the entity pass). For each `(entity, field)`, collect the states named in `from` and `to` across all cards and build the graph. Report:

- **Unreachable states:** a state that appears in some `from` but in no `to`, other than through `(none)`. Either a creating transition is missing, or the state is legacy. Either way a human decides.
- **Dead ends:** a state that appears in some `to` and in no `from`. Often a terminal state that is correct (`closed`, `archived`), so this is a list for a reviewer to confirm, not a defect.
- **No creation:** no card has `from: [(none)]`, so nothing says which state a new entity starts in.
- **Entity mismatch:** `transition.entity` is not in the card's `entities[]`. This one is a **failure**, in the same register as the existing entity check, because it is two fields on one card disagreeing.

Everything except the mismatch is advisory. Validation runs before Gate 1 can lock, so the report reaches the judge and the human reviewer. Turning it into a failure would make a reference with a genuinely orphaned legacy state impossible to lock.

**Rubric.** D6 tells the judge to read the state-machine block. The existing score-3 wording ("no `state-transition` cards for an entity whose lane-D findings clearly describe a state machine") now has a mechanical partner: an unreachable state or a missing creation transition is cited by entity and state.

**Changes**

- `schemas/rule.schema.json`: the `transition` object, with `if kind = state-transition` allowing it and other kinds rejecting it.
- `scripts/validate.mjs`: the assembly, the four reports, the hint for cards without `transition`.
- `agents/miner.md`: fill `transition` on every state-transition card, with `(none)` for creation.
- `references/rubrics/gate-1.md`: the D6 pointer to the block.

## E16 — A recall fixture for lane R

**Fixture** (`eval/fixtures/rules-recall/`), following the layout of `eval/fixtures/instruction-shaped/`:

```
reference-src/          ~250 lines in one domain (billing), written for this fixture
inputs/features.yaml    the matrix lane R resolves features[] against
inputs/reference-erd.mermaid
gold.yaml               the known answer
README.md               how to run it, and how to read the result
```

`gold.yaml` lists 31 rules. (It was written with 22; the first recorded run carded 9 genuine rules the set lacked, and the gold was completed before the baseline was recorded.) Each has an `id`, the acceptable `kinds` (more than one only where the schema's own definitions overlap for that rule), a `path_kind` (normal/error/default), one or more `locations` (path plus line range), and the `values` a correct card must name. The set covers every kind, including 2 invariants, 4 error-path rules and 3 defaults. Several rules are split across two files (the paper's cross-module case), and one lives only in a default argument (its hardest case). `hard:` on a rule names which hard class it belongs to. The source is written fresh for the fixture, not copied from a real product, so the fixture has no license question.

**Scorer** (`eval/rules-recall.mjs`, deterministic, no model calls). Input: a lane R output file. A card is **located** on a gold rule when one of its evidence entries has a `line` inside one of the rule's locations. Evidence without a `line` is never credited. A located card **matches** when its `kind` is one of the rule's `kinds`; otherwise it is a **near miss** (right code, filed under a different meaning). When a card matches more than one gold rule, it counts for the first and the rest are reported. The scorer prints:

- recall (gold rules matched), strict recall (the matching card also names every `values` group in its given/when/then), and precision (cards that matched a gold rule), overall and per kind and per `path_kind`;
- each missed gold rule, with its id and the reason it is hard;
- the matched rules whose card names no testable values, the near misses, and each card that matched nothing, with its `then`.

`--record` appends the numbers to `eval/runs/<local-date>/rules-recall.json`, under the same local-calendar naming E11 fixed.

**The scorer tests itself** (`--self-test`). Perfect cards built in memory from `gold.yaml` must score 1.0 on recall, strict recall and precision. An empty input must score 0 recall without crashing. A wrong-kind card, an off-line citation and a line-less citation must each score as the known answer. The perfect cards are generated rather than shipped as `gold-as-cards.yaml`, because a second copy of the answer is a second thing to keep in step with the source. Without the self-test, a scorer bug would read as a miner regression.

**Running it.** Dispatch the `miner` agent with a lane R brief in the `subagent-briefs.md` format (the lane's rules live in `agents/miner.md`) against `reference-src/`, with the two `inputs/` files as its fixed inputs, then run the scorer on what it wrote. Record the plugin version and the miner's model tier with the result. The fixture does not decide pass or fail. It turns "did the brief change help" into two numbers you can compare across releases.

**Changes**

- `eval/fixtures/rules-recall/`: the files above.
- `eval/rules-recall.mjs`: the scorer, with a header comment per the repo's script convention.
- `CLAUDE.md` and the fixture README: a change to the lane R brief or the rule schema is measured on this fixture before and after. It goes in `CLAUDE.md` because the person editing `agents/miner.md` will not be reading an eval README.

## Phasing

The order matters, because E16 is what proves the other three help.

1. **E16 first (0.28.0).** Ship the fixture and the scorer, run the **current** brief through it, and record the baseline. Without a "before", the next three changes cannot be measured.
2. **E14 and E13 (0.29.0).** These are brief and schema changes. Re-run the fixture: the error-path and invariant recall lines should move, and overall precision should not drop.
3. **E15 (0.29.0 or 0.30.0).** This is the only one with real validator logic. It can ship with E13 if the `if`/`then` blocks in the schema are written together. The fixture's two state-transition entities test it.

Each step is additive. Workbenches pick it up with `node scripts/upgrade.mjs`. Existing cards stay valid: `invariant` and `path_kind` are new and optional, and `transition` is optional.

## Open questions

- **Should `when` really be optional for invariants?** Alternative: keep it required and write "any write to INVOICE or LINE_ITEM". That is honest, and it tells G5 exactly which writers to test, which E13 otherwise derives from `entities[]`. Recommendation: optional, because `entities[]` already carries that information and a forced `when` will drift from it.
- **Where does the full set of states come from?** E15 only knows states some card mentions, so a state no card names is invisible to it as well. Lane D's schema findings often transcribe an enum or a `CHECK (status IN (...))`. If lane D recorded those in a structured way, E15 could compare the two and report "state `on_hold` exists in the schema and in no card". That needs a lane D field and is out of scope here, but it is the natural next step.
- **Should an unreachable state block the Gate 1 lock?** Recommendation: no. Leave it advisory and cited in the gate review. A reference can genuinely carry orphaned legacy states, and the decision about whether the rebuild keeps them belongs to the human at the gate, not to a validator.
