# Spec: Build-lane test cadence and run supervision

2026-09-29 · @Tam Mai

## Problem

In the crm-rebuild project, slices S5–S7 showed that the G5 build loop spends more wall-clock on running and waiting for tests than on building. Three causes stood out, and a fourth showed up in the linear rebuild.

- **Full suites ran too often.** Lanes ran the full deploy suite (about 45 minutes) and the full Go suite (45–60 minutes) after every batch. The lanes shared one deploy stack, so each full run also blocked the other lane. The user ruled: "i want to boost implemetation time … i dont want to take to much time for testing."
- **Lanes stalled after a run finished.** A lane watched its long run with a Monitor, which gives up after at most 30 minutes, then went idle "waiting for the notification". Nothing woke it. This happened five or more times in two days: 2½ h, 40 min, and several 10–20 minute gaps. The orchestrator only noticed when the user asked for status. The user said: "this repeated many times today, i dont want this situation happend again."
- **Dated artifacts used UTC.** `parity.mjs`, `slice-review.mjs` and `equiv.mjs` name and look up their files with `new Date().toISOString().slice(0, 10)`, while the JUnit files a lane writes use the local date. At 04:00 in UTC+7 this:
  - overwrote the previous slice's committed parity report;
  - would have made slice-review read the previous slice's JUnit as "today", which happened once in S5 and produced a false 145/150 with five fake regressions.
- **The orchestrator ran the suites itself.** In the linear rebuild, about 430 of about 660 test runs happened in the main orchestrator context, not in a lane — edit→test loops, and full suites chained onto routine checks (`autopilot.mjs check && go vet && go test ./...`). Those are the most expensive tokens in the project, because every turn carries the whole session.

The first three were fixed by hand in one workbench: its runbook, its memory, a cron watchdog, and edits to vendored scripts. This spec moves them into the plugin, so every rebuild gets them by default.

**Frequency is half the cost; the price of one run is the other half.** In the linear rebuild, a full `go test ./...` took 7–10 minutes because every integration test ran `initdb` and all 56 migrations before its first assertion — about 2s of setup around tests that take milliseconds. Caching the migrated cluster and cloning it per test cut that to 4½ minutes (one package: 114s → 29s) with no change to isolation. This spec does not fix harnesses — they belong to the code repos — but E9 makes setup cost a measured number in the runbook, so the next one is noticed at S1 rather than at S7.

## Goals and non-goals

**Goals**

- Each slice runs the full cumulative suite exactly once, at the end of the build. During the build, lanes run only what they touch.
- The orchestrator never runs a suite. It reads the JUnit a lane wrote.
- A lane never sits idle once its long run has ended. If it does, the orchestrator notices within 10 minutes without being asked.
- Every dated artifact uses the same calendar as the JUnit files it's read with, so slice-review can never read the wrong day's run.
- Re-running only the failed specs after the joint run is a first-class step, and every report that states a pass rate counts it the same way.

**Non-goals**

- Weakening the evidence bar. A criterion is still PASS only when its test has passed against the code being shipped, and "the acceptance criteria are the deliverable" is unchanged.
- Changing what a criterion's class means (`[UNIT]`/`[INTEGRATION]`/`[DEPLOY]`/`[FIXTURE]`).
- Parallelising deploy suites across lanes. The shared-stack coordination stays as it is (the redeploy and worker-stop slots).
- Fixing a project's test harness. That is code-repo work; E9 only makes its cost visible.
- A general job scheduler. The watchdog is a per-session convenience.

**Success metrics**

| Metric | crm-rebuild S5–S7 | Target |
|---|---|---|
| Full cumulative deploy runs per slice | 3–5 | 1, plus reruns of only the failures |
| Test runs in the orchestrator's own context | ~65% (linear rebuild) | 0 |
| Lane idle after its run ended, before reporting | up to 2½ h, 5+ incidents | ≤ 10 min, auto-nudged |
| Slice reviews that read the wrong day's JUnit | 1 (S5), plus 1 near miss (S6) | 0 |
| Parity reports overwritten by a same-UTC-day run | 1 | 0 |
| Rerun passes reported without saying whether code changed | every one | 0 |

## E9 — Reduced test cadence during G5 build

`g5-build.md` today says CI runs "lint, tests, … AC-coverage" per lane. It doesn't say how often a lane may run the slow suites while building, or who runs them, so lanes default to running everything after every batch and the orchestrator re-runs them to be sure.

**The rule** (a new section in `g5-build.md`, "Test cadence within a slice"):

| When | Who | Run | Don't run |
|---|---|---|---|
| During the build | the lane | lint, type-check, unit and fixture tests for touched files; integration tests for touched packages; the ONE deploy test for the criterion being worked on (`--grep` / `-run`) | the full deploy suite; the full backend suite |
| End of build (once per slice) | one lane, named in advance | ONE joint full run: the full backend suite plus every backend deploy suite, then the full frontend deploy suite. JUnit goes straight to `parity/<local-date>-ac.xml` | extra "clean" full runs |
| After the joint run | the lane that owns the failure | re-run ONLY the failed specs, with JUnit to `parity/<local-date>-ac-rerun.xml` | another full run |
| Any time | the orchestrator | nothing. It reads the JUnit files and the lane's report. A failure to investigate goes to a lane or a fork, never into the main context | any test command |

- **Redeploys are batched.** A lane redeploys only when a deploy test needs the new build, and says so before and after.
- **Evidence bar, unchanged.** A criterion is PASS only under the counting rule in E12. Otherwise it's PENDING with a reason, and a slice can't close with an unexplained PENDING.
- **Not configurable.** No project setting brings back a full suite after every batch; the full suite runs once per slice, at the joint run, everywhere. A suite that genuinely needs more ("always run the migration tests in full") is named in the build runbook as a per-suite exception with its reason, and every other suite keeps the cadence above.
- **Scope.** The cadence applies to G5 slice builds. GP (the production-readiness gate) keeps its own full-suite requirements.

**Setup cost is a measured number.** The S1 runbook's `## Test fixtures` section records, per suite, the wall-clock of one full run and the share of it spent in per-test setup (fixture creation, database boot, migrations, sign-up flows). Measure it by timing one package or spec file and comparing the slowest tests to their assertion work. If setup is more than half of a suite's runtime, fixing the harness goes on the next slice as its own task, before any cadence rule is relaxed to compensate. Each boundary's amendment updates the numbers.

**Changes**

- `g5-build.md`: the new "Test cadence within a slice" section, and the step list in "Per-slice sequence" updated to name the joint run, its owner, and the rerun.
- `g5-build.md`: the runbook template's `## Test fixtures` section gains the setup-cost line.
- `subagent-briefs.md`: the build-lane brief carries the cadence table verbatim, so lanes don't have to infer it.
- `SKILL.md`: one line in the G5 guardrails pointing at the section, including that the orchestrator runs no tests.
- `autopilot.md`: the per-unit loop says the same — a unit's evidence is its lane's JUnit, not a suite the orchestrator re-runs after it.

## E10 — Long-run supervision

**Lane rule** (in the build-lane brief, in `subagent-briefs.md`):

- Any command expected to run longer than about 2 minutes is started with Bash `run_in_background: true` and its output sent to a log file. The process exit is the completion signal. A Monitor must never be the only signal that a long run has ended, because it expires after at most 30 minutes.
- Whenever the lane wakes, for any reason, it first checks whether its own run's process is alive. If the run has ended, it reads the result and acts before doing anything else.
- A lane never ends a turn "waiting for the notification" unless its own background process is still running.
- A lane reports a run's result to the orchestrator in the same turn the run ends.

**Orchestrator watchdog** (in `g5-build.md`, "Guardrails you enforce as orchestrator"):

- While any build lane has a long run open, the orchestrator runs a recurring 10-minute check (CronCreate, session-scoped). It looks for:
  - live test processes;
  - the mtime and status of the frontend's `.last-run.json` and `parity/*-ac*.xml`;
  - one-off ops containers;
  - `git log` and `git status` of each code repo and worktree.
- If a lane is idle, none of its processes is alive and it hasn't reported for more than 10 minutes while work remains, the orchestrator sends it the exact evidence (file, mtime, status, counts) and tells it to resume. It tells the user in one line.
- The watchdog stops itself once every lane has sent its final report.
- A new `scripts/lanes-check.mjs` does the evidence-gathering in one call, so the check is cheap and the same in every project.
  - Output: per repo and worktree, the last commit time, the dirty count and the live processes. It also prints the newest results file and its status.
  - Process detection works on Windows (`tasklist`: `go.exe`, `*.test.exe`, Playwright `node.exe`) and on macOS/Linux (`ps`: `go`, `*.test`, Playwright `node`). crm-rebuild runs on Windows and the linear rebuild on macOS, so both are needed from the first version.
  - Exit code: 0 when there's nothing to act on, and 2 when a lane looks stalled. It's heuristic, and the orchestrator decides.

**Parallel helpers.** A build lane may run helper agents only in their own worktrees, with:

- disjoint file ownership;
- unique test DB and role prefixes;
- test pools capped and closed in cleanup. S6 hit Postgres connection exhaustion because one harness leaked 34 connections.

Only the lane merges to main. This is already practice in crm-rebuild; it goes into the brief so it's no longer rediscovered each time.

**Changes**

- `subagent-briefs.md`: the lane rule, and the helper-isolation rule.
- `g5-build.md`: the watchdog guardrail.
- `scripts/lanes-check.mjs` (new), vendored by `rebuild-init.mjs` and refreshed by `upgrade.mjs`.

## E11 — Local-calendar dates for dated artifacts

`parity.mjs:92`, `slice-review.mjs:78` and `equiv.mjs:522` each compute `new Date().toISOString().slice(0, 10)`, which is the UTC date. Lanes name JUnit files by local date. East of UTC, local mornings and UTC evenings fall on different dates.

**The rule.** Any date that names or looks up a file uses the local calendar:

- A shared helper `localDate()`, the same zero-dependency style as the existing scripts, returns `YYYY-MM-DD` from `getFullYear`, `getMonth` and `getDate`.
- Log timestamps stay UTC ISO instants. `gate.mjs`, `autopilot.mjs`, `flows.mjs` and `sequence.mjs` are unchanged, because they don't date files.

**Which run each report reads stays as designed.** `acsuite.mjs` documents two different correct answers to "which run": `parity.mjs` reads today's file only, because its report is dated and must not borrow another day's numbers; `slice-review.mjs` reads the newest file and states its age, because a slice review is written at a boundary, which is rarely the day the suite ran and often crosses midnight. This spec keeps both. What changes is how loudly an old file is announced.

**A guard against reading the wrong run.** slice-review §1 already prints the source file and its age ("(today)" or "N day(s) ago"). Two changes:

- **Any non-zero age is a WARNING line at the top of §1**, naming both dates. Today `ageDays` is computed as `Date.parse(date) - Date.parse(files[0].date)`, and when the file's date is *ahead* of the script's date — exactly the UTC-behind-local case — it comes out negative, fails the `ageDays > 0` test, and prints "(today)". `localDate()` removes the common cause; the warning on a negative age catches the next one (a clock change, a file copied from another machine).
- When today's `-ac.xml` is missing, §1 says "no joint run for today" and then reports the newest file under that warning, rather than silently presenting it as current.

**Changes**

- `scripts/parity.mjs`, `scripts/slice-review.mjs`, `scripts/equiv.mjs`: use `localDate()`.
- `slice-review.mjs`: the non-zero-age warning and the "no joint run for today" line.
- `g5-build.md`: one line under the joint run, saying JUnit is written to `parity/<local-date>-ac.xml`.
- `upgrade.mjs` picks up the vendored-script change as a normal refresh.

## E12 — Rerun evidence, counted once and the same everywhere

Today slice-review reads only `parity/<date>-ac.xml`. After a joint run with failures and a green rerun, §1 shows the failures and the reader has to reconcile the rerun by hand. S6 needed a hand-written paragraph for this.

A green rerun can mean two different things, and they must not be reported as one:

- **Nothing changed between the runs.** The test failed and then passed on the same code. It is flaky, and a flaky acceptance test is a finding, not a pass to be quietly banked.
- **Code changed between the runs.** Only the failed specs ran against the new code. Nothing checked what the fix did to the tests that passed in the joint run.

**The rule.**

- **Both runs record the commit they ran against.** The lane writes `parity/<local-date>-ac.meta.json` beside the joint-run JUnit and `-ac-rerun.meta.json` beside the rerun, each holding the commit SHA of every code repo in `repos.yaml` and the start time. JUnit has no standard field for this, so it goes in a sidecar file rather than a property the reporters would have to parse out.
- **Counting lives in `acsuite.mjs`**, as one function both `parity.mjs` and `slice-review.mjs` call, so the two reports cannot disagree on a pass rate. A criterion counts as PASS for the slice if it passed in the joint run, or failed there and passed in the rerun.
- **Every rerun pass carries its condition:**
  - SHAs match: listed as **passed on rerun — flaky**, counted separately in the headline ("148/150, 3 of them flaky"), and each one goes into `plan/progress.yaml` `notes:` on the slice.
  - SHAs differ: listed as **passed on rerun — code changed**, with the commits between the two runs. The block also warns that the joint run's other passes predate those commits, and names the files changed.
  - A sidecar missing: listed as **passed on rerun — unverified**, never silently as PASS.
- The rerun block sits beside the joint-run numbers and never replaces them. It lists which of the joint run's failures re-ran, which passed and which still fail, and any rerun test that wasn't a joint-run failure, as a warning. Both files are cited.
- **Label new tests correctly.** A test absent from the previous run that fails today is labelled "failing, new since `<date>`", not "already failing". This was fixed by hand in crm-rebuild; upstream it.
- `acsuite.mjs`'s `-ac.xml$` filter already excludes `-ac-rerun.xml`. Keep that, and add a test for it.

**Changes**

- `scripts/acsuite.mjs`: the shared counting function and the sidecar reader.
- `scripts/slice-review.mjs`: the rerun block, the flaky/code-changed/unverified labels, and the new-test label.
- `scripts/parity.mjs`: its AC pass rate comes from the same counting function.
- `g6-parity.md`: one paragraph on how rerun evidence is counted, and what the three labels mean.
- `subagent-briefs.md`: the lane writes both sidecars.

## Open questions

- **The autopilot preflight blocks mid-slice.** `autopilot.mjs preflight` runs `pause-check`, which requires every repo to be clean and pushed. During a build, lanes have uncommitted work by design, and the user may not want mid-slice pushes. So autopilot can never engage in G5. Options:
  - (a) a `--phase build` mode that downgrades "unpushed" and "uncommitted" to warnings;
  - (b) leave it strict, and document that autopilot is for between-slice stretches only;
  - (c) relax the check at **engage** time only, and keep it strict at **pause** time.

  Recommendation: (c). What `pause-check` protects is work surviving a session that stops, and mid-slice is when there is most of it to lose. Engaging on a dirty tree is safe; halting on one is not.

## Rollout

- Ship as v0.19.0. The changes are additive to the references and the lane brief. The vendored scripts are refreshed with `node scripts/upgrade.mjs` in existing workbenches, and nothing breaks for a workbench that doesn't upgrade: without sidecars, rerun passes report as "unverified", which is honest.
- CHANGELOG entry: the incidents above as the "why", following the v0.18.0 entry's style.
- Evals, under `skills/rebuild-pipeline/eval`:
  - a UTC/local date split: slice-review picks today's local file or warns;
  - a file dated ahead of the script's date: slice-review warns instead of printing "(today)";
  - a failed-then-passed test with matching SHAs: counted as PASS and labelled flaky;
  - a failed-then-passed test with differing SHAs: labelled code-changed, with the commit list;
  - the same JUnit pair through `parity.mjs` and `slice-review.mjs`: both state the same pass rate.
- crm-rebuild: its workbench already runs the first three by hand. After v0.19.0, run `upgrade.mjs` there and drop the local edits the upgrade supersedes: the runbook sections stay as project history, and the vendored script edits are replaced.
