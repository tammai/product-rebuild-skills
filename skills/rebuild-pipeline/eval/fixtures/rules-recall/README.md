# Fixture — lane R recall against a known rule set

E16. Lane R's precision is checked in every project: `rubric-judge` re-derives every cited
line. Its recall is not. The G1 exit criterion counts routes that have *a* card, so nothing
notices when a brief change makes the miner find fewer rules. This fixture is a small billing
domain written together with the list of every rule in it, so a lane R run can be scored.

```
reference-src/               ~250 lines of Rails billing code, written for this fixture
inputs/features.yaml         the matrix lane R resolves features[] against
inputs/reference-erd.mermaid lane D's ERD, which lane R resolves entities[] against
gold.yaml                    the answer: 31 rules, their locations, kinds and test values
../../rules-recall.mjs       the scorer
```

The gold set covers all five current kinds, plus two `invariant` rules that the schema can't
express until E13. It has four error-path rules (a swallowed rescue, a decline handler, a
retry backoff, an abandon-after-three) and three defaults (a default argument, a `Hash#fetch` fallback, a `||`
fallback). Several rules are split across two files. Those are the classes the AgentModernize
paper reports as hardest to extract; `hard:` on a gold rule says which one it is.

**The miner must never see `gold.yaml`.** Copy `reference-src/` somewhere else before the run
and point the miner there. A miner that has read the answer is copying it, not mining.

## Running it

```sh
P=<plugin>/skills/rebuild-pipeline
F=$P/eval/fixtures/rules-recall

# a scratch workbench, for validate.mjs and the yaml dependency
node $P/scripts/rebuild-init.mjs rr --dir /tmp && cd /tmp/rr-workbench && npm install
cp $F/inputs/features.yaml matrix/features.yaml
mkdir -p findings/ground-truth findings/rules && cp $F/inputs/reference-erd.mermaid findings/ground-truth/

# the reference, outside the fixture and with a real commit to cite
cp -R $F/reference-src /tmp/billing-ref && (cd /tmp/billing-ref && git init -q && git add -A && git commit -qm fixture)
```

Then dispatch the `miner` agent with a lane R brief in the `subagent-briefs.md` format: the
reference checkout and its commit, the two inputs above as fixed inputs, default basis
`transcribed`, and `findings/rules/billing.yaml` as the output. The model is whatever
`scripts/routing.mjs --role miner` resolves. Once `npm run validate` passes:

```sh
node $P/eval/rules-recall.mjs findings/rules/billing.yaml --record --model <tier> --note "<what changed>"
```

`--record` appends the numbers to `eval/runs/<local-date>/rules-recall.json`. Check
`node $P/eval/rules-recall.mjs --self-test` passes before trusting a run. It scores perfect
cards built from `gold.yaml`, an empty file, a card with the wrong kind, a card cited off its
line, and a file-level citation, and asserts the known answer for each.

## Reading the result

- **Recall:** gold rules with at least one matching card. A card matches when an evidence
  `line` falls inside one of the rule's locations *and* its `kind` is one of the rule's `kinds`.
  Evidence without a `line` is never credited.
- **Strict recall:** the matching card also names every `values` group somewhere in its
  given/when/then. This is the gap between a rule a test can assert on and one that restates
  the route.
- **Precision:** cards that matched a gold rule. A card that matches nothing is either a rule
  the gold set is missing (add it, with its line range) or a citation that is off its line.
- **Near misses:** the right code, filed under a different kind. Until E13 lands, G-21 and G-22
  can only ever show up here.

The score decides nothing. Compare it with the previous entry in `eval/runs/`, which is local
and gitignored, so a release that changes lane R states its before-and-after numbers in
`CHANGELOG.md`. That is the record that survives (0.28.0 holds the first baseline). A change to
the lane R brief or `rule.schema.json` is measured here before and after it ships.

**The gold set is complete only as far as anyone has checked.** It was written with 22 rules.
The first recorded run carded 9 more that the source genuinely has, and they were added before the
baseline was recorded (they're marked in `gold.yaml`). When a run's "matching no gold rule" list
has a card whose `then` is true of the cited line, the gold set is short: add the rule, note why,
and re-score the earlier runs. Don't count it against the miner.

**Changing `reference-src/` means changing `gold.yaml` line numbers in the same commit.** The
self-test can't catch that drift, because it builds its cards from `gold.yaml` itself.
