---
playbook: mobile-flutter
stack: "Flutter (Dart) client against an existing HTTP API (alternate state layer: BLoC)"
target-shape: client-only
scaffold-profile: "flutter, via bigin-skills:bigin-harness-setup (requires bigin-skills >= 1.68.0)"
not-applicable-when:
  - "the target is a single-screen utility or a marketing shell — the layering below costs more than it returns"
  - "the product is offline-first collaborative (CRDTs, multi-writer merge) — that needs a local-first playbook, not this one"
  - "the API being consumed does not exist yet and is in scope for the same rebuild — use a fullstack playbook and let this one govern the client half later"
concerns:
  decomposition: "§2, §4, §25"
  state-management: "§5"
  navigation: "§5"
  di-composition: "§6"
  api-client: "§7"
  authn-session: "§8"
  local-persistence: "§9"
  offline-sync: "§9"
  background-tasks-push: "§10"
  files-media: "§11"
  design-system: "§12"
  error-contract: "§13"
  observability-crash: "§14"
  localization: "§16"
  secrets-config: "§17"
  platform-integration: "§18"
  platform-floor: "§19"
  store-compliance: "§20"
  release-rollout: "§21"
  on-device-migration: "§22"
  data-modeling: "N/A"
decide-before:
  offline-sync: "local-persistence, api-client"
  on-device-migration: "platform-floor, local-persistence, authn-session"
  authn-session: "api-client"
  release-rollout: "store-compliance, platform-floor"
---

> **How this file is used in `rebuild-pipeline`:** one entry in the playbook registry
> (`references/playbooks/`), selected per project by `sources.yaml`'s
> `architecture.playbook`. It supplies G4a's standing answers for the concerns its
> `concerns:` map points at sections of; a concern mapped `N/A` has no default and is
> decided the pipeline's original way — mirror-or-diverge against the reference only. An
> ADR is required to **diverge** from a default, not to adopt one. G4a vendors this file
> into the workbench at `adr/playbook.md`, where Gate 3 hashes it: renumbering a section
> after a lock re-points accepted ADRs at different content, so edit the `concerns:` map
> and the section bodies together or not at all.
>
> **Repo creation is the normal path, and §3 still owes the native half.**
> `bigin-skills` >= 1.68.0 ships a working `flutter` profile, so G5 creates the repo the same way it
> creates every other one: `bigin-harness-setup` from an empty directory, whose Phase 0.5
> delegates to `flutter create` and which then installs the harness, both lint commands, CI,
> and the pre-commit gate. Earlier versions of `bigin-skills` have no such profile — on those,
> G5 falls back to the stack's own scaffolder plus the stack-neutral `generic` harness, and the
> CI and conventions this playbook describes must be written by hand (`g5-build.md` step 0).
> Either way §3 and §26 keep the **native** setup detail — Xcode schemes, Android
> `productFlavors`, per-flavor Firebase files — because no scaffold generates that.
>
> **Every "the lint catches this" claim below has been checked against the actual rule
> sets.** Where no tool enforces a rule, it says so and names what would have to be written.
> A hard rule that cites tooling which does not exist is worse than a rule that admits it is
> review discipline, because only one of the two gets noticed when it is skipped.

---

# Playbook: Flutter Client Against an Existing API
### Default: Riverpod + go_router + Drift + generated dio client · Alternate state layer: BLoC

> Default architecture reference for rebuilding a mobile client whose backend stays where
> it is. The API is an input, not a decision: it was mined at G1 and frozen at Gate 4. What
> this playbook decides is everything on the device — how the app is decomposed, where
> state lives, what persists, and how a build reaches a user.

---

## 1. Core Philosophy

**Central principle:** a client app's complexity is not its screens, it is the number of
places that can hold the same fact. Every architectural rule below exists to keep one fact
in one place: on the server, in the local store, or in a widget's build method — never in
two of them with no stated precedence.

**Three foundational decisions:**

1. **The server API is a fixed boundary, and the app never negotiates with it.** No
   endpoint is invented on the client, no response is "fixed up" in a widget. The
   generated client (§7) is the only code that knows the wire format; a mismatch between
   what the app needs and what the API gives is a Gate 4 conversation, not a workaround.
2. **Feature-first decomposition, three layers inside each feature.** Presentation,
   domain, data — per feature, not app-wide. An app-wide `models/` directory is the
   failure mode this replaces: it is where the previous app's coupling lived, and it will
   be where this one's lives if it is recreated.
3. **One object graph, one navigator, one store.** Two state-management libraries, two DI
   mechanisms, or a second navigation stack are each an architecture decision that must be
   an ADR — because each doubles the number of places a fact can hide.

**What a client rebuild adds that a greenfield app does not have:** an existing install
base with data on their devices, and a floor below which those devices cannot follow you.
§19 and §22 are not appendices — for a rebuild shipping under the same bundle ID they carry
the only decisions in this playbook that cannot be rolled back per user, and the only one
that permanently strands users on the app you are replacing.

**Two framings this playbook deliberately corrects, because both are comforting and false:**

- "One shot per user." Only for users who *receive* the update. §19's platform floor and
  §22's export-then-import case both produce populations for whom the migration is two
  shots or none.
- "A release cannot be recalled, so that is simply the constraint." True for stock Flutter,
  and the app being replaced could very likely hotfix (§21). Losing that is a regression
  against the product being replaced, which makes it a decision, not a law.

---

## 2. Overall Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  presentation   widgets, screens, controllers (Riverpod)     │  per feature
├──────────────────────────────────────────────────────────────┤
│  domain         entities, use cases, repository interfaces   │  per feature
├──────────────────────────────────────────────────────────────┤
│  data           repository impls, DTO↔entity mappers,        │  per feature
│                 generated API client calls, Drift DAOs       │
└──────────────────────────────────────────────────────────────┘
        │                                    │
        ▼                                    ▼
   core/ (design system, error contract, network, storage, l10n, logging)
        │                                    │
        ▼                                    ▼
   generated API client  ────────────►  existing backend (frozen contract)
   Drift database        ────────────►  device
```

**Dependency direction is one-way and enforced (§4.3):** `presentation → domain ← data`.
Presentation depends on domain; **`data` depends on domain too, and domain on neither** — it
declares the repository interface that `data` implements, which is what lets §4.3 forbid
`features/*/domain/**` from importing `**/data/**` at all. Read the layer diagram above as a
stack of *locations*, not as a chain of dependencies: the arrows point inward to `domain`.

`core/` may be imported by any layer; `core/` imports no feature.

**One app, one process, no plugins-as-architecture.** Platform channels are a data source
like any other (§10, §18), owned by a feature's `data` layer, never called from a widget.

---

## 3. Repository Setup

One repo for the app. Structure:

```
lib/
  main_dev.dart  main_staging.dart  main_prod.dart   # thin entrypoints, flavor only
  app.dart                                          # root widget + router wiring
  core/
    design/     theme, tokens, shared widgets        # §12
    error/      Failure sealed class, mappers        # §13
    network/    dio setup, interceptors, auth        # §7, §8
    storage/    Drift database, secure storage       # §9
    l10n/       ARB catalogs + generated delegates   # §16
    logging/    logger + crash reporter facade       # §14
  features/
    <feature>/
      presentation/  domain/  data/
api/
  openapi.yaml -> ../workbench/contracts/openapi/…   # the frozen contract, by symlink or copy
  generated/                                         # generated client, committed
test/  integration_test/
```

**Flavors, not environments-at-runtime.** Three entrypoints, three bundle IDs
(`com.acme.app.dev`, `.staging`, plain for prod), configuration via
`--dart-define-from-file=config/dev.json`. **Hard rule: no API base URL literal appears
anywhere in `lib/`** — it comes from the flavor config or the build fails. A hardcoded
staging URL that ships to production is the single most common release incident in mobile.

**Two things `--dart-define-from-file` does not do, and §3 owes both because there is no
scaffold to delegate them to:**

- **It is not a secrets mechanism.** Values are compiled into the binary and recoverable
  from an IPA/APK. Correct for base URLs; wrong for anything else — see §17.
- **It does not produce three bundle IDs.** Those need Xcode build configurations and
  schemes, Android `productFlavors`, and per-flavor entitlements, URL schemes, App Group
  IDs and `google-services.json` / `GoogleService-Info.plist` files (§10, §22). Budget the
  native half explicitly; it is a day of work per platform and it is where a flavor setup
  silently half-exists.

**CI** (added to whatever `bigin-harness-setup` wrote, one file, not a second workflow):

```sh
dart format --output=none --set-exit-if-changed .   # --output=none or it REWRITES the tree
flutter analyze --fatal-infos                       # needs the analyzer exclude below
dart run custom_lint            # riverpod_lint + any hand-written rules (§4.3, §5, §12)
dart run import_lint            # the layer/feature import boundaries (§4.3) — SEPARATE tool
flutter test
flutter test integration_test
dart run build_runner build --delete-conflicting-outputs && git diff --exit-code
```

**`--output=none` is not optional in a gate.** Plain `dart format --set-exit-if-changed .`
*reformats every unformatted file it finds* and then exits 1 — the flag controls the exit
code, not whether it writes. In a pre-commit hook that means the commit silently reformats
files nobody staged, leaves the staged snapshot unformatted, and lands a commit that differs
from the one the gate checked. `--output=none` makes it a pure check with the same exit code.
Use the bare form only when you actually want the rewrite.

**`--fatal-infos` needs generated code excluded from the analyzer, or the gate is red on day
one with no legal fix.** It promotes analyzer infos to failures, and generated output reliably
produces them: `freezed` emits `non_nullable_equals_parameter` per union, and output written
against an older SDK carries `deprecated_member_use`. That code is committed, CI-diffed and
never hand-edited, so add an `analyzer: exclude:` block — `**/*.g.dart`, `**/*.freezed.dart`,
`**/*.gr.dart`, `api/generated/**` — **merged** into whatever `analysis_options.yaml` already
exists, never overwriting it. Exclude rather than downgrade the severities: a real problem in
generated code is a generator-version or contract problem, and the regenerate-and-diff step is
what catches that.

**`dart run custom_lint` does not run the import boundaries.** `import_lint` is a
standalone analyzer plugin on Dart's first-party `plugins:` mechanism with its own CLI;
`custom_lint` is a separate, older mechanism that `riverpod_lint` is built on. The project
needs **both commands**, and running both plugin mechanisms side by side is a decision to
make deliberately (§4.3) rather than an assumption. **`import_lint` requires Dart 3.10+ /
Flutter 3.38+, and below that floor nothing enforces the boundaries at all** — not a weaker
check, none. On an older SDK the gate must skip it *by name* so the absence is visible, and
§4.3's rules are review discipline until the SDK moves. That is also the strongest argument
for §4.3 option 1, which needs no plugin.

**Committed generated code must match its source** — the same rule the web playbook applies
to its OpenAPI codegen, and the reason the `build_runner` + `git diff --exit-code` step is
there. That gate is only meaningful if the inputs are pinned: commit `pubspec.lock`, pin
generator packages to exact versions, and pin the openapi-generator JAR or Docker tag (§7).
**Make the step skip itself with a named message while any generator is on a caret range —
not fail.** Essentially every existing Flutter repo carries caret ranges, so a hard
precondition turns the workflow red on the first push, which is the same day-one death the
conditional lint steps exist to avoid. The gate then activates on its own once the pins are
exact.

---

## 4. Feature Modules

### 4.1 Directory Structure (per feature)

```
features/orders/
  domain/
    order.dart                 # entity — no json, no dio, no drift
    order_repository.dart      # abstract interface, domain types only
    cancel_order.dart          # use case, if the logic outgrows the controller
  data/
    order_repository_impl.dart # implements the interface
    order_dto_mapper.dart      # generated DTO ↔ entity, where the shapes differ (4.2)
    order_dao.dart             # Drift DAO for this feature's tables
  presentation/
    orders_screen.dart
    order_list_controller.dart # Riverpod Notifier — no dio, no dao
    widgets/
```

### 4.2 Hard Rules for Feature Boundaries

1. **A feature never imports another feature's `data/` or `presentation/`.** Cross-feature
   need is satisfied through the other feature's `domain/` interface, exposed as a
   provider. If two features share an entity, it moves to `core/` — a decision worth an
   ADR, because a shared entity is a shared reason to change.
2. **`domain/` imports nothing generated.** No `*.g.dart`, no API DTOs, no Drift rows.
   This is the rule whose absence makes an API change a whole-app refactor, which is what
   the previous app suffered from. Enforced per §4.3.
3. **A DTO↔entity seam where the shapes differ — not reflexively everywhere.** Mandatory
   when the wire shape and the UI shape actually diverge: date/time and enum parsing,
   nullable-vs-required mismatches, nested payloads a screen wants flattened, or an entity
   that carries computed or locally-authored state (§9). Where a resource is a flat value
   object the UI uses verbatim, using the generated type in `domain/` is a *stated*
   exception, recorded once in this ADR rather than argued per feature.
   **Why this is not the usual "always map" rule:** that rule buys insulation against the
   contract changing, and this playbook's premise is a contract that is frozen at Gate 4 and
   owned by someone else. Paying two models, a bidirectional mapper and mapper tests for
   every resource in a whole-app rebuild, to insulate against the one thing declared fixed,
   is the trade going the wrong way. If the API is in fact expected to move (a backend
   rewrite is queued, a v2 is announced), that is a concrete reason to take the stricter
   rule — and an ADR that says so.
4. **No widget reads a DAO or a generated client.** Presentation talks to controllers,
   controllers talk to repository interfaces.
5. **One feature owns each table.** A DAO reaching into another feature's tables is the
   same violation as a cross-module SQL write on the backend — go through the owning
   feature's repository.

### 4.3 Enforcing the Boundary

Dart gives you three mechanisms with genuinely different strength. Pick deliberately; the
default below is the middle one, and the strongest is available if the boundary matters more
than the restructuring cost.

1. **Resolver-enforced (strongest).** Split features into separate Dart packages in a
   `melos`/pub workspace. A package cannot import what is not in its `pubspec.yaml` — no
   lint involved, no opt-out — and the first-party `implementation_imports` lint blocks
   reaching into another package's `lib/src/`. This is materially stronger than lint, and
   close to the compiler-enforced boundary the org-default Go backend gets. It costs a
   `pubspec.yaml` per feature, slower codegen, and a real restructuring effort. **Worth an
   ADR either way** — do not skip it on the assumption that Dart cannot do this.
2. **Lint-enforced, merge-blocking (the default).** `import_lint` rules in
   `analysis_options.yaml` under the `plugins:` section, run in CI as `dart run import_lint`
   (§3):
   - `features/*/domain/**` may not import `**/data/**`, `**.g.dart`, `package:dio`,
     `package:drift`, or `api/generated/**`.
   - `features/A/**` may not import `features/B/data/**` or `features/B/presentation/**`.
   - `core/**` may not import `features/**`.
3. **Not expressible as an import rule at all.** "No `http(s)://` literal in `lib/`" is a
   *string-literal* rule; `import_lint` matches glob patterns against import paths. Use a
   hand-written `custom_lint` rule or a `grep` step in CI. And the correct rule is **nowhere
   in `lib/`, including `core/network/`** — per §3 the base URL comes from the flavor config,
   so `core/network/` is not an exemption, it is just the place the value is *read*.

**Two things to state as accepted risk rather than leave implicit:** `import_lint` is a
small package (low likes/downloads) carrying the project's central structural invariant, and
option 2 runs a `plugins:`-mechanism plugin alongside `custom_lint`, which the Riverpod
default (§5) pins. If either is unacceptable, option 1 removes the dependency entirely.

---

## 5. State Management & Navigation

**Default: Riverpod** (`@riverpod` codegen), with `Notifier`/`AsyncNotifier` per screen or
per coherent piece of state. **Alternate: BLoC**, when the team already ships BLoC and the
familiarity argument beats the uniformity argument — a legitimate `diverge-from-default`
with a team-composition rationale, exactly like the web playbook's Fastify/Next alternate.

Hard rules, whichever is chosen:

1. **`StatefulWidget` state is for ephemeral UI only** — animation controllers, text
   controllers, scroll offsets. Anything a second screen could care about lives in a
   provider.
2. **No `setState` after an `await` without a mount check**, and no business `await` in a
   widget at all — that is the controller's job.
3. **State is a sealed/immutable type, not a bag of nullables.** `AsyncValue` (or a sealed
   `Loading|Data|Failure`) rather than `isLoading` + `data` + `error` fields that can
   express three impossible combinations.
4. **`ref.watch` in `build`, `ref.read` in callbacks.** **No lint enforces this** —
   `riverpod_lint` has no such rule, and `avoid_ref_inside_state_dispose` is a different
   situation. It is the most useful Riverpod rule in this file and it is review discipline
   until someone writes the `custom_lint` rule. Writing it is a good first use of the
   `custom_lint` mechanism §4.3 already pins.

**Navigation: `go_router`**, declarative route table in one file, typed routes via codegen.
- Auth guarding is a `redirect` on the router driven by the session provider (§8) — never
  an `if (!loggedIn) Navigator.push` scattered in screens.
- Deep links are route table entries. **For a rebuild this is parity surface**: every URL
  scheme, universal link and push-notification payload the previous app resolved must
  appear in the matrix at G2 and in this table, or existing users' links break silently on
  upgrade. Nobody reports a dead deep link; they just stop using it. Android App Links
  additionally depend on the signing certificate — see §22's preconditions.
- No nested `Navigator` unless a shell route genuinely needs a second stack (a tab that
  keeps its own history). If one is added, it is an ADR — two stacks is two sources of
  truth for "where am I".
- A WebView-hosted flow is a third navigation surface with its own history. §18 decides who
  owns it; do not let it appear by accident inside a route.

---

## 6. Dependency Injection / Composition Root

**Riverpod providers are the object graph. There is no `get_it`, no service locator, no
singleton with a static `instance`.** One mechanism.

- Every dependency is a provider; every provider is overridable in tests
  (`ProviderScope(overrides: [...])`).
- The composition root is `app.dart` plus the flavor entrypoint. Nothing else constructs a
  `Dio`, a `Database`, or a repository implementation.
- Providers that hold platform resources (database, secure storage) are declared in `core/`
  and kept alive; feature providers are auto-disposed by default. A long-lived feature
  provider is a decision to state, because it is a cache with no eviction policy otherwise.
- **The UI object graph does not exist in a background isolate** (§10). Code that runs in
  both places takes its dependencies as parameters rather than reading them from a
  container.

If BLoC is chosen for state (§5), DI still runs through Riverpod (or a single `Provider`
tree) — the alternate swaps the state layer, not the object graph.

---

## 7. The API Client: Generated From the Frozen Contract

**The contract is `contracts/openapi/*.yaml` in the workbench, locked at Gate 4. It
describes an API this project does not own.** For a client-only rebuild the contract was
*transcribed* from the existing backend (see `g4b-contracts.md`) — it is ground truth, not
a design. `contracts/openapi/requested.yaml`, if it exists, is a request to another team and
is **not** an input to codegen.

- **Generate, never hand-write.** `openapi-generator` (dart-dio) or
  `swagger_dart_code_generator` into `api/generated/`, committed, CI-diffed (§3).
- **Pin the generator.** An exact JAR version or Docker tag, plus `pubspec.lock` and exact
  constraints on `build_runner`/`json_serializable`. The regenerate-and-diff gate is only
  meaningful if regeneration is deterministic.
- **One `Dio` instance**, configured in `core/network/`, with interceptors in a stated
  order: logging → auth (§8) → retry → error mapping (§13). Order is part of the decision;
  a retry that runs before token refresh retries a 401 four times and then fails.
- **Timeouts are explicit** (connect, receive, send) and come from flavor config. A default
  infinite receive timeout is how a mobile app hangs on a captive-portal Wi-Fi.
- **No repository returns a generated DTO** where §4.2 rule 3 requires a seam.
- **A response the app needs but the API does not provide is a Gate 4 finding**, recorded
  as such — not an extra request in a loop, not a client-side join across three endpoints
  that pretends to be one. Two of those in a row is the signal that the backend belongs in
  scope, which is a G0 reopen, not a client workaround.

---

## 8. Auth & Session

- **Tokens live in `flutter_secure_storage`** (Keychain / Android Keystore-backed), never
  in `SharedPreferences`, never in the Drift database, never in a provider that gets logged.
  Two settings its own README mandates and every rebuild forgets: `android:allowBackup="false"`
  (or an equivalent backup rule) and `android:fullBackupContent` handling — because the
  Keystore master key is device-bound and **not** restored from backup, so backed-up
  ciphertext restores as undecryptable garbage on a new device. See §22 rule 3.
- **Refresh is one interceptor, serialized.** Use dio's **`QueuedInterceptor`** rather than
  a hand-rolled mutex: plain `Interceptor`s run concurrently across requests, so ordering
  alone serializes nothing, and hand-rolled `Completer` gates are where the deadlocks live.
  Concurrent 401s must produce one refresh call and a queue of retries — the losing races
  invalidate the winner's token on any backend that rotates refresh tokens with reuse
  detection, which logs users out at random and is nearly unreproducible.
- **A session provider is the single source of truth** for "logged in", and the router
  redirect (§5) is its only consumer for navigation.
- **Federated identity is part of this decision, not a detail.** If the previous app used
  Google, Apple or another provider: the Google OAuth client is bound to the signing SHA-1
  and bundle ID, Apple's stable user identifier is scoped to team + bundle ID, and changing
  the provider client, the team, or the bundle ID silently orphans those accounts with no
  in-app recovery path. This is where §22's "preserve the session" actually breaks. Decide
  and record it here.
- **Logout wipes secure storage *and* the local database *and* the image cache.** A rebuild
  is the moment to get this right: user-scoped rows surviving a logout is the bug class
  that leaks one user's data to the next on a shared device. §22 rule 4 extends this to a
  post-migration login by a *different* user.
- **Biometric re-auth, if the previous app had it, is parity surface** — matrix it at G2.
  Its absence is silent to everyone except the users who relied on it.

---

## 9. Local Persistence & Offline Policy

**Default local store: Drift (SQLite)** — typed queries, real migrations, testable without
a device. `flutter_secure_storage` for secrets (§8). `SharedPreferences` for genuinely
trivial user preferences only. **Alternate: a pure KV store**, and note the shape of that
option honestly — Hive and Isar have both been effectively unmaintained for years, so a KV
alternate today means a maintained option (`sembast`, `shared_preferences`, or Drift used as
KV) rather than the two names everyone reaches for. Choosing an unmaintained store is an ADR
with a stated migration exit.

- **Location matters: three directories, not two** (§11). The Drift database belongs in
  `getApplicationSupportDirectory()` — app-private, backed up, not user-visible — not in
  Documents (where iOS may expose it if file sharing is ever enabled) and not in Caches
  (which the OS may delete).
- **Drift migrations are versioned and tested**, `schemaVersion` bumped with a migration
  step and a migration test per step. An app that crashes on launch after an upgrade cannot
  be fixed by a hotfix unless §21's OTA decision provided one — otherwise the user has to
  reinstall, and reinstalling loses their data.
- **`contracts/data-model/` describes THIS store**, not the server's schema. It is the
  local shape: what is cached, what is user-authored-but-unsent, what is derived. The
  server's schema is `findings/ground-truth/reference-erd.<name>-api.mermaid`, mined and
  descriptive; the previous client's local store is
  `reference-erd.<name>-local.mermaid` and is the actual starting draft. Keep all three
  apart — that is why `data-modeling` is `N/A` in this playbook's concerns map: the local
  shape is a per-product decision, not something a playbook can default.

**Offline policy is per feature, declared, never emergent.** Pick one of three per feature
and write it in the feature's spec at G5:

1. **Online-only** — no local copy; a network failure is a visible error state. The default
   for anything transactional. Cheapest, and correct more often than teams admit.
2. **Read-through cache with staleness** — local copy is a cache with an explicit TTL and a
   visible "last updated" affordance. Writes still require connectivity.
3. **Offline-first with an outbox** — local writes queue in an outbox table, a single
   serialized worker drains it, conflicts resolve by a stated rule (last-write-wins,
   server-wins, or manual). This is the expensive one: it needs idempotency keys the API
   must actually support (§7 — check the contract, do not assume) and a UI that can show
   "not yet synced".

**Hard rule: no feature gets option 3 by accident.** An outbox that appeared because
someone cached a write is a data-loss bug with a queue in front of it. And **an offline
policy the previous app had is parity surface** — if the old app let users work on a plane,
shipping option 1 is a regression your users will report as "the new app is broken".

---

## 10. Background Work, Push, and Isolates

- **Push: FCM (+ APNs) via `firebase_messaging`**, or the previous app's provider. Two facts
  that belong in the ADR, not in a G5 ticket: every stored device token dies if the Firebase
  project or sender ID changes — **and then there is no push channel left with which to tell
  users to update** — and per-flavor Firebase config files are part of §3's native half.
- **Notification permission survives a same-bundle-ID update on both platforms, so do not
  re-prompt.** An iOS re-prompt after a prior grant is at best a no-op, and a fresh denial is
  unrecoverable in-app. The FCM *token* must be re-registered on first launch and the server
  must expire the old one (§22).
- **Notification payload handling is a route resolution** (§5), not a screen constructor
  call. Cold start, background, and foreground are three different entry paths and all
  three must land on the same route table.
- **Periodic/background tasks: `workmanager`** (or platform-native), and **hard rule: a
  background isolate shares no memory with the UI isolate.** It gets its own database
  handle, its own Dio, its own logger. Reaching for a Riverpod provider from a background
  callback is **not** a rare device-dependent flake — the background isolate has no
  `ProviderContainer` at all, so it fails deterministically, everywhere, on the first run.
  What *is* environment-dependent is the plugin path: a background isolate must call
  `DartPluginRegistrant.ensureInitialized()` and, to use plugins,
  `BackgroundIsolateBinaryMessenger.ensureInitialized(rootIsolateToken)`, or platform
  channels throw.
- **Assume the OS may never run it.** iOS background execution is a suggestion
  (BGTaskScheduler is opportunistic), and on Android OEM battery managers drop scheduled
  jobs outright — this is not an iOS-only caveat. Any correctness that depends on a
  background task firing is wrong; use it for opportunistic work (prefetch, outbox drain)
  and make the foreground path complete on its own.

---

## 11. Files & Media

- **Three directories with different guarantees**, and choosing between them is deliberate:
  *temporary/cache* (`getTemporaryDirectory()` / `getApplicationCacheDirectory()`) — the OS
  may delete it at any time, so re-downloadable content only; *application support*
  (`getApplicationSupportDirectory()`) — app-private persisted state, backed up, the home for
  the local database (§9); *documents* (`getApplicationDocumentsDirectory()`) — user-authored,
  user-visible content, backed up. Putting app state in Documents is the common mistake and
  it has an App Review consequence.
- **`cached_network_image` for remote images**, with an explicit cache size and eviction
  policy. Its default cache lives under the OS cache directory and is bounded by a default
  the app should set on purpose; unbounded image caching is the most common cause of "the app
  uses 3 GB".
- **Uploads go through the repository layer** with progress exposed as state, and resume on
  failure only if the API supports it (§7).
- **Every user-visible file the previous app wrote to disk is migration surface** (§22):
  drafts, downloads, offline attachments.

---

## 12. Design System & Presentation Layer

- **`core/design/` owns tokens** — colors, spacing, radii, type scale — as a Material 3
  `ThemeExtension`. **Hard rule: no widget contains a raw hex color, a magic padding
  number, or a raw `TextStyle`.**
  **No off-the-shelf lint enforces this**: `flutter_lints` has nothing for magic numbers or
  inline `TextStyle`, raw hex is grep-able but the rest is not, and the commercial analyzers
  cover only part. So this is either a hand-written `custom_lint` rule — worth writing,
  because §12's whole argument is that this rule is what keeps a rebuild from drifting back
  into the inconsistency it was rebuilt to fix — or an explicit review rule. It must not be
  claimed as tooling it does not have.
- **Shared widgets live in `core/design/widgets/`**; a widget used by exactly one feature
  stays in that feature. Promotion to `core/` is a decision, not a habit.
- **Golden tests for the shared widget set**, in light and dark, at the two extreme text
  scale factors — with §15's CI constraints, which decide whether the suite survives
  contact with a second machine. Accessibility text scaling is where rebuilt UIs break
  first and where nobody looks.
- **Screens are dumb.** A screen builds from a single state object (§5 rule 3) and calls
  controller methods. Logic in `build` is the thing that made the previous app untestable.

---

## 13. Error Contract

One sealed `Failure` type in `core/error/`, mapped from three sources: the API's error
shape (per the frozen contract), Dio/transport errors, and local (storage, permission,
platform) errors.

- **Nothing above `data/` ever sees a `DioException`.** Mapping happens in the interceptor
  or the repository, once.
- **Every `Failure` carries a user-presentable message and a stable code**; the UI switches
  on the type, never on a string match against a message.
- **Three cases must be distinct because the UI must behave differently:** offline,
  unauthenticated (→ session provider, §8), and everything else. Collapsing offline into a
  generic error is how an app tells a user on a subway that "something went wrong".
- **Two consequences of dio's interceptor model that look like an ordering bug and are not**
  (verified against `dio_mixin.dart`'s forward iteration over `interceptors`):
  an error *resolved* by an earlier interceptor never reaches later error interceptors — the
  desired refresh behaviour, but error-mapping then never sees a refreshed-and-retried
  request that fails again unless the auth interceptor re-throws; and a `Response`
  synthesized in the **error** phase does **not** re-run the response phase, so a response
  interceptor that unwraps or decorates successful responses silently misses **every retried
  request**. If any unwrapping happens in an interceptor, it must also happen on the retry
  path, or it belongs in the repository instead.
- **Unexpected errors are reported (§14) *and* shown.** A silent catch is worse than a
  crash: the crash at least appears in a dashboard.

---

## 14. Observability & Crash Reporting

- **Crash + error reporting: Sentry** (or Crashlytics), initialized in the flavor
  entrypoint before `runApp`, with **release symbol/dSYM upload wired into CI** — an
  obfuscated release stack trace is worth nothing, and this is only ever discovered after
  the first production crash. Verify by reading one real symbolicated trace, not by the
  upload step exiting 0.
- **Structured logging through a `core/logging/` facade**, never `print`. Debug builds log
  to console; release builds log breadcrumbs to the crash reporter and nothing else.
- **Hard rule: tokens, request bodies with credentials, and PII never reach a log or a
  breadcrumb.** A logging interceptor with a redaction list, reviewed when the contract
  changes. Note the §7 order puts logging first, which means the logged request is not
  quite the request that was sent (no `Authorization` header) — correct for redaction,
  mildly confusing when debugging, worth knowing.
- **The SLO is crash-free sessions** (and ANR rate on Android), watched per release with
  the rollout (§21). "Is it up" for a client is "is this version crashing" — and a client
  cannot be rolled back the way a server can.
- **Migration telemetry is not optional** (§22 rule 6) and belongs in the same dashboard as
  the rollout.
- Screen/flow analytics parity: events the previous app emitted are matrix surface at G2 if
  anyone downstream depends on them (they usually do, and nobody remembers until a
  dashboard goes flat).

---

## 15. Testing Strategy

| Layer | What | Where |
|---|---|---|
| Domain | use cases, mappers, pure logic | `flutter test`, no device |
| Data | repository impls against a fake API client + in-memory Drift | `flutter test` |
| Presentation | controllers with overridden providers; widget tests per screen | `flutter test` |
| Design system | golden tests, light/dark × text scale | `flutter test`, pinned platform |
| Flows | `integration_test` on a real device/simulator, one per acceptance criterion | CI + local |

- **Goldens need one pinned platform or they are useless.** They are font- and
  platform-sensitive, so they must run on a single pinned CI image (or shard per platform)
  and be regenerated there — otherwise they fail on every machine that is not the author's
  and get deleted within a fortnight. `golden_toolkit` is no longer maintained; use
  `alchemist` or plain `matchesGoldenFile` on a pinned image. This constraint, not the
  assertion count, decides whether §12's golden suite exists in six months.
- **Migration tests are mandatory** for every Drift `schemaVersion` step (§9) and for the
  §22 legacy migration, including the interrupted-and-resumed case.
- **G5's rule holds here: each acceptance criterion maps 1:1 to one integration test.** The
  previous app is the arbiter when behavior is ambiguous — run it, do not guess.
- No mocking of the generated client's HTTP layer with string fixtures pasted from a
  browser; fixtures come from the contract's examples so they break when the contract does.

---

## 16. Localization & Formatting

Absent from a first draft of this playbook, which is exactly how a whole category of parity
surface goes undecided. The previous app carries i18next or JSON catalogs; Flutter's standing
answer is **ARB files + `gen-l10n` + `intl`**, with `MaterialLocalizations` wired in `app.dart`.

- **Every user-visible string is parity surface**, and so are plural and gender rules,
  date/number/currency formatting, and RTL layout if any supported locale needs it. A
  rebuild that ships one locale for a product that had four has cut scope, not simplified.
- **The catalog is migrated, not retyped.** The old app's catalogs are lane-D evidence;
  convert them to ARB mechanically and diff the key sets, or you will discover missing
  strings one screen at a time in QA.
- **Locale resolution and per-user locale override** are decisions: device locale only, or a
  stored preference the user can change (which is then §9 state and, if it existed before,
  §22 migration surface).
- **This couples to §12.** Goldens multiply by locale, and RTL doubles the layout surface —
  decide which locales are golden-tested rather than discovering the combinatorics in CI.

---

## 17. Secrets & Config at Rest

The web playbook has a secrets section; this one needs its own because the constraints on a
device are different and worse.

- **`--dart-define` is configuration, not secrecy.** Every value compiled in is recoverable
  from the shipped binary. Base URLs, flavor names, feature-flag defaults: fine. API keys
  that grant anything, signing secrets, anything whose disclosure matters: not fine.
- **The correct home for a real secret is the server.** If the client must hold a
  credential, it is a per-user token obtained at runtime and stored per §8 — not a build-time
  constant. If a third-party SDK requires a client key, treat it as public and scope it
  server-side (referrer/bundle restrictions, per-key quotas).
- **Signing material and store credentials live in CI secrets**, never in the repo, with the
  expiry dates recorded somewhere a human reads before they lapse (§20).
- **Config that changes without a release is a remote-config decision** and overlaps §21's
  kill switch — decide once, in one mechanism, rather than growing a second one later.

---

## 18. Platform Integration: Permissions, WebViews, Purchases

- **Permissions are re-declared from scratch, and a missing declaration is a hard crash.**
  Grants survive a same-bundle-ID update, but the new plugin set changes which usage
  descriptions and manifest entries are needed: an iOS `Info.plist` missing a usage string
  crashes on first use of that API, and Android's runtime-permission list must match the
  manifest. `permission_handler` is the standing answer for the request flow. Enumerate the
  previous app's permission set as lane-D evidence — it also feeds §20.
- **WebView-hosted screens are a boundary, not a widget.** RN apps routinely wrap payment
  flows, help centres and legacy screens. Decide: whether the dio session is shared into
  `webview_flutter`'s cookie store (and if so, how logout clears it — §8), who owns redirect
  and deep-link handling out of the WebView, and how the session provider stays the single
  source of truth across that boundary. This is precisely the "two places that can hold the
  same fact" §1 is about.
- **In-app purchases and entitlements**, if the previous app sold anything: receipts and
  entitlement state are store-side, restore-purchases behaviour is migration surface, and
  getting it wrong has a billing consequence rather than a UX one. Decide whether
  entitlement truth is the store, your server, or both with a stated precedence.
- **Widgets, share extensions and watch apps** live in App Group / shared containers. If the
  previous app had any, the group ID is migration surface (§22).

---

## 19. Platform Floor & Install-Base Cut

**The single most consequential fact a Flutter rebuild of an older app must establish, and
the one most likely to be discovered late.** Flutter's supported floor is **iOS 15** and
**Android API 24**. An app supporting iOS 12–14 or API 21–23 has users who **cannot receive
this update at all**.

- **Measure the cut before Gate 3 closes.** The install base by OS version is a lane-B/G1
  input; the answer is a percentage of real users, not an opinion.
- **Those users are not "on the old version for a while" — they are frozen permanently.**
  The previous app's release must stay published and, if its backend contract ever moves,
  supported. §22's "one shot per user" does not describe them at all.
- **It constrains §21 and §22.** Forced upgrade cannot be enforced against a user who cannot
  install the new build; the migration's population is "users above the floor" and the
  telemetry denominators must say so.
- **Record the decision explicitly**: accept the cut (with the number), keep the old app
  alive for the remainder (with who maintains it), or — if the cut is unacceptable — that
  this playbook does not apply and the rebuild needs a framework that reaches lower.

---

## 20. Store Compliance

Both stores will reject a first upload for reasons that have nothing to do with the code,
and a rebuild cannot inherit the previous app's answers because it changes the entire SDK set.

- **Apple privacy manifests (`PrivacyInfo.xcprivacy`).** Required-reason API declarations
  have been required for App Store submission since 1 May 2024, and each bundled SDK needs
  its own or the upload is rejected (`ITMS-91055`). Every plugin this playbook adds — crash
  reporting, secure storage, path/file access, device info — is in scope. Re-derive the
  manifest from the new dependency set; do not copy the RN app's.
- **Play Data safety** declarations, likewise re-derived, and consistent with what the app
  actually collects (§14's redaction rules are the source of truth for that).
- **Permission usage strings** per §18, and the minimum-OS declaration matching §19.
- **Do this before the first internal build**, not before the first release. It is a
  submission blocker upstream of everything in §21, and it is the step that makes a
  "two-week rollout" into a five-week one when discovered late.

---

## 21. Release, Rollout, Kill Switch & OTA

- **Versioning:** semver `pubspec.yaml` version + monotonic build number, build number
  never reused, and the version string reported to the crash reporter (§14).
- **Staged rollout by default** — Play staged rollout / TestFlight then phased App Store
  release. Halt criteria stated *before* the release goes out (crash-free % floor, error
  rate ceiling), not negotiated while it is rolling.
- **A kill switch and a forced-upgrade path are architecture, not features.** Both need a
  server-side signal: a remote-config flag for a feature gone bad, and a
  minimum-supported-version response the app checks on launch. **For a client-only rebuild
  these are usually the one thing the frozen API does not already provide** — surface that at
  G4b as a required contract addition (`requested.yaml`) rather than discovering it during
  the first bad release. Forced upgrade is also bounded by §19: it cannot reach users below
  the platform floor.
- **The migration needs its own kill switch** (§22). It is the code path that most needs one
  and the only one that tends to ship without.
- **OTA / hotfix is a decision, and the honest framing is that you are losing a capability.**
  Stock Flutter cannot recall or patch a release. The app being replaced very likely could:
  CodePush until App Center shut down in March 2025, expo-updates/EAS Update after.
  **Shorebird** restores Dart-code-only patching (store-guideline-compliant, paid, on a
  modified engine; native and plugin changes still need a store release). Adopt it or accept
  the regression — but record which, because "a release cannot be recalled" is a constraint
  the previous product did not have, and the rollout plan differs completely depending on the
  answer.

---

## 22. On-Device Migration From the Legacy App

**Applies whenever the rebuild ships as an update over the existing install — same bundle
ID / package name.** This is the highest-risk decision in the playbook: it runs once per
user, on a device you cannot inspect, and there is no server-side undo.

**Verify the preconditions before treating "same bundle ID" as given.** The update must ship
from the same App Store Connect app and the same Play listing **signed by the same key** —
Play App Signing makes this automatic, an upload-key change does not, and a different
signing certificate breaks Android App Links (`assetlinks.json` fingerprints, §5) and any
signature-derived state. If the previous app had a widget, share extension or watch app, its
data is in an App Group container and the new app must keep the same group ID or orphan it
(§18).

What is on those devices after the previous app, and **which of it actually needs native
code** — this distinction shrinks the spike from five stores to two:

- **Secrets** in Keychain / Android Keystore, under whatever service and account names the
  old stack used. **Native, and version-dependent**: `react-native-keychain` itself moved its
  Android backing store between releases, so "the old alias" is one answer per version range.
- **Key-value state** — mostly *not* native. `AsyncStorage` on Android is plain SQLite (table
  `RKStorage`), readable with Drift or `sqlite3`; on iOS it is a manifest plus per-key sharded
  files, readable with `dart:io`. **MMKV** has a maintained Flutter package that opens the same
  file given the matching id and crypt key.
  **And Flutter's `SharedPreferences` cannot see legacy keys**: it prefixes every key with
  `flutter.`. Use `SharedPreferences.setPrefix('', allowList: {...})` before first use, or you
  will read an empty store and conclude the data is gone.
- **A local database** — `WatermelonDB` and RN-SQLite are SQLite files Drift opens directly.
  **Realm is the exception and it changes the shape of the plan**: MongoDB's Atlas Device SDKs
  are end-of-support (September 2025) and there is no maintained Dart reader, so a Realm
  legacy app must **export from the RN side** rather than read from the Flutter side.
- **Files** — drafts, downloads, cached attachments (§11).
- **Push registration** tied to the old app instance (§10): re-register the token, do not
  re-prompt for permission.

Hard rules:

1. **Enumerate the (app version × store) matrix, not just the stores, and pick a floor.** The
   install base runs many old versions with different schemas and different libraries. The
   inventory is lane-D evidence plus a real device; a migration designed from memory loses the
   one thing nobody remembered.
2. **Read the legacy stores where you can; export where you cannot.** Only Keychain/Keystore
   and Realm genuinely need native or RN-side work (above). Verify on a device **restored from
   a real backup**, not a fresh install — and know the expected outcome: on Android the
   Keystore master key is device-bound and never backed up, so a restored device holds legacy
   ciphertext it *cannot* decrypt. That is the platform floor, not a bug to fix, and it is why
   §8 mandates `allowBackup="false"` going forward.
3. **Migrate before the first screen that can read migrated data — never on the launch
   path.** Run it on a background isolate, behind a migration UI with progress, with a time
   budget and resumable checkpoints. **Blocking launch is a correctness hazard, not just slow**:
   iOS kills a process that exceeds the ~20-second launch watchdog (`0x8badf00d`) and Android
   shows an ANR, and it happens on exactly the devices carrying the most legacy data — *before*
   rule 5's completion record is written.
4. **The export-then-import case is two shots, not one, and it has a hole.** If a Realm-style
   export must ship in an RN release first, a user who jumps from an older RN build straight to
   the Flutter build **never ran the exporter**. That population must have a defined path:
   native read where possible, otherwise a stated, instrumented, product-approved loss path.
   Do not let the one-shot framing hide them.
5. **Idempotent, resumable, and non-destructive until verified.** One guarded step recording
   its own completion; interrupted halfway (force-quit, OS kill), the next launch resumes
   rather than restarting destructively. Never delete legacy data in the same pass that reads
   it — delete on a *later* launch after a recorded success, or never, if the storage cost is
   trivial next to the risk.
6. **Give the migration a kill switch, and let it suppress deletion independently** (§21).
   Once a broken migration is in the store it is the only lever — and because rule 5 defers
   deletion, a migration that wrongly recorded success will destroy legacy data on relaunch
   unless the deletion pass can be switched off on its own.
7. **Preserve the session if you can, and design the fallback if you cannot.** Silently
   logging out every existing user is a churn event, not a technical detail — and federated
   identity is where this breaks (§8). If tokens cannot be carried over, that consequence goes
   in the ADR's `consequences:`, not in a release note nobody reads.
8. **State who owns the data after a failed session carry-over.** If the post-migration login
   is a **different** user, migrated data is discarded, not merged. On a shared device that is
   the difference between a churn event and a data-leak incident (§8).
9. **Instrument the outcome** (§14): attempted / succeeded / failed-with-reason, plus
   duration, as counters watched during the staged rollout (§21). A migration with no
   telemetry is one whose failure rate you learn from store reviews.
10. **A separate bundle ID changes everything** — a new listing, no data to migrate, no forced
    upgrade, and an install base that must be moved deliberately. That is a legitimate
    alternative to all of the above, and an ADR at Gate 3, not a build setting discovered at G5.

---

## 23. Local Development Environment

- Flutter version pinned via `.fvmrc`/`fvm` or equivalent, committed. "Works on my Flutter"
  is the Dart version of a missing lockfile. `pubspec.lock` is committed too (§3).
- One `make`/`melos` target per routine task: `gen` (build_runner), `lint` (both lint
  commands, §3), `test`, `run-dev`. Codegen runs from a command, never IDE-on-save only.
- Point the dev flavor at whichever backend environment the existing API offers, and record
  in `sources.yaml` which one is safe to write to. A rebuild's integration tests hitting a
  production API is the accident this line prevents.

---

## 24. Anti-patterns to Avoid

- **An app-wide `models/` or `services/` directory.** Recreating the previous app's
  structure in Dart yields the previous app's coupling in Dart.
- **Business logic in `build`**, and its cousin, `await` in a widget.
- **Two state-management libraries**, or Riverpod plus a service locator. One graph.
- **A generated file edited by hand**, or a regenerate-and-diff gate with unpinned
  generators (§3) — the second one teaches the team to ignore the first.
- **Claiming a lint that does not exist.** §5 rule 4 and §12's tokens are review rules or
  hand-written `custom_lint` rules; saying "lint catches it" is how a hard rule quietly
  becomes unenforced.
- **Silent catches** and `catch (_) {}`. See §13.
- **A cache with no eviction policy** — images (§11), API responses (§9), or a long-lived
  provider that is a cache nobody called a cache (§6).
- **`SharedPreferences` for tokens.** It is a plaintext plist / XML file.
- **App state in the Documents directory** (§11), and the local database anywhere but
  application support (§9).
- **Ignoring text scale, dark mode and locale until QA.** Goldens, §12 and §16.
- **Treating the frozen contract as advisory** — client-side joins and N+1 request loops
  that paper over a missing endpoint instead of recording it (§7).
- **A migration on the launch path** (§22 rule 3), **written from memory** (rule 1), or
  **with no telemetry** (rule 9).
- **Assuming the whole install base can follow you** (§19).
- **Feature-flagging the rebuild inside the old app.** Two architectures in one binary
  costs more than shipping the rebuild behind a staged rollout.

---

## 25. Default vs Alternate Stack

| Concern | Default | Alternate, and when |
|---|---|---|
| State | Riverpod (`@riverpod`) | BLoC — team already ships it; team-composition rationale in the ADR |
| Navigation | `go_router` + typed routes | none; a second nav stack needs its own ADR |
| DI | Riverpod providers | none — a service locator alongside is an anti-pattern (§24) |
| API client | `openapi-generator` (dart-dio), pinned and committed | `swagger_dart_code_generator`, if the contract's shape defeats the former |
| Boundary enforcement | `import_lint` in CI (§4.3 option 2) | separate packages in a melos workspace — resolver-enforced, stronger, costlier (option 1) |
| Local store | Drift (SQLite) | a *maintained* KV store, for an app with no relational data — not Hive/Isar |
| Secrets | `flutter_secure_storage` + `allowBackup=false` | platform channel, if the legacy keychain group needs it (§22) |
| Crash/errors | Sentry | Crashlytics, if the org already standardizes on Firebase |
| Push | FCM + APNs | the previous app's provider, if token-loss risk outweighs it (§10) |
| OTA / hotfix | none (accept the regression) | Shorebird, when losing the previous app's hotfix lever is unacceptable (§21) |

Everything in the "Default" column is a `mirror-default` an ADR does not have to argue for.
Everything in the "Alternate" column is a `diverge-from-default` that does — with the
NFR/product-shape fact, the rejected default, and the prior ADR it depends on, per G4a's
depth requirement.

---

## 26. Getting-Started Checklist

1. **Establish the platform floor first** (§19). It is a number about real users and it can
   invalidate the whole plan; everything below assumes it came out acceptable.
2. `bigin-harness-setup` from an empty directory, profile `flutter` — its Phase 0.5 runs
   `flutter create` with the org's package name and it then installs the harness, both lint
   commands and CI (`g5-build.md` step 0). On `bigin-skills` older than 1.68.0 the profile is
   absent or day-one-broken, so scaffold with `flutter create` yourself, run the harness over
   it in `generic` mode, and write the CI from §3 by hand. Older than 1.66.0 there is no
   flutter profile: scaffold with `flutter create` yourself, run the harness over it in
   `generic` mode, and write the CI from §3 by hand.
3. Three flavor entrypoints, three bundle IDs, `config/*.json` per flavor, **plus the native
   half** (Xcode schemes, Android `productFlavors`, per-flavor Firebase files); assert no URL
   literal in `lib/` (§3).
4. `core/` skeleton: design tokens, `Failure`, Dio + `QueuedInterceptor` order, Drift database
   in application support, l10n scaffolding, logging facade.
5. Wire the generated client from the workbench's locked `contracts/openapi/`, **pin the
   generator**, commit `api/generated/`, and add the regenerate-and-diff CI step (§3).
6. `analysis_options.yaml` with the §4.3 boundary rules, **both** lint commands in CI, and a
   deliberate violation committed once to prove they actually fail.
7. Crash reporter + symbol upload (§14), verified by reading one real symbolicated trace —
   before the first internal build, not before the first release.
8. **Store-compliance artifacts** (§20) before the first internal build: privacy manifest
   from the *new* dependency set, data-safety declaration, permission strings.
9. First feature vertically: one screen, one controller, one repository, one DAO, one
   integration test, one golden on the pinned image. That is the template every later feature
   copies.
10. **§22 spike before the first slice that touches session or local data**: on a device
    restored from a real backup, read one legacy keychain item and one legacy KV value, and
    confirm which stores need native work. Its outcome is an input to the migration ADR, not
    a G5 task.
