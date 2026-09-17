# Gate 5 rubric — production-readiness lock (`parity/production-readiness.md`)

What locks: the terminal gate. There is no phase after it, which means nothing downstream will
catch an overclaim — this is the one gate whose review cannot be corrected by the next one. So
the rubric is almost entirely about honesty: whether each checklist line is backed by something
that was actually run, and whether what is still broken is written down as broken.

Read: `parity/production-readiness.md`, the most recent `parity/<date>.md`, `plan/progress.yaml`,
the AC-suite output the parity report cites, and — for an `own-code` reference — the newest
`parity/<date>-equiv.xml` with `parity/equiv/DECISIONS.md`.

## D1. Checklist evidence quality

**Asks:** for each checked line — what was run, when, and where can a reader see the output?

- **5** — every line points at a specific artifact: a run with a date, a log, a dashboard, a
  release build number, a test result. A reader can re-check any line without asking anyone.
- **3** — lines are checked with a description of what was done but nothing to look at, so the
  checklist records a memory.
- **1** — lines are checked because the work was planned, or because a script printed a banner
  covering steps it skipped.

**Cite below 4:** the checklist lines with no verifiable evidence behind them.

## D2. Unresolved-risk honesty

**Asks:** does the document name what is still wrong, or does it read like a launch
announcement?

- **5** — open risks are listed with their blast radius and who accepted each one; deferred
  acceptance criteria are named as deferred rather than absent; a knowingly-unmet `done_means`
  clause from any slice still appears here.
- **3** — risks are listed but softened — no severity, no owner, no consequence.
- **1** — the risk section is empty on a project that has any `partial` feature, any `deployed`
  (rather than `done`) slice, or any failing AC.

**Cite below 4:** the specific unmet thing, and where it is recorded (slice id, feature id, or
the AC that fails).

## D3. Consistency with the parity report and progress overlay

**Asks:** does the readiness document agree with the numbers the scripts produced?

- **5** — coverage, AC pass rate and slice statuses match the latest `parity/<date>.md`,
  and where they differ the document says why and which is authoritative.
- **3** — the numbers are stale by a slice or two and nobody re-ran the report.
- **1** — the document claims coverage the parity report does not support, or cites a pass rate
  no JUnit file contains.

**Cite below 4:** the figure in the readiness doc and the figure in the parity report.

## D4. Operability by someone who did not build it

**Asks:** the pipeline's output is meant to outlive the session that produced it. Could a
second person run this in production?

- **5** — deploy, rollback, credential rotation, on-call surface and the kill switch each have
  a named procedure that has been executed at least once, not just written.
- **3** — the procedures exist on paper and none has been rehearsed.
- **1** — rollback is undefined, which means the first bad release is also the first time
  anyone thinks about it.

**Cite below 4:** the procedures that are written but never executed, or missing entirely.

## D5. Equivalence with the legacy system

**Applies only** where `sources.yaml` has `reference.kind: own-code`. For a third-party
reference there is no equivalence lane and this dimension is **not scored** — say so in *What I
could not check* rather than scoring it 5, which would read as evidence that does not exist.

**Asks:** the traces were recorded from the old system before the rebuild existed. Does the
production candidate still produce what they captured, and is every difference that remains
explained rather than merely present?

- **5** — the newest `parity/<date>-equiv.xml` was produced by replaying against the production
  candidate, every recorded trace is in it, and each red trace has a dated entry in
  `parity/equiv/DECISIONS.md` naming what differs and why it is intended.
- **3** — the run is green but predates the candidate, or recorded traces are missing from it —
  so the number is real and is about a different build than the one shipping.
- **1** — red traces with no decisions, or no equivalence run at all on a project whose
  `parity/equiv/` holds traces. Recorded is not green, and an unreplayed trace is evidence
  nobody checked.

**Cite below 4:** the trace names, and for each either the missing decision or the date gap
between the run and the candidate.

**Count the traces yourself, against `parity/equiv/`.** The pass rate in the JUnit is over what
RAN, so a suite that quietly stopped replaying half the directory reports 100%. That arithmetic
is the single most likely overclaim in this dimension, and it is invisible in the number.

**Accepted differences are not a penalty.** A project with three logged, reasoned acceptances is
in better shape than one with an equivalence suite nobody ran. What earns a low score is a
difference nobody decided about — or a decision whose reason is that the test was red.
