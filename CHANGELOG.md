# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-07-28

The org-default playbook no longer prescribes Nuxt Layers for frontend feature boundaries. §5
had been recommending a *merging* mechanism to do *isolation* work, then requiring
`imports.scan: false` in every feature layer to undo the framework default it had just opted
into — and the section said so out loud ("Layers are a merging mechanism, not an isolation
mechanism") while recommending them anyway. That contradiction is resolved in favour of plain
feature folders, which get the same lintable-import property from Nuxt's own scan rules with no
config to maintain.

### Changed

- **§5.1 — the Nuxt default is `app/features/<feature>/`, not `layers/<feature>/`.** Both stacks
  now describe one shape (thin route layer that composes, feature folders that own) instead of
  two. The reasoning is stated rather than asserted: Nuxt auto-imports `app/components/**`
  recursively but scans `app/composables/` **top level only**, so `app/features/*/composables/`
  falls outside the scan — shared primitives stay auto-imported while crossing into a feature
  *requires* a written import, which is the artifact §5.3's lint analyzes. Layers reach the same
  end state only by disabling auto-import per layer. Third reason, independent of imports: pages
  live in `app/pages/` either way, so splitting them across N layers assembles one URL tree from
  N directories and turns route-prefix collisions into build-time merge behavior.
- **§5.1 gained a "When Layers *are* the right tool" clause.** Layers are a superset — a feature
  folder becomes one by adding a `nuxt.config.ts` and an `extends` entry — so the guidance names
  the cases that earn them (a second Nuxt app sharing feature code; a base app extended by
  several product apps; a feature needing its own `nuxt.config`) and the case that looks like one
  and isn't (Electron/Tauri wrapping the same app is not a second app).
- **§5.3 — one enforcement setup for both stacks**, three rules: route layer → any feature
  allow, feature → shared allow, feature → feature block. The Nuxt-specific precondition is now
  §5.1's folder shape rather than a config flag; the `imports.scan: false` requirement is kept,
  attached to the layers path where it belongs.
- §5.4 and the §17 checklist drop "a Nuxt layer or a Next feature folder" phrasing for the single
  feature-folder shape.

### Added

- **§5.2 — the route layer is a named, sanctioned exception to the no-cross-feature rule**,
  parallel to `analytics` as §4.2's one sanctioned cross-schema reader. Without it the rule has
  no escape valve for screens that legitimately compose several features (a work-package list
  needs teams, members, labels) and gets satisfied by promoting everything to `shared/`, which
  is indistinguishable from having no boundary. Bounded: thin files, no feature logic, no
  re-export that would let feature A reach feature B *through* a route file.
- Two §15 anti-pattern rows: Nuxt Layers used to express feature boundaries, and route files
  thick with feature logic instead of composing features.

## [0.5.1] - 2026-07-28

A review of 0.5.0 found that the durability logic it shipped fails in both directions — it
could call genuinely unpushed work safe, *and* raise issues no command could ever clear — and
that most of its printed remediations do not run in the state being reported, which is the one
property that release set out to establish. 0.5.0's section below is left as tagged; this is
what was wrong with it.

### Fixed

- **The unpushed-commit walk no longer fails open.** 0.5.0 named `HEAD` without verifying it,
  so on an unborn HEAD (a fresh repo, or `git checkout --orphan`) `git log` aborted with
  `ambiguous argument 'HEAD'` — and the failure path filed a *note* ("could not compare against
  remotes — skipped") under an overall `✅ Safe to pause — all work pushed to a remote`, while a
  whole branch of commits existed only on that disk. The pre-0.5.0 walk reported those.
  `rev-parse --verify` now guards the ref before it is named, and a walk that fails anyway is an
  issue, not a note: it reads local refs only, so failing is unexplained rather than expected.
- **`--tags` is out of that walk — it created a warning that could never clear.** The exclusion
  set `--not --remotes` covers remote-tracking *branches*, and pushing a tag creates no
  remote-tracking ref. So a `gate-N/vN` tag that **is** on origin, sitting on a commit no
  surviving branch reaches (what a reopen or a squash-merge leaves behind), counted as unpushed
  on every run forever, with the suggested `git push` answering "Everything up-to-date" — the
  exact failure 0.5.0's own comment claimed to have avoided by excluding `--all`. Tags are
  compared by name against the remote instead, and pushing an unpushed tag carries its commits,
  so no coverage is lost.
- **The remedy for unpushed commits is `git push --all origin`.** The count spans every local
  branch; a bare `git push` sends only the current one — and nothing at all on a branch with no
  upstream, which every fresh slice branch is (`fatal: The current branch … has no upstream
  branch`). Either way the user was told their work was off-machine when it had never left. The
  deleted `backup.mjs` ran `push --all` + `push --tags`, which is why it was the command 0.5.0
  replaced.
- **The detached-HEAD remedy works mid-rebase.** A conflicted rebase is the most ordinary way a
  session ends detached, and there `git switch -c <branch>` answers `fatal: cannot switch branch
  while rebasing`. The check now detects an in-progress rebase / cherry-pick / revert / bisect
  and says either to finish or abort it, or to park the current HEAD with
  `git branch wip/<name>`, which works without disturbing it.
- **Every printed `git -C <path>` is shell-quoted.** `repos.yaml` only forbids spaces in the
  *relative* path, and the absolute path is prefixed by the workbench's parent directory — no
  one's choice, and routinely `My Drive` or `Mobile Documents`. An unquoted `-C` produced
  `cannot change to '/…/My'`: work reported as unpushed, with no working command to push it.
- **Stashes are checked before the no-remote bail-out, not after.** 0.5.0 put both new checks
  after `if (!hasOrigin(dir)) { …; return; }`, so a repo still waiting for its remote — exactly
  where stashed work hides — reported only "no git remote". The user runs the printed
  `gh repo create --push`, it succeeds, the session ends, and the stash is never mentioned to
  anyone, because `git status` calls the tree clean.
- **The success verdict weakens when a check was indeterminate.** The tag comparison degrades to
  a note when the remote is unreachable (by design — a dead VPN must not block a session end),
  but the verdict still asserted "all work pushed to a remote". Local `refs/remotes/*` survive
  going offline, so a gate tag that was never pushed looked identical to one that was. An
  unreachable remote now ends the run `🟡 Safe to pause as far as could be checked`, naming what
  it could not rule out.
- **Something pushes gate tags again.** `backup.mjs` was the only caller of `git push --tags`,
  and 0.5.0 deleted it without adding a step anywhere, so `gate.mjs lock` could mint a
  `gate-N/vN` submodule pin that never left the machine — a code repo then gets
  `pathspec 'gate-4/v2' did not match`, or silently keeps building against the previous
  contract. `gate.mjs` now prints `git push && git push --tags` at the moment of locking, and
  G0, G5, SKILL.md Step 5 and the scaffolded README say the same. Not `--follow-tags`: it pushes
  annotated tags only and gate tags are lightweight, so it would quietly push nothing.
- **A registered repo whose path does not exist is an issue.** It was a note
  (`path does not exist … — skipped`) under `✅ Safe to pause`, so one typo in `repos.yaml`
  silently left a repo unchecked for uncommitted and unpushed work for the rest of the project.
  G5's repo checklist also regains the confirmation step (removed in 0.5.0 along with its
  `npm run backup -- status` command) that catches it at registration time.

### Migration

**If you upgraded an existing workbench to 0.5.0, re-copy its scripts now.** `rebuild-init.mjs`
copies `validate.mjs`, `gate.mjs`, `parity.mjs` and `pause-check.mjs` into the workbench at
scaffold time and nothing ever re-syncs them, while `npm run pause-check` resolves to that
frozen copy. So a workbench that followed 0.5.0's migration note — delete `scripts/backup.mjs`
— now runs an old `pause-check.mjs` whose remediations invoke the file just deleted
(`Cannot find module`), and none of 0.5.0's or 0.5.1's fixes reach it.

```sh
# from the workbench root
for s in validate.mjs gate.mjs parity.mjs pause-check.mjs; do
  cp "$CLAUDE_PLUGIN_ROOT/skills/rebuild-pipeline/scripts/$s" "scripts/$s"
done
```

## [0.5.0] - 2026-07-28

### Removed

- **The automated backup flow is gone.** `scripts/backup.mjs` (push-all-repos, `status`,
  and the self-installing launchd/systemd daily schedule) is deleted, along with the
  `npm run backup` script it registered in scaffolded workbenches. Keeping work off-machine
  is now manual: give every repo a remote at creation, push it yourself, and let
  `npm run pause-check` tell you when something has not left the machine.

  Two of the flow's own failure modes argued against keeping it. Committed work on a
  **detached HEAD** was invisible to both the push (`git push --all` only sends
  `refs/heads/*`) and the health report (`git log --branches --not --remotes`), so a repo
  holding unpushed commits was reported as `✅ fully pushed` — and the pipeline itself hands
  out `git checkout --detach <gate-tag>` for submodule syncing. Separately, the scheduled job
  had to hard-code an absolute `node` path, so a version-manager upgrade broke it silently;
  the script warned about this at install time and then had no way to resurface it. An
  advisory check that is honest beats an automation that reports green while losing commits.

  **Existing workbenches are unaffected until you act.** `rebuild-init.mjs` copied
  `backup.mjs` into each workbench rather than running it from the plugin, so any schedule you
  installed keeps working off its own copy. To retire one:
  `node scripts/backup.mjs uninstall` in that workbench, then delete
  `scripts/backup.mjs` and the `backup` entry from its `package.json`.

### Fixed

- **`pause-check.mjs` no longer reports work as pushed when it is on a detached HEAD.** Its
  unpushed walk used `git log --branches --not --remotes`, which reads `refs/heads/*` only —
  so a commit made while HEAD was detached was invisible, and the repo came back
  `✅ Safe to pause — all work pushed to a remote`. It now names its refs explicitly
  (`--branches --tags HEAD`), and when HEAD is detached it says so and gives the remedy that
  actually works: `git switch -c <branch>` then `git push -u origin <branch>`, since a plain
  `git push` fails with "You are not currently on a branch". This was `backup.mjs`'s bug too;
  with that script gone, `pause-check` is the only off-machine signal left, so the blind spot
  mattered more, not less.

  Explicit refs rather than `--all`, deliberately: `--all` includes `refs/stash`, and no
  `git push` can send a stash, so counting stashes in this number produces a warning whose
  suggested fix does nothing and which therefore never clears.
- **Stashed work is now reported, with the right remedy.** A stash is local-only by
  construction and is easy to leave behind precisely because `git status` then calls the tree
  clean — so a session could end `✅ Safe to pause` with real work in `refs/stash`. It is now
  its own issue pointing at `git stash list`, separate from the unpushed-commit count.
- **Unpushed tags are now caught.** `git log` walks commits, so a `gate-N/vN` tag pointing at
  an already-pushed commit was structurally invisible while still being local-only — and code
  repos pin the workbench as a submodule at exactly those tags, so one that never left the
  machine breaks `git clone --recurse-submodules` for everyone else. `backup.mjs` used to
  `push --tags` on every run, so removing it opened this gap. `pause-check` now compares local
  tags against `git ls-remote`. That is its only networked check: it runs with
  `GIT_TERMINAL_PROMPT=0` and a 5s timeout, and degrades to an advisory note (never a blocking
  issue, never a prompt, never a hang) when the remote is unreachable.

### Changed

- The scaffolded `validate.yml` drops its `auto-backup/**` exclusions and the
  `github.head_ref` job guard, which existed only to keep daily snapshot force-pushes from
  emailing CI failures. The trigger is now plain `[push, pull_request]`. Note that
  `tags: ['**']` went with them **because it had to** — a push trigger carrying only branch
  filters stops firing on tag pushes, so the two were load-bearing together; unfiltered
  covers every branch and every `gate-N/vN` tag. The workflow comment records this for anyone
  tempted to re-add a branch filter alone.
- `pause-check.mjs` still flags repos with no remote and commits on no remote — its
  remediation text now points at `git push` instead of the removed script.
- G0 and G5 keep "give it a remote, visibility per `license-posture.md`"; only the
  schedule-installation steps and the `npm run backup -- status` confirmations are gone.
  "Backup-only remote" is now phrased "durability-only remote" throughout, since the
  distinction it draws — a remote for durability vs. a remote that also runs your CI — is
  unchanged and still asked explicitly at both gates.

### Recorded late

Two changes landed in the 0.4.9 line without a CHANGELOG entry and are noted here rather
than by editing a tagged section:

- **The regression suite was removed** (`e918f55`): `tests/regress.mjs` (856 lines) and the
  `test` script in `package.json`, both added in 0.4.4. It is inside the `v0.4.9` tag. As a
  result **v0.4.6's note that "`npm test` is unchanged and remains the way to check the
  scripts: 59 tests, run it before tagging" is historical** — there is no `npm test` now, and
  the scripts have no automated coverage. Worth knowing when reading 0.4.4, 0.4.5 and 0.4.8,
  all of which cite that suite as their safety net.
- **`g5-build.md` points slice completion at `plan/progress.yaml`** (`1ba719d`), completing
  0.4.9's progress-overlay change on the doc side.

## [0.4.9] - 2026-07-28

### Fixed

- **Recording slice progress no longer requires reopening a gate.** `parity.mjs` read feature and
  slice status out of `matrix/features.yaml` and `plan/slices.yaml`, which gate-1 and gate-2 hash
  *whole*. So marking a finished slice — bookkeeping, not a decision — cost a formal gate reopen
  and rewrote the very hash that code repos pin the workbench at as a submodule, once per slice.
  A live workbench hit this with its first slice complete: the report read `0/209 covered` with
  six lanes built, deployed, and every acceptance criterion covered by an observed test. Worse
  than the wrong percentage, **scope-creep detection was inert**: it fires only for features in a
  slice marked `done`, and no slice could ever be marked `done`, so the check silently never ran.

  Progress moves to **`plan/progress.yaml`** — ungated, validated against the new
  `progress.schema.json`, and overlaid onto the locked artifacts at report time (an entry there
  wins; anything absent falls back to the locked `status:`). Gates go back to protecting decisions
  only: the feature taxonomy and the slice boundaries. Workbenches scaffolded before this keep
  working — `parity.mjs` warns that a built slice will read as `planned` and falls back.

- **A re-run on the same date no longer destroys the hand-written half of a parity report.** A G6
  run is part generated, part authored: the AC-suite result and the upstream re-mine writeup are
  prose. `parity.mjs` rewrote the file wholesale, so running it twice in one day silently ate
  them. It now preserves every `## ` section it does not generate, and is idempotent.

- **Scope-creep detection counts `deployed` as shipped, alongside `done`.** A slice that ships
  with a `done_means` clause knowingly unmet stays out of `done` on purpose — the honest status,
  and previously the one that switched the check off. Both now trigger it.

### Added

- `validate.mjs` validates `plan/progress.yaml` and cross-references every feature and slice id
  against the locked artifacts, so a typo'd id fails loudly instead of silently never matching.

## [0.4.8] - 2026-07-28

### Fixed

- **The scaffolded `validate.yml` runs on tag pushes again.** A push trigger that carries only
  branch filters stops firing on tags altogether, so v0.4.7's `branches-ignore` silently took
  the `gate-N/vN` tags out of CI — the ones `gate.mjs lock` mints and `backup.mjs` publishes
  with `git push --tags`, and the ones every code repo in `repos.yaml` pins the workbench at as
  a submodule. Locking a gate on a local branch and pushing just the pin produced no validate
  run at all, so a gate tag with broken `contracts/` or lock hashes could be consumed with zero
  signal. Restored with `tags: ['**']` alongside the branch filter.

- **A pull request opened from the snapshot branch no longer rebuilds on every daily backup.**
  `pull_request` branch filters match the *base* branch, so v0.4.7's `branches-ignore` on the
  push trigger did nothing for a PR whose *head* is `auto-backup/<host>` — a natural way to
  inspect or recover auto-backed-up work. Each daily force-push fired a `synchronize` event and
  the daily failure email continued. Excluded at the job instead, on `github.head_ref`, which is
  the only place the head branch is filterable.

- **The v0.4.7 regression test can now actually catch the regression it guards.** Four ways it
  could not: `startsWith("auto-backup")` accepted `['auto-backup']` and `['auto-backup-*']`,
  neither of which glob-matches `auto-backup/<host>` (a GitHub filter pattern needs `/**` to
  cross a `/`), so the fix could be undone with the suite green; the prefix was hardcoded rather
  than read from `SNAPSHOT_BRANCH` in `backup.mjs`, so renaming the snapshot branch there left
  the template ignoring a pattern nothing pushes; nothing asserted the `pull_request` trigger
  survived an edit to the `on:` block; and the `!on?.push` guard was never true for the list
  form `on: [push, pull_request]` it existed to diagnose, because `Array.prototype.push` is a
  truthy `push` property. The test now matches patterns with a real glob matcher, derives the
  ref from `backup.mjs`, and asserts the tag filter, the `pull_request` trigger, and the head-ref
  guard are all still there. Verified by mutation: each of the six regressions above fails it.

## [0.4.7] - 2026-07-28

### Fixed

- **The scaffolded workbench's `validate.yml` no longer fires on backup snapshot branches.** It
  shipped with `on: [push, pull_request]`, and `backup.mjs` force-pushes uncommitted work to
  `auto-backup/<host>` on every run — so an unfiltered push trigger fires on the snapshot too,
  and a workbench whose validate cannot pass on a hosted runner emails a failure *every day the
  backup runs*. This is the exact interaction v0.4.3 documented for the code repos; the scaffold
  it generates had the same shape and was missed, because v0.4.3 fixed the advice without
  fixing the template.

  Excluded via `branches-ignore: ['auto-backup/**']` rather than allow-listing `main`. A
  snapshot branch is the only trigger worth suppressing — allow-listing a branch name would
  also stop CI on feature branches, and would silently cover nothing at all in a workbench whose
  default branch is not called `main`. Named from `SNAPSHOT_BRANCH` in `backup.mjs`, so the two
  stay in step, with a regression test asserting the generated workflow keeps excluding it.

## [0.4.6] - 2026-07-28

### Removed

- **`.github/workflows/test.yml`.** Added one release earlier, and wrong for how this repo is
  actually maintained: a single maintainer on macOS who runs `npm test` on demand. A hosted
  gate bought nothing here — it can only confirm what a local run already showed — while
  costing a red X on any commit whose failure was environment-specific rather than real, which
  is precisely what happened to v0.4.4 (the suite failed on Linux and passed on macOS, on
  timing). It also made pushes need a `workflow`-scoped token, which is why this repo is on an
  SSH remote now.

  `npm test` is unchanged and remains the way to check the scripts: 59 tests, run it before
  tagging. The version/CHANGELOG coupling it asserts is the part of the release ceremony worth
  automating, and that works locally.

  Note this is *this repo's* CI, not the scaffold's. Workbenches still ship
  `.github/workflows/validate.yml`, which schema-validates artifacts and gate hashes — that one
  earns its keep, because a workbench is shared with code repos that pin its gate tags.

## [0.4.5] - 2026-07-28

### Fixed

- **`pause-check.mjs` no longer reports a dev server in a repo that has none.** The host-native
  process check ran `pgrep -f "<repo abs path>"`, and `pgrep -f` is an *unanchored* regex match:
  the bare path also matches any sibling that merely extends it, so `/x/foo` matched
  `/x/foo.git`, `/x/foo-backup` and `/x/foobar`. The likeliest false match is the repo's own
  bare remote (`<repo>.git`), which means the noise appeared exactly where backups run — and a
  pause check that cries "dev server still running" on a clean repo is one people learn to
  ignore, which costs more than the check was worth. Now requires a path boundary: the next
  character must open a child path, be whitespace, or end the command line. Same prefix-boundary
  discipline `gate-guard.mjs` already applies when matching `protects:` directories, where
  `adr/` must not match `adrenaline.md`.

  Found by v0.4.4's own suite on its first CI run — the fixture pushed to a bare repo named
  `<repo>.git` beside the repo, and a lingering `git` process from that push matched the prefix.
  It passed on macOS and failed on the Linux runner purely on timing, which is what the bug
  looks like in the field too: intermittent, environment-dependent, and easy to dismiss. The
  regression test now asserts both directions — a sibling sharing the prefix is ignored, and a
  process genuinely under the repo is still caught — because a boundary check that is merely
  always-off would have made the original test pass too.

## [0.4.4] - 2026-07-28

### Added

- **A regression suite for the executable surface** (`tests/regress.mjs`, `npm test`) — 58
  tests over the six pipeline scripts, the PreToolUse hook, and the shipped manifests. There
  was no test infrastructure at all before this: no `package.json`, no CI, and every bug in
  the 0.3.x/0.4.x line was found by running the pipeline on a real rebuild rather than by a
  check. Each test tagged `[vX.Y.Z]` reproduces one of those bugs, so a fix coming undone
  fails loudly instead of resurfacing four gates into someone's project. The tagged set covers
  the colon-in-reason YAML break (v0.3.1), the host-native dev server (v0.3.2), the
  newline-quoting gap and pause-check's stale unquote (v0.3.3), the dirty-tree lock and
  force-moved gate tag (v0.3.5), `pickNode`'s interpreter choice (v0.4.1), and the
  copyleft-specific visibility warning (v0.4.2).

  The v0.3.5 hash test is the one worth keeping honest: it hashes the blob **inside the gate
  tag** (`git rev-parse gate-1/v1:matrix/features.yaml`) and compares that against
  `artifact_hashes`. Checking the working tree instead is precisely the mistake the original
  bug made, so the assertion is written from the consuming repo's point of view.

  `backup.mjs install`/`uninstall` is deliberately not exercised — it writes a launchd/systemd
  unit and calls `launchctl`/`systemctl`, which changes the machine running the tests, not a
  fixture. Its interpreter-selection logic is covered instead by evaluating the real
  `pickNode` source block with `process.execPath` overridden, so the shipped logic is tested
  without the side effect. That is the one intentional gap, and it is reported as a skip rather
  than passed over in silence.

- **CI** (`.github/workflows/test.yml`) — runs `npm test` on pushes to `main` and on PRs.
  Branch-filtered rather than a bare `on: push`, for the reason v0.4.3 documents: an
  unfiltered trigger also fires on `auto-backup/<host>` snapshot branches. The suite sets its
  own `GIT_AUTHOR_*`/`GIT_COMMITTER_*` so fixture commits do not depend on a runner identity,
  and scaffolds into `mkdtemp` so it never touches the repo tree.

### Fixed

- **`pause-check.mjs` is now shipped into the scaffolded workbench.** `rebuild-init.mjs`
  copied `validate.mjs`, `gate.mjs`, `parity.mjs` and `backup.mjs`, but not this one — while
  its own usage header says "Run from the workbench root: `node scripts/pause-check.mjs`" and
  `g5-build.md` says "Both `scripts/pause-check.mjs` and `scripts/backup.mjs` read this list".
  Following either gave `MODULE_NOT_FOUND`. The pipeline itself was unaffected, which is why
  this went unnoticed since v0.3.0: `SKILL.md` invokes the script through
  `${CLAUDE_PLUGIN_ROOT}`, so the orchestrator always found it and only a human reading the
  docs hit the wall. Copying it is the honest fix rather than rewriting those two references —
  unlike `backup.mjs`, which is copied because its scheduled job stores an absolute path,
  nothing argued against copying this one in the first place. Also adds `npm run pause-check`
  to the generated workbench's `package.json` and lists it in the generated README.

## [0.4.3] - 2026-07-28

### Added

- **"Has a remote" and "the host runs our CI" are now separate decisions.** v0.4.0 told the
  pipeline to give every repo a remote and said nothing about the host's CI, so pushing five
  repos to GitHub started three failing workflows within minutes. G0 now asks what the remote
  is *for*, and G5's repo checklist gained a fourth item: backup-only means disabling the
  host's CI, because leaving it on emails a failure on every push.

- **The private-submodule trap is documented where repos get created** (`g5-build.md`). A code
  repo checking out with `submodules: true` fails on GitHub Actions the first time it is pushed
  — `fatal: repository '...workbench' not found`, which is not a missing repo and not a bad
  token: `GITHUB_TOKEN` is scoped to its own repository, so a private sibling reads as a 404.
  Fixing it properly needs a read-only deploy key plus a manual `git submodule update` over SSH
  (which preserves the gate-tag pin — a second `actions/checkout` of the workbench does not),
  and that is only worth doing if hosted CI is actually wanted. The reference also names the
  two other reasons these workflows fail on a hosted runner: secrets that were never set there,
  and paths `.gitignore` keeps out of the repo, deploy state files being the usual culprit.

- **`backup.mjs` documents its own interaction with CI.** A workflow triggering on `push` with
  no branch filter fires on the `auto-backup/<host>` snapshot as well, so a repo whose CI
  cannot pass on the host emails a failure *every day the backup runs*. Found the direct way:
  of the three code repos pushed, the one with a bare `on: push` was set to do exactly that
  daily, while the two filtered to `main` would have been quiet.

## [0.4.2] - 2026-07-28

### Fixed

- **The visibility warning no longer assumes the reference is copyleft.** It read "publishing a
  copyleft-derived rebuild is distribution", which is wrong for a proprietary reference — the
  Linear rebuild mines a closed-source SaaS, where the objection to a public remote is terms of
  service and trade secret, not a licence's copyleft clause. Stating the wrong mechanism
  invites the reader to dismiss the warning as inapplicable. The text now says publishing is
  distribution that the recorded posture does not cover, and leaves the mechanism to
  `license-posture.md`, which is where the actual reference licence lives. Same correction in
  `SKILL.md`'s failure-mode list and G0's visibility step.

### Note on the tag

The `v0.4.2` tag points at `c227064` ("Restore plugin.json emptied by a bad in-place edit"),
not at `26db795`, whose subject line reads `v0.4.2:`. That is deliberate and should stay that
way: the bad edit left `.claude-plugin/plugin.json` zero-length, so `26db795` is a commit where
the manifest does not parse and the plugin does not load. `c227064` is its child and restores
the six-line manifest, nothing else — it is the only commit on this line carrying both the
0.4.2 content and a loadable manifest. Retagging to make `git log --oneline` read tidier would
publish a broken tree.

## [0.4.1] - 2026-07-28

### Fixed

- **A scheduled backup no longer dies silently when node moves.** `install` wrote
  `process.execPath` into the launchd/systemd unit, and on the machine this shipped from that
  was `~/.nvm/versions/node/v24.14.1/bin/node` — a path the next `nvm install` deletes. The
  schedule would keep existing, keep reporting nothing, and never run again: the precise
  failure mode the feature exists to prevent, reintroduced by the feature. `install` now
  prefers a stable interpreter (`/opt/homebrew/bin/node`, `/usr/local/bin/node`,
  `/usr/bin/node`, first one that runs and is ≥ 18) and, when only a version-managed node
  exists, says so instead of pretending the schedule is durable.

- **`status` now flags a stale schedule.** An interpreter that vanished is one of several ways
  an unattended job goes quiet — an unloaded agent and expired push credentials look identical
  from the outside — so rather than checking each cause, `status` reports the age of the last
  completed run and warns at three days. That is the signal that actually distinguishes
  "backed up daily" from "backed up once, in March".

## [0.4.0] - 2026-07-28

### Added

- **`scripts/backup.mjs` — the pipeline now gets its own output off the machine.** Found on the
  WordPress rebuild, four gates in: the workbench and its code repo had *no git remote at all*.
  Six months of findings, the locked taxonomy, thirteen ADRs, four gate tags and a parity run
  existed on exactly one laptop, and nothing in the pipeline had ever said to push. The gap is
  easy to miss because the pipeline is scrupulous about durability *on disk* — checkpoint
  discipline, artifact-first, pause-check's git cleanliness — and every one of those checks
  passes with a green tick while the only copy sits one disk failure from gone. Worth being
  explicit about why this is not "just use git": mining output is **not reproducible**. Re-mine
  the reference and you get different findings; you do not get back the taxonomy you argued
  yourself into, or the reasons an ADR diverged. The reference checkout *is* reproducible and is
  deliberately excluded — on that project it was 966M of upstream clone versus ~2MB of actual
  decisions, and `sources.yaml` already pins the commits needed to restore it.

  `run` pushes every branch and tag for the workbench and each repo in `repos.yaml`, workbench
  first because code repos pin it as a submodule and a pinned commit must reach the remote
  before the parent that references it. `status` reports exposure without pushing. `install`
  schedules a daily run (launchd on macOS, systemd `--user` timer on Linux, printed cron
  instructions elsewhere), with `RunAtLoad`/`Persistent=true` so a laptop asleep at 13:00 for a
  week still backs up at login rather than silently skipping.

  Two design choices worth keeping: **uncommitted work is snapshotted onto `auto-backup/<host>`,
  never the mainline** — gate locks hash artifact content and `gate-N/vN` tags are consumed as
  submodule pins, so an unattended job committing to `main` would corrupt precisely the history
  the gates exist to make trustworthy. And the snapshot is built in a scratch `GIT_INDEX_FILE`,
  leaving HEAD, the index and the working tree untouched, because it runs while the user is
  mid-edit. It honours `.gitignore`, so `.env` files and `node_modules` stay local.

- **Repo visibility is now derived from `license-posture.md`, not left to the moment.** Backup
  means pushing a rebuild of (usually) a copyleft product to a hosting provider, and for a
  `private-learning` posture a public remote is *distribution* — the one condition that
  invalidates the posture and requires a G0 reopen. `backup.mjs` reads the posture and says so
  when a repo has no remote; G0 and G5 both spell out `--private` with the reason attached,
  since the user chose the posture minutes earlier and will not connect it to a `gh` flag.

### Changed

- **`pause-check.mjs` now asks whether the work left the machine**, not just whether it was
  committed. It flags a repo with no remote, and commits sitting on local branches no remote has
  (`git log --branches --not --remotes`). "Safe to pause" claiming success while every artifact
  lives on one disk was the specific false green that hid the missing remote for four gates.

- **`rebuild-init.mjs`** copies `backup.mjs` into the new workbench, adds an `npm run backup`
  script, tells the user to create the remote in its closing output, and documents it in the
  generated README. The copy is deliberate: the scheduled job stores an absolute path to the
  script, and a plugin cache path contains the plugin version, so running it from
  `${CLAUDE_PLUGIN_ROOT}` would leave every upgrade with a silently dead schedule.

- **`repos.yaml`'s own comment** now states that an unregistered repo is invisible to *both*
  `pause-check.mjs` and `backup.mjs` — never checked before a pause, and never backed up. G5's
  repo-creation step became a three-item checklist (register, remote, verify) for the same
  reason, and notes that a relative submodule URL (`../<name>-workbench`) resolves against the
  code repo's own remote, so keeping both repos under one owner makes
  `git clone --recurse-submodules` work with no per-machine setup.

## [0.3.5] - 2026-07-27

### Added

- **The callee check at G4b** (`skills/rebuild-pipeline/references/g4b-contracts.md`) — an explicit pass before every Gate 4 lock, including reopens: for each module the slice touches, which modules does it *call*, and does each callee's `internal/` contract actually expose the method being called? Found the hard way on the Linear rebuild's S9, where seven gaps all had this shape and cost a second gate-4 reopen after the specs were already written. The mismatch is invisible from inside the phase — every artifact is internally consistent, and the gap exists only *between* a caller's assumption and a callee's surface. Names the two patterns that produce most of them (a field added this phase whose only writer is a `Params` struct that doesn't carry it; a cross-module write through a read-only `Service`) plus a duplicate-ownership grep, since two contract files claiming the same job ships as a runtime bug rather than a merge conflict.

- **A pipeline flowchart in the README** (`docs/img/pipeline.png`) — the gate/phase sequence
  (G0 → G1 parallel mining → G2 → Gate 1 → G3 → Gate 2 → G4a → Gate 3 → G4b → Gate 4 → G5
  parallel build → G6 parity loop → GP → Gate 5) as a single picture, replacing the old plain-text
  version.

### Fixed

- **`gate.mjs lock` no longer lets its tag point at content the lock never hashed** (found
  2026-07-25). It computes `artifact_hashes` from the **working tree**, then commits with
  `git add <lockfile> && git commit` — staging only the lock file. Any artifact edited but not
  yet committed was therefore hashed into the lock while the `gate-N/vN` commit still contained
  the *previous* text, and code repos pin that tag as a submodule. Hit twice in one session on
  the Linear rebuild (gate-3 and gate-4), both times caught only by hand-comparing `shasum`
  against the lock and re-pointing the tag with `git tag -f`. `lock` now runs `git status
  --porcelain` before hashing and refuses if anything outside the lock file itself is dirty,
  telling the caller to commit or stash first — rather than `git add -A`, which would sweep
  unrelated in-progress work into the "gate-N: locked" commit uninvited.

- **Gate tags are now immutable and versioned (`gate-N/v1`, `v2`, ...) instead of a force-moved
  `gate-N/v1`.** Code repos consume the workbench as a submodule pinned by commit, and resolve
  that pin's name with `git describe --exact-match`. A submodule clone that had already fetched
  `gate-4/v1` kept resolving it to the OLD commit after a reopen, so the consumer's contract-sync
  reported success while still pinning the previous contract — the exact drift the ceremony
  exists to make impossible. Found during S9 stage 4 (`plan/backlog.md`); nothing was mis-synced
  only because neither reopen that day touched `openapi.yaml`. A moving `latest` alias was
  rejected for the same reason: any mutable ref reintroduces "the name resolves differently
  depending on when you last fetched." `lock` now mints the next `vN` and never moves an existing
  one, printing a re-pin reminder (`git fetch --tags && git checkout --detach <tag>`) whenever a
  gate is locked again after a reopen.

### Changed

- **`adr-drafter` now emits a `contract changes this implies` section** (`agents/adr-drafter.md`) — previously not part of the agent's structure at all, so its coverage depended on whatever the orchestrator happened to put in the brief. Now a standard section, required to enumerate the modules the decision makes the ADR's module a *caller* of — naming methods that don't exist yet, as "adding it is a PR against Y's file by its owner" — plus what is deliberately unchanged, and which existing file's wording a moved responsibility makes wrong.

## [0.3.4] - 2026-07-23

### Added

- **Ground-truth graph step for G1 lane D** (`skills/rebuild-pipeline/references/g1-mining.md`) — before dispatching lane-D miners, clone the pinned reference commit and run `/graphify` on it once (code-only corpus, AST extraction, no LLM cost) to produce a navigable knowledge graph of entities, routes, permission checks, and job classes. Miner briefs now carry the graph path (`subagent-briefs.md`) so miners query it with `graphify query`/`path`/`explain` instead of grepping raw source cold — findings still cite path + pinned commit as evidence, the graph is a navigation aid only. Skipped entirely under clean-room license posture, where the reference repo is already deny-listed.

## [0.3.3] - 2026-07-23

### Fixed

- **`gate.mjs`'s `yamlStr()` quoted values containing a newline without escaping it** —
  `needsQuoting()` flagged an embedded `\n` as needing quotes, but the escaper only handled
  `\` and `"`, so a multi-line title/reason/locked_by produced a quoted value spanning two
  physical lines. `get()`'s single-line regex then captured only the first line and
  `unquote()` found no closing quote, silently truncating the value and corrupting the line
  that followed. Added `\n` ↔ literal-`\n`-escape handling alongside the backslash/quote
  escaping so a quoted value always stays on one physical line.
- **`pause-check.mjs` read gate titles through its own un-synced copy of `parseLock`/`get`** —
  it never picked up `gate.mjs`'s `unquote()`, so once a title needed quoting its "reopened
  but not re-locked" message printed the raw quoted/escaped form (e.g.
  `gate-4 ("Contract lock: v2 revision")`) instead of the plain title. Added the matching
  `unquote()` to pause-check.mjs.

## [0.3.2] - 2026-07-23

### Fixed

- **`pause-check.mjs` missed host-native dev servers left running** — it only checked
  docker-compose stacks, so a `pnpm dev`/`go run`-style process (exactly the shape this
  same session's deployment-topology ADR made the frontend's normal deploy path) went
  undetected while still bound to its port. Added a per-repo check that looks for any
  running process whose command line references the repo's own absolute path — works
  for any dev command/port convention without needing to know either one. Caught live:
  a `pnpm dev` frontend server was still running on `localhost:3000` after the pipeline
  had already reported "safe to pause."

## [0.3.1] - 2026-07-23

### Fixed

- **`gate.mjs reopen` wrote invalid YAML whenever `--reason` contained a colon** (e.g.
  `"Add ADR-0011: deployment topology..."`) — a very likely shape for a real reason,
  since it broke on the very first real reopen this pipeline did. The hand-rolled writer
  interpolated the raw string as an unquoted YAML plain scalar; a colon-space inside it
  reads as a nested mapping, and `validate.mjs`'s real YAML parser then fails the file.
  `title` and `locked_by` had the same latent bug, just not yet triggered. Added a
  `yamlStr()` helper that conditionally double-quotes (only when a value actually needs
  it, so existing simple values keep round-tripping byte-for-byte) and a matching
  `unquote()` on the read side. Caught by, and fixed via, the linear rebuild project's own
  ADR-0011 gate-3 reopen.

## [0.3.0] - 2026-07-23

### Added

- **Pause-safety check** (`skills/rebuild-pipeline/scripts/pause-check.mjs`, orchestrator
  Step 6 in `SKILL.md`) — a repeatable, advisory readiness check for whether it's safe to
  pause the pipeline and resume in a new session. Reports git-dirty state across the
  workbench and every repo registered in `repos.yaml`, any gate left mid-decision
  (reopened but not re-locked), and docker-compose stacks left running, plus a reminder to
  confirm nothing non-trivial exists only in conversation. Deliberately NOT a sixth
  hash-pinned gate — it locks nothing and has no PreToolUse enforcement, since "is it safe
  to pause" is a live, repeatable question, not an artifact to protect. `repos.yaml`'s
  format is now documented (`name`/`path` entries) in both `rebuild-init.mjs`'s generated
  stub and `g5-build.md`, which now also instructs registering each code repo there as
  it's created — previously the file was generated but never referenced again, so real
  projects were leaving it as an empty stub indefinitely.

## [0.2.1] - 2026-07-19

### Added

- **Checkpoint discipline convention** (`skills/rebuild-pipeline/SKILL.md`) — the orchestrator now proactively writes in-progress, unlocked work (a partial ADR, a draft matrix, in-flight findings) to the workbench as soon as a chunk of non-trivial content only exists in conversation, rather than waiting to be asked. This closes a gap in the pipeline's designed resumability: state detection already trusts the filesystem over chat memory across sessions, but nothing previously obliged mid-phase drafts to actually reach disk before a session ended. Safe by construction — gates protect only *locked* artifacts, so draft files remain freely overwritable.

## [0.2.0] - 2026-07-19

### Added

- **Org-default architecture for G4a** (`skills/rebuild-pipeline/references/architecture-default.md`) — a modular-monolith, API-first playbook (default Go + Nuxt; alternate Fastify + Next.js) now seeds decomposition and most cross-cutting-concern ADRs. This is a scoped, deliberate exception to the pipeline's general "never inject a default" stance: `adr-drafter` and `references/g4a-architecture.md` treat the playbook's answer as the starting proposal, and an ADR is required to *diverge* from it rather than to adopt it (a third `silent-default` value covers concerns the default addresses in general but not a specific sub-question). Coverage is uneven by design, not by oversight: authn/authz, events/queues, storage, files/media, background workers, and observability each cite the exact playbook section that answers them; tenancy, search, and backend/cross-cutting caching have no org-default answer at all and stay fully open, mirror-or-diverge against the reference only, exactly as before this change. A one-time applicability check (the playbook's own "when this does NOT apply" clause) gates the whole mechanism per project. The reference product's own architecture (lane D) stays in the ADR as informational/learning context for concerns with a default, but no longer drives those decisions — a pure tech-stack/language swap forced by the fixed default stack doesn't count as reference-divergence, only an observable behavior/guarantee difference does. The decomposition/stack ADR also now asks the human directly about team-composition facts (stack familiarity) that might favor the Fastify + Next.js alternate, since no other artifact in the pipeline records that. Taxonomy (G2), slicing (G3), and contracts (G4b) are unaffected — still per-product, blank-slate decisions.

### Changed

- **`rebuild-pipeline`'s trigger description now covers license-posture and hook-blocked-edit queries.** Built a 20-query trigger eval set (`skills/rebuild-pipeline/eval/trigger-eval.json`) and ran it through skill-creator's eval loop. The original description already scored 100% recall on the training split, but held-out test queries caught two real gaps: "what's the license posture we recorded for this rebuild..." and "the hook just blocked me editing matrix/features.yaml..." both failed to trigger, since neither license posture (G0) nor the PreToolUse lock-guard hook was named in the description. Added both explicitly — verified 0/3→3/3 and 0/3→1/3 on the held-out queries, no new false triggers on the near-miss no-trigger set.

## [0.1.0] - 2026-07-18

### Added

- **`product-rebuild-skills` plugin** — a gated, agent-orchestrated pipeline for rebuilding an existing product end-to-end to learn the full product development lifecycle. Ships the `rebuild-pipeline` skill (the single interface: detects pipeline state, reports progress, dispatches subagents, stops at gates), the `/rebuild` command, `miner`/`adr-drafter`/`spec-writer` subagents, a PreToolUse hook guarding locked gate artifacts, and `docs/PLAYBOOK.md` covering the full methodology.
- **`.claude-plugin/marketplace.json`** — enables installing via `/plugin marketplace add tammai/product-rebuild-skills` + `/plugin install product-rebuild-skills@product-rebuild-skills`, matching the `tammai/bigin-skills` pattern. README's Install section updated to match.
