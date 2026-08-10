> **How this file is used in `rebuild-pipeline`:** this is the org-default architecture for
> every rebuild's G4a decisions (`references/g4a-architecture.md`) — decomposition, stack,
> and cross-cutting concerns below start from this playbook's answers, not a blank slate.
> `adr-drafter` treats it as a fixed input alongside the reference product's lane-D evidence.
> An ADR is required to **diverge** from this default (with rationale and a
> reversal-condition); it is not required to adopt it. This is a deliberate exception to
> this pipeline's general "never inject a default" stance, scoped to architecture/stack only
> — taxonomy (G2), slicing (G3), and contracts (G4b) are unaffected and stay per-product
> decisions. Sections 1-17 below are otherwise unchanged from the source playbook.

---

# Playbook: Modular Monolith Backend + API-First Frontend
### Default: Go + Nuxt · Alternate: Node.js (Fastify) + Next.js

> Default architecture reference for enterprise-scale systems. **Go + Nuxt is the default stack**; **Fastify (Node.js) + Next.js** is the supported alternate when the default doesn't fit. Goal: clear role separation, parallel team development, and a system that stays maintainable for years without requiring an architectural rewrite.
>
> This playbook covers structural/architectural decisions only. For concrete scaffolding, versions, and CI wiring for either stack, see `bigin-skills` — entry point `bigin-harness-setup`, which runs the matching `*-scaffold` and then the governance harness — rather than duplicating that detail here.

---

## 1. Core Philosophy

**Central principle:** no architecture is ever "done" — the realistic goal is to correctly guess **where change will land** so that change is cheap there, and keep everything else genuinely simple.

**3 foundational decisions in this playbook:**

1. **Role separation ≠ network separation on the backend.** A modular monolith (clear module boundaries within a single process) captures ~80% of the benefits of microservices at ~20% of the operational cost.
2. **API-first is mandatory, not a choice.** Backend and frontend are separate runtimes no matter which stack is in play (default Go + Nuxt, or alternate Fastify + Next.js) — there's no path between them except a well-defined API contract. This is a real driver from day one, not speculative generality.
3. **Modularity carries over to the frontend too** — even with a single frontend client, feature boundaries keep the codebase predictable as it grows, for both human teams and AI coding agents navigating the repo. Only the Go backend gets compiler-enforced boundaries; everywhere else (Fastify, Nuxt, Next) the boundary is lint-enforced in CI (sections 4.3, 5.3) — weaker than a compiler, but still a merge-blocking check, not a folder convention.

**This playbook assumes one backend + one frontend by default.** The module boundaries and OpenAPI-first contract are deliberately kept stack-agnostic so a second client (mobile, another web app, a partner integration) can be added later without restructuring — but that isn't the driver for adopting this now.

**When this playbook does NOT apply:** teams under ~10 engineers, product-market fit not yet established, and no concrete need for a decoupled API surface. In that case, start simpler (a single framework doing both server rendering and business logic, e.g. Rails/Django/Laravel/Next-only) and split later once there's a real driver.

---

## 2. Overall Architecture

```
┌──────────────────────────────────────────────┐
│  Browser — Nuxt (default) / Next (alternate)    │
│  SSR public pages, SPA/CSR authenticated app      │
└─────────────────────┬────────────────────────┘
                       │  same-origin only; sealed session cookie —
                       │  JWT never in browser JS (section 7)
                       ▼
┌──────────────────────────────────────────────┐
│  BFF — Nitro server routes (Nuxt) /              │
│        Route Handlers (Next)                       │
│  unseals cookie → attaches Bearer JWT → proxies     │
└─────────────────────┬────────────────────────┘
                       │  REST (JSON), path-versioned (/v1/...)
                       ▼
┌────────────────────────────────────────────────────────┐
│  BACKEND — modular monolith, one process                   │
│  (Go default / Fastify alternate)                            │
│                                                               │
│  ┌─────────────┐ ┌─────────────┐ ┌────────────┐          │
│  │ projects      │ │ workpackages │ │ users/auth  │  ...     │
│  │  api           │ │  api          │ │  api         │          │
│  │  application   │ │  application  │ │  application │          │
│  │  domain        │ │  domain       │ │  domain      │          │
│  │  infrastructure│ │  infrastructure│ │  infrastructure│        │
│  └──────┬───────┘ └──────┬───────┘ └─────┬──────┘          │
│         │ cross-module: ONLY via a module's public           │
│         │ surface, or outbox events — never internals         │
│  ┌──────┴───────────────┴──────────────┴──────────┐      │
│  │ SHARED KERNEL: auth/RBAC, event bus, job queue      │      │
│  └──────────────────────────────────────────────────┘      │
└──────────────────────────┬──────────────────────────────┘
                            ▼
         Postgres — single instance, one schema per module;
         each module's own infrastructure/ talks to its schema
```

Note the two things this diagram is deliberately precise about, because scaffolding follows diagrams: the browser never calls the backend API directly (all traffic passes through the BFF — section 7), and the api/application/domain/infrastructure layers live **inside each module** (section 4.1), not as global horizontal tiers above the modules.

---

## 3. Repository Setup

**Default: Polyrepo (backend and frontend in separate repos).**

This is the stronger choice for this playbook specifically, not just a preference:

- **It's an enforcement mechanism, not just an org convention.** With the Fastify + Next.js alternate, both sides are TypeScript — in a monorepo, nothing stops the frontend from doing a plain `import` straight into the backend's `application/` layer, bypassing the API contract entirely. A repo boundary makes that physically impossible instead of policy-dependent. (This particular risk doesn't exist for Go + Nuxt, since the languages can't cross-import — but the playbook has to hold for both stacks.)
- **Independent deploy cadence.** Backend and frontend release on their own schedules; a frontend hotfix never waits on a backend CI pipeline and vice versa.
- **Clean CODEOWNERS/access control per repo**, mirroring the role separation from section 1.

**The one real cost — keeping the OpenAPI contract in sync across the repo boundary — is a solved problem, not an open one:**

```yaml
# backend CI, on merge to main
- run: <ensure-spec-current>                   # Go: openapi.yaml is authored, nothing to generate; Fastify: dump from @fastify/swagger
- run: gh release upload backend-v1.42.0 openapi.yaml   # tagged per backend RELEASE — not the /v1 API path version, which is a separate axis (section 6.3)
```

```yaml
# frontend CI
- run: curl -L <pinned-release-spec-url> -o openapi.yaml
- run: npx openapi-typescript openapi.yaml -o types/api.d.ts
- run: git diff --exit-code types/api.d.ts     # fail if types are stale vs the pinned contract
```

The frontend pins a specific backend release and bumps it deliberately — the same discipline as bumping any other dependency. **The pin lives in a committed file** (`api-contract.lock` containing the backend release tag) that the CI step reads; bumping it is a normal PR, optionally automated by a bot when the backend publishes. This is what makes section 6.2's CI sync check work across two repos instead of one.

**Alternate: Monorepo (pnpm/Turborepo workspaces, `backend/` and `frontend/` as packages).**

Reach for this when:

| Reach for monorepo when... |
|---|
| Team is under ~10 engineers and the cross-repo contract-sync ceremony isn't paid off yet (same threshold as section 1's "when this playbook doesn't apply") |
| Atomic PRs touching both sides matter more than independent deploy cadence at the current stage |
| Backend and frontend are both TypeScript (Fastify + Next) *and* the team is disciplined enough to enforce "frontend never imports backend internals" via the same boundary-lint tooling from section 4.3, extended to cover the cross-package case |

If starting in a monorepo pre-PMF, treat splitting to polyrepo later as a known, cheap migration — the OpenAPI contract and module boundaries are already what make that split possible without a rewrite.

---

## 4. Backend: Modular Monolith (Go default / Fastify alternate)

### 4.1 Directory Structure

**Go (default)**

```
backend/
  cmd/
    server/main.go              ← composition root: calls every module's Register()
  api/
    openapi.yaml                ← THE contract — hand-authored, single source of truth.
                                   Every operation is tagged with its module name;
                                   paths are written in full, including /v1.
  internal/
    projects/
      projects.go               ← module's ONLY public surface: exported interface for
                                   other modules + func Register(r gin.IRouter, deps Deps)
      internal/                  ← nested internal/: compiler blocks ALL other modules from everything below
        gen/                     ← oapi-codegen output for THIS module only (include-tags: [projects])
        domain/                  ← entities, pure business rules
        application/              ← use-cases (CreateProject, ArchiveProject...)
        infrastructure/            ← GORM models + repositories (this module's schema only)
        api/                       ← Gin handlers implementing gen.ServerInterface
    workpackages/
      workpackages.go
      internal/
        ...
    shared/                      ← shared kernel (auth/RBAC, eventbus, jobqueue) — inside
                                   internal/ like everything else, importable by all modules
```

**How the one spec wires into per-module handlers** — this is the load-bearing mechanism, so it's spelled out rather than left to inference:

1. `api/openapi.yaml` tags every operation with its module name (`tags: [projects]`).
2. Each module has its own small `oapi-codegen` config using `output-options.include-tags: [<module>]`, generating that module's `ServerInterface` + types into its own nested `internal/gen/`. One spec, N filtered generations — modules never share generated code.
3. The module's nested `internal/api/` handlers implement that generated interface; the module root file exposes it:

```go
// internal/projects/projects.go — the public surface
func Register(r gin.IRouter, deps Deps) {
    h := api.NewHandler(deps)            // nested internal/api — reachable from here, nowhere else
    gen.RegisterHandlers(r, h)           // registers this module's /v1/projects/* routes onto r
}
```

4. `cmd/server/main.go` is a pure composition root:

```go
r := gin.New()
projects.Register(r, deps)
workpackages.Register(r, deps)
users.Register(r, deps)
billing.Register(r, deps)
```

No module can see another's handlers, yet every route from the single contract gets mounted — the compiler-enforced boundary (this section) and the spec-first contract (section 6) compose instead of colliding.

Accompanying stack for the default: **Gin** (router), **oapi-codegen** (per-module server interfaces + types, generated from `openapi.yaml` as above — see section 6.1), **GORM** on the **pgx/v5** driver (persistence), **golang-migrate** (section 8), **golang-jwt** (section 7). This is the same stack `bigin-skills`' `go-scaffold` generates, so a scaffolded repo and this playbook agree on library choices from the first commit; what the scaffold does *not* give you is this section's module decomposition — see the note at the end of 4.1.

**The one rule GORM makes load-bearing:** `domain/` must not import `infrastructure/` — and with a full ORM that stops being a stylistic preference. The failure mode is concrete and near-universal: GORM struct tags (`gorm:"primaryKey"`, `gorm:"index"`) get written onto the domain entity because it's the same struct shape, and the module's business rules are now coupled to its table layout. Keep GORM models in `infrastructure/` as their own types, mapped to and from domain entities at that boundary, and let the lint in the next paragraph enforce the import direction. Accept the mapping code; it is the price of the ORM, and it is cheaper than the alternative.

**Important — how the `internal/` boundary actually works:** Go's top-level `internal/` only blocks imports from *outside* the backend repo — within it, `internal/workpackages` could freely import `internal/projects/domain` in a flat layout, and the compiler would say nothing. Real per-module compiler enforcement comes from the **nested** `internal/` shown above: each module's implementation lives under `internal/<module>/internal/`, unreachable from any other module; the only thing reachable is the small public surface file at the module root (`projects.go`). Layer rules *within* a module (e.g. `domain/` must not import `infrastructure/`) are lint territory — `go-arch-lint` or `depguard` in CI.

**What `go-scaffold` gives you and what it doesn't.** The scaffold generates this section's *stack* (Gin, `oapi-codegen`, GORM, `golang-migrate`, `golang-jwt`) in a **flat-package** layout with a single `api/api.gen.go` — appropriate for the starter case, and not this section's decomposition. Adopting the modular structure above is a deliberate first move on a scaffolded repo, and it is three concrete changes: (1) move implementation under `internal/<module>/internal/`, leaving only `<module>.go` at each module root; (2) split the one `oapi-codegen` config into per-module configs with `output-options.include-tags`, each writing into its module's nested `internal/gen/`; (3) replace the composition in `main()` with per-module `Register(r, deps)` calls. Do this before the second module exists — a flat app with four modules' worth of code in it is a migration, not a refactor.

**Node.js / Fastify (alternate)**

```
backend/
  src/
    modules/
      projects/
        domain/                 ← entities, pure business rules
        application/             ← use-cases
        infrastructure/           ← repository (Drizzle ORM), DB queries
        api/                      ← Fastify plugin: routes + TypeBox schemas
      workpackages/
        ...
      users/
        ...
      billing/
        ...
    shared/
      auth/                       ← JWT, permission engine
      event-bus/
      job-queue/
    api/
      openapi.json                ← generated, NOT hand-written
      app.ts                      ← registers each module's plugin with its own prefix
  package.json
```

Each module's `api/` is registered as its own encapsulated Fastify plugin:

```ts
fastify.register(projectsPlugin, { prefix: '/v1/projects' })
fastify.register(workpackagesPlugin, { prefix: '/v1/workpackages' })
```

Accompanying stack for this alternate: **TypeBox** (request/response schemas, doubles as the OpenAPI source via `@fastify/type-provider-typebox` + `@fastify/swagger`), **Drizzle** (ORM, per-module schema files under each module's `infrastructure/`), **Vitest** (tests), **pino** (Fastify's native logger).

Fastify's plugin encapsulation isolates request-lifecycle state (decorators/hooks) per module, but it does **not** stop a plain TypeScript import across module folders — see 4.3 for how that gap gets closed.

### 4.2 Hard Rules for Module Boundaries

- Module A is **not allowed** to directly import an internal struct/type/DB model of module B. It can only call through B's **module-root public surface** (`projects.go` in Go, the module's exported index in Fastify), which re-exports a small interface backed by B's `application/` use-cases — the `application/` layer itself stays internal.
- Prefer **events** over direct calls between modules whenever possible (e.g., `work_package.created` → the Notifications module subscribes on its own).
- Business logic lives in `application/`, **not** in `api/` (handlers/controllers). Handlers only parse the request, call the use-case, and serialize the response — no business rules there.
- Database: each module owns its own schema/tables, avoiding cross-module JOINs in SQL — use ID references and call through an interface if data from another module is needed.
- **Read composition** (the rule above's inevitable consequence, answered rather than dodged): every module's public surface includes a **batch-get** (`GetManyByIDs`) so a list page composing "50 work packages + their project names + assignee names" costs one call per module, never N+1. Screens where even that is too slow get an **event-fed read model** — a denormalized projection maintained by subscribing to other modules' outbox events (section 8). And **reporting/analytics** is the one sanctioned cross-schema reader: a read-only reporting schema (or separate reporting DB) fed by events, never ad-hoc JOINs from application code.

### 4.3 Enforcing the Boundary (stack-specific)

- **Go**: per-module boundaries are compiler-enforced **via the nested `internal/` pattern from 4.1** — a cross-module import of another module's internals fails to *compile*, not just fails review. (A flat `internal/<module>/domain` layout does NOT get this protection; the nesting is what makes it real.) Intra-module layer rules (`domain/` not importing `infrastructure/`) still need `go-arch-lint`/`depguard` in CI.
- **Fastify (Node.js/TypeScript)**: plugin encapsulation isolates decorators/hooks per module, but there's no language-level barrier against a plain cross-module import. The boundary has to be enforced by tooling — `eslint-plugin-boundaries` or `dependency-cruiser` in CI (or Nx module-boundary rules if using a monorepo tool). Treat a failing boundary-lint check with the same severity as a Go compile error: it blocks the merge, it's never just a warning.

---

## 5. Frontend: SSR/SPA Meta-framework (Nuxt default / Next.js alternate)

### 5.1 Feature-based Directory Structure

Both stacks use the same shape: **a thin route layer that composes, feature folders that own.** The route layer is the frontend's composition root — the analog of the Go `cmd/server/main.go` in section 4.1 — and it is the only place allowed to reach into more than one feature.

**Nuxt (default) — features are plain folders:**

```
app/
  pages/                       ← route shells only, kept thin — delegate into features/
  features/
    work-packages/
      composables/             ← query layer (Pinia Colada) over the generated api-client
      components/
    projects/
    billing/
  components/                  ← shared UI primitives only (auto-imported)
  composables/                 ← shared cross-feature composables only (auto-imported)
  api-client/                  ← generated from OpenAPI, NOT hand-written
nuxt.config.ts
```

**Next.js (alternate) — the same shape, different names:**

```
src/
  app/                       ← route segments only, kept thin — delegate into features/
  features/
    work-packages/
      hooks/                  ← query layer (TanStack Query) over the generated api-client
      components/
    projects/
    billing/
  shared/
    api-client/               ← generated from OpenAPI, NOT hand-written
```

**Why feature folders and not Nuxt Layers.** Layers look like the Nuxt-native answer to this and aren't, for three reasons:

- **Layers are a *merging* mechanism (config inheritance, override-by-priority), not an isolation mechanism.** Every extended layer's components and composables land in one global auto-import namespace, so feature A calls feature B's `useBillingInvoice()` with **no import statement at all** — precisely the violation 5.3's lint needs to see. Getting a boundary out of layers means setting `imports.scan: false` in every feature layer to *defeat* the framework's own default, and then maintaining that config forever.
- **Feature folders get the same property for free.** Nuxt auto-imports `app/components/**` recursively but scans `app/composables/` **top level only** (plus a subdirectory's `index.ts`). `app/features/*/composables/` falls outside both. So shared primitives stay auto-imported while crossing into a feature *requires* a written import path — the import statement the lint analyzes appears on its own, with no config to keep correct.
- **Pages live in `app/pages/` either way.** Splitting them across N layers assembles one URL tree out of N directories: a shared prefix like `/teams/[teamId]/…` whose children belong to three different features ends up in three places, and prefix collisions surface as build-time merge behavior instead of a directory you can read.

**When Layers *are* the right tool.** They're a superset — a feature folder becomes a layer by adding a `nuxt.config.ts` and one `extends` entry — so nothing here forecloses them. Reach for them when the merging mechanism is what you actually need:

- More than one Nuxt app in the product sharing feature code (a public/unauthenticated site alongside the authenticated app, a separate admin app, a Nuxt-based desktop shell). Note that Electron/Tauri *wrapping the same app* is not a second app and doesn't qualify.
- A base app extended by several product apps (a company starter/template layer) — layers used for config inheritance across repos, which is what they were built for.
- A feature that genuinely needs its own `nuxt.config`: own modules, own `routeRules`, own build target.

Absent one of those, layers cost a `nuxt.config.ts` per feature plus a root `extends` array to buy config inheritance a single-app product never uses.

### 5.2 Hard Rules for Feature Boundaries

Same principle as section 4.2, applied to the frontend:

- Feature A does **not** import feature B's components/composables/hooks directly (e.g. `projects` importing `billing`'s `InvoiceRow` component). Reuse goes through `shared/` — the generated `api-client` and anything deliberately promoted to a shared UI-primitives folder.
- A feature's `composables/` (Nuxt) or `hooks/` (Next) that call the API are private to that feature. If a second feature needs the same call, either it gets its own thin composable/hook around the shared `api-client`, or the logic gets promoted to `shared/` — it never gets imported cross-feature directly.
- **Those composables/hooks are the only way feature code reaches the API.** They wrap the data-fetching library (Pinia Colada `useQuery`/`useMutation`, TanStack Query) over `api-client`; components and pages consume them and never call `$fetch` or an HTTP client themselves. See §6.1 for why, and for the lint rule that holds it.
- No feature reaches into another feature's local state store directly. If two features keep needing each other's state, that's the same signal as Conway's Law in section 14 — the boundary is drawn in the wrong place, not a reason to add a cross-import.
- **The route layer is the one sanctioned exception**, the same way `analytics` is section 4.2's one sanctioned cross-schema reader. `app/pages/` (Nuxt) / `src/app/` (Next) may import from any feature, because composing several features onto one screen is its entire job — a work-package list legitimately needs teams, members, and labels. Keep those files thin: data wiring and layout only, no feature logic, and no re-export that would let feature A reach feature B *through* a route file. Without this exception the rule above has no escape valve and gets satisfied by dumping everything into `shared/`, which is the same as having no boundary.

### 5.3 Enforcing the Boundary (stack-specific)

- **Both stacks, same setup: core ESLint `no-restricted-imports`. No plugin, no resolver.** The rule matches the **import specifier string**, so nothing has to resolve to a file — which removes the entire failure mode a resolver-based boundary plugin brings with it (an unresolved alias is unclassified, no policy matches, the rule passes, `eslint` exits 0, and CI certifies a boundary that isn't there). One config block per feature: block every `features/*` path, then re-include your own with gitignore-style negation (`!`, **placed last — order matters**). 5.2's three rules fall out of that: feature → feature **blocked**; feature → `shared/` **allowed** because it never matches; route layer → any feature **allowed** because `app/pages/` gets no block at all, so no rule applies to it.

```js
// eslint.config.mjs — Nuxt shown; for Next use 'src/features', '@/features', and (src/)? below
import fs from 'node:fs'

const DIR = 'app/features'
const ALIAS = '~~/app/features'
const features = fs.existsSync(DIR)
  ? fs.readdirSync(DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  : []

export default withNuxt(...features.map((feature) => {
  const others = features.filter(f => f !== feature).join('|')
  // matches a *sibling feature* by name, so a deep own-feature '../../composables/x' stays legal
  const escape = `^(\\.\\./)+(app/)?(features/)?(${others})(/|$)`
  const lazy = `^(${ALIAS}/(?!${feature}(/|$))${others ? `|${escape.slice(1)}` : ''})`
  return {
    files: [`${DIR}/${feature}/**`],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        {
          group: [`${ALIAS}/*`, `${ALIAS}/*/**`, `!${ALIAS}/${feature}`, `!${ALIAS}/${feature}/**`],
          message: 'cross-feature import — reach other features through app/shared/',
        },
        ...(others ? [{ regex: escape, message: 'cross-feature import via a relative path' }] : []),
      ] }],
      // no-restricted-imports does not see dynamic import() — a lazily-loaded
      // cross-feature component is the likeliest real violation, so cover it here
      'no-restricted-syntax': ['error', {
        selector: `ImportExpression > Literal[value=/${lazy.replace(/\//g, '\\/')}/]`,
        message: 'cross-feature dynamic import() — reach other features through app/shared/',
      }],
    },
  }
}))
```

- **Know what the rule does and does not see**, since it reads specifier strings rather than a module graph. Verified against ESLint 9 on a fixture covering every row:

  | Crossing | Caught by |
  |---|---|
  | `import … from '~~/app/features/billing/…'` | `patterns.group` |
  | `import … from '~~/app/features/billing'` (bare/index) | `patterns.group` |
  | `export { x } from '~~/app/features/billing/…'` | `patterns.group` |
  | `'../../billing/…'`, `'../../features/billing/…'`, `'../../../app/features/billing/…'` | `patterns.regex` |
  | `await import('~~/app/features/billing/…')` | `no-restricted-syntax` |
  | `require('~~/app/features/billing/…')` | **nothing** — moot in an ESM Nuxt/Next app, but don't assume CJS is policed |

- **Prove it fires, and prove it doesn't over-fire.** Cheap now that there's no resolver to misconfigure, and still the step that separates a real boundary from a decorative one. Add a deliberate `~~/app/features/<other>/…` import plus a lazy `import()` of one, confirm `eslint` exits **1** on both, and delete them. Then confirm these four still pass, because a boundary rule that blocks legitimate work gets disabled within a week: own feature by alias, own feature by relative path **from a nested subfolder** (`components/deep/X.vue` → `../../composables/useX`), `shared/` by either form, and an `app/pages/` file importing several features at once.
- **The Nuxt precondition is 5.1's folder shape, not a config flag** — and it matters more here, not less. This rule can only judge an import that is *written*; Nuxt auto-imports produce no specifier at all, so an auto-imported cross-feature call is invisible to it. Feature folders sit outside the composables scan (5.1), which is what forces the crossing to appear as a real import. If you later move to Layers for one of 5.1's stated reasons, the `imports.scan: false` requirement comes back with them: layers organize and compose, they do not isolate, and without that flag "boundaries" are exactly the folder convention section 1 promises this isn't.
- Either way, treat a failing frontend boundary-lint check with the same severity as the backend's: it blocks the merge. Only the Go backend gets a compiler-enforced boundary; every frontend boundary is lint-plus-config, so the lint step is non-negotiable on both stacks.

### 5.4 Principles

- SSR for public/SEO pages (landing, docs), SPA/CSR for the authenticated app area — both Nuxt and Next support this hybrid per-route; don't force the entire app into one rendering mode.
- Frontend validation is **optimistic UI only**, never the source of truth — the source of truth is always the backend.
- One team/module owns one feature folder, reducing code conflicts when multiple teams work in parallel.
- The default is Nuxt; reach for Next.js only when there's a specific reason (existing React team, a library only available in the React ecosystem, etc.) — everything above applies to either.

### 5.5 The Presentation Layer

**Default: `@nuxt/ui` (Nuxt UI v4, MIT) on Tailwind CSS. Scaffold it in from the first commit — do not hand-roll a component layer.**

```bash
npm create nuxt@latest -- --template ui     # or the short form: -t ui
```

The `ui` template is the officially maintained Nuxt UI starter, so this costs one flag at init and nothing thereafter. Adopt it at the first commit: retrofitting a component library onto screens that already exist is a migration, and migrations get deferred.

**This playbook is making the call, not recording an existing one.** Nuxt UI is not installed by a bare `nuxt` init, so nothing decides this for you — and the failure mode of leaving it undecided is not "no library", it is a hand-rolled component layer that accretes screen by screen until replacing it is a project. §5.1's `components/ ← shared UI primitives only` left a slot with no stated origin; this fills it.

**Reference layouts: <https://github.com/nuxt-ui-templates>.** Before laying out a shell by hand, start from the template whose shape matches the product:

| Template | Shape |
|---|---|
| `dashboard` | admin-style multi-column shell — the usual fit for an authenticated app area |
| `saas` | public landing/pricing/blog/docs **+** a private `/dashboard` behind `nuxt-auth-utils` |
| `landing` | marketing landing page |
| `docs` | documentation site |
| `editor` | Notion-like WYSIWYG editor |
| `chat` | AI chat surface (Vercel AI SDK) |
| `portfolio` | portfolio/blog |
| `changelog` | GitHub-releases-powered changelog |

Read these as **layout references, not architecture**. They are standalone Nuxt apps and know nothing of this playbook: none of them ships §5.1's `features/` structure, and none has a BFF. Take the shell, the navigation pattern and the component composition — then impose §5.1–5.3's boundaries and section 7's BFF on top. A template cloned and left as-is gives you a good-looking app with none of this playbook's structure, which is the one way to use them badly.

**Why a library and not bespoke components** — the argument is about what CI can see, not about velocity:

- **A template↔stylesheet reference is unverifiable by any tool in the standard chain.** ESLint parses templates but knows nothing of CSS; `vue-tsc` type-checks props, not class names; axe tests the rendered result and cannot know a class was *meant* to do something. So `class="button button--danger"` against a stylesheet that never defines `button--danger` renders a destructive action as an ordinary button, in a green build, indefinitely. Reviewed in one real project: **nine** such classes, including that exact case and a `.dialog` with no definition at all.
- **Overlay and focus behaviour cannot be expressed in markup, and the failure is silent to AT.** `role="dialog" aria-modal="true"` is a *promise* that the background is unavailable. Honouring it needs a focus trap, focus restore, Escape, scroll lock, a portal, and background `inert` — none of which is markup, and none of which axe's WCAG rules can detect the absence of. A hand-rolled `div` with those two attributes and none of that behaviour actively misinforms a screen-reader user. `UModal` (Reka UI underneath) supplies the primitives; hand-written CSS structurally cannot.
- **Theming is the thing you actually want to own.** A library is not a constraint on visual identity — `app.config.ts` and Tailwind tokens are where brand lives, and that file is small, reviewable, and yours.

**What this does *not* dictate:**

- **Not a licence to skip §5.1–5.3.** `U*` components auto-import from `node_modules` and produce no `features/*` specifier, so §5.3's `no-restricted-imports` rule never sees them — the feature boundary is unaffected and still has to be set up and watched to fail.
- **Not a source of truth for validation.** §5.4's optimistic-UI-only rule still holds. `UForm`'s schema validation is a UX affordance; the backend remains the authority.
- **Not a substitute for a server-driven affordance contract.** If the API tells the client what a user may do, render from that. A component library makes hardcoded option lists *ergonomic* (`:items="['editor', 'author']"`), which is the same anti-pattern as gating UI on role slugs — now one keystroke away. Section 7's authorization rules are unchanged.
- **Not icons-by-network.** `@nuxt/icon` arrives transitively and falls back to the Iconify HTTP API when no local collection is installed. Install the collection you use (e.g. `@iconify-json/lucide`) so the server makes no third-party call at render time.

**When to hand-roll instead:** a product whose entire surface is a handful of screens with no dialogs, no async state and no forms; or a design system already committed to elsewhere in the org. "Our design is too custom" is not one of the cases — that is what the theme layer is for.

---

## 6. Shared Contract: OpenAPI as the Source of Truth

### 6.1 Pipeline

1. **One source of truth, with generation binding spec and code together — the direction differs per stack:**
   - Go (default, **spec-first**): `api/openapi.yaml` is hand-authored as the contract, with every operation tagged by module; per-module `oapi-codegen` configs (`include-tags`) generate each module's Gin server interface and types via the `gin-server` generator (wiring in section 4.1). Handlers implement the generated interface — change the spec and the code stops compiling until handlers catch up. *Structural* drift is impossible by construction; value-level correctness (a field of the right type carrying the wrong value) is what section 11's contract tests cover.
   - **What generation does *not* bind: `security:`.** `oapi-codegen`'s `gin-server` generates routing and types, never authorization — an operation's `security:` block produces no check in the generated code. So the spec's security section is documentation, and the enforcement lives where section 7 puts it (a module's `application/` layer, through the shared kernel's RBAC interface). The trap is assuming the contract is doing this: a route whose `security:` was written but whose application-layer check was never added compiles, generates, serves 200s, and passes every structural drift gate. Section 11's contract tests must therefore include a negative-authz case per protected operation — anonymous → 401, wrong-role → 403 — because that is the only thing that actually observes the binding.
   - **Author the spec as OpenAPI 3.0.x**, not 3.1 — `oapi-codegen`'s 3.1 support is not yet dependable, while every consumer here handles 3.0 perfectly. Revisit only by pinning and verifying a codegen version with proven 3.1 support.
   - Fastify (alternate, **code-first**): TypeBox schemas on each route (also used for runtime request/response validation) via `@fastify/type-provider-typebox`, exported through `@fastify/swagger` — the same schema object is both the validator and the spec source, so this step is close to free.
2. **Generate frontend types**: `openapi-typescript` generates the TS types from the published spec file (`openapi.yaml` for the Go default, `openapi.json` for the Fastify alternate — same tool, either format). **The transport is the framework's own client — Nuxt's `$fetch` (ofetch); do not add an HTTP library for the sake of it.** `$fetch` already handles SSR-vs-browser base resolution, so a third-party client buys nothing there.

   What the generated types *must* keep buying is **call-site enforcement**: a request whose path, params, body or response shape has drifted from the spec should fail `vue-tsc`, not fail in production. Bare `$fetch<T>` does not give you that — the `T` is an assertion you write by hand, so a drifted call type-checks against whatever you claimed. Close the gap with a thin typed wrapper over `$fetch` in `api-client/`, keyed on the generated `paths` type, so the path string and its params/body/response are inferred rather than asserted. That file is generated-or-mechanical and is the one place `$fetch` is called directly.

   Either way this is the base layer only, not the query layer. If you do reach for a typed client library (`openapi-fetch` is the usual one), treat it as an implementation detail of `api-client/` — nothing outside that folder should know which it is.

   **Hard rule: feature code never calls `$fetch` (or any client) directly. It consumes the query layer.** Two layers, and only two: `api-client/` owns transport and types; each feature's `composables/`/`hooks/` wrap it in the data-fetching library — **Pinia Colada `useQuery`/`useMutation` for Nuxt**, TanStack Query for Next — and components consume *those*. That layer is where caching, retries, invalidation and optimistic updates live, so a raw `$fetch` in a component or a page is not a shortcut, it is a request with no cache entry, no shared in-flight dedupe, no invalidation on mutation and no loading/error state the rest of the app can see. A mutation in particular must go through `useMutation`, because that is what knows which queries to invalidate afterwards; a component that writes with `$fetch` leaves every reader showing stale data until something else happens to refetch.

   This is cheap to enforce and worth enforcing: `$fetch` appearing anywhere under `app/features/**` or `app/pages/**` is a lint error, with `api-client/` the only exception. Same `no-restricted-*` mechanism as §5.3, one more rule. `orval` is deliberately not used here — its main value-add is generating query hooks/composables directly, which would duplicate or conflict with a dedicated Pinia Colada/TanStack Query composable layer rather than add to it.
3. No one hand-writes API types on the frontend — everything is generated from the published spec.

### 6.2 CI Enforcement of Sync (the step most often skipped)

```yaml
# Go (spec-first): committed generated code must match the spec
- run: go generate ./...                     # runs oapi-codegen from api/openapi.yaml
- run: git diff --exit-code api/gen/         # fail if generated stubs are stale

# Fastify (code-first): committed spec must match the code
- run: pnpm openapi:export                   # dump spec from @fastify/swagger
- run: git diff --exit-code openapi.json     # fail if spec changed but wasn't committed

# Both stacks: frontend types must match the spec
- run: npx openapi-typescript <spec-file> -o types/api.d.ts
- run: git diff --exit-code types/api.d.ts   # fail if TS types are outdated
```

Goal is identical in both directions: any change on one side of the spec↔code pair fails CI until the generator is re-run and committed. This is the only reliable way to stop "feature drift" from silently accumulating over months.

### 6.3 Versioning

When there's a breaking change (renamed field, changed type) → add a new versioned route (`/v2/...`), keep `/v1` intact until nothing depends on it anymore. Path versioning matters even with a single client, because it decouples backend releases from frontend deploys (and protects any background job, internal script, or future second client from breaking silently).

---

## 7. Shared Kernel

Shared components that change rarely and don't belong to any single module:

- **Auth/Permission engine**: JWT issue/refresh is **self-built as the default** (`golang-jwt` for Go, `@fastify/jwt` for Fastify) — reach for `ory/fosite`/`oidc-provider` only if the system must act as an OAuth2 provider *for third-party clients*, which is a rare, explicit requirement, not a default. **Permission model: RBAC** — roles→permissions defined once in the shared kernel; every check happens in a module's `application/` layer through a shared-kernel interface (never in handlers, never trusted from the frontend).
- **Event bus**: in-process (if distributed isn't needed yet) or NATS/Redis Streams if scaling out later.
- **Job queue**: Asynq or River for Go; BullMQ or Graphile Worker for Fastify — for background jobs (email, notifications, report generation).

**Frontend session handling — BFF pattern (default):**

The meta-framework's server runtime (Nitro for Nuxt, Route Handlers/middleware for Next) acts as a backend-for-frontend, and the JWT never reaches browser JavaScript:

- Nuxt (default): `nuxt-auth-utils` — the session is sealed (encrypted) inside an httpOnly cookie; only the Nuxt server can unseal it. Next (alternate): Auth.js or `iron-session`, same shape.
- **The BFF data path is one catch-all proxy route**, not per-endpoint server routes: `server/api/backend/[...path].ts` unseals the session, attaches `Authorization: Bearer <jwt>`, and forwards to the backend API. The `api-client/` layer's base URL is `/api/backend`, so feature composables work unchanged in the browser and during SSR — `$fetch` resolves that relative path correctly in both, which is the reason the same composable needs no environment branch. Hand-writing a server route per endpoint is banned — it recreates the hand-written API surface section 6 exists to eliminate.
- **Cookie size is a hard limit (4096 bytes), so respect it by design:** keep JWT claims minimal — user ID and role IDs only, never the expanded permission list (the backend resolves roles→permissions per request via the shared kernel). If the sealed payload (access + refresh token) ever approaches the limit, switch to a server-side session store (Redis) keyed by a small ID in the sealed cookie — don't fight the limit with truncation tricks.
- Refresh-token rotation happens server-side in the BFF and the cookie gets resealed — the browser never participates and never holds a refresh token.
- Cookie-carried auth requires `SameSite=Lax` (or Strict) plus CSRF protection on state-changing routes — the httpOnly cookie removes XSS token theft, not CSRF. Concrete mechanism: a small BFF middleware that verifies the `Origin` (or `Sec-Fetch-Site`) header on every non-GET request — dependency-free and sufficient for a same-origin app.
- **CORS consequence:** the browser only talks to its own origin (the BFF); BFF→API is server-to-server. The backend API therefore needs no public CORS policy — lock it down. If a direct browser→API call is ever introduced, that's an explicit decision with an explicit origin allowlist, never a wildcard.
- The pattern only holds if all browser→API traffic actually routes through the BFF's server routes. A single direct browser→backend call forces the token into browser-readable space and reopens both problems at once.

**The auth flow itself (so no one invents it):**

1. **Login:** browser → BFF `/api/auth/login` → backend `POST /v1/auth/login` (users/auth module; passwords hashed with **argon2id**). Backend returns an access JWT (**TTL ~15 minutes**) and a refresh token (**~30 days, rotating**, stored **hashed** in the users module's schema — which is what makes it revocable). BFF seals both into the cookie.
2. **Validation:** the backend issues and validates its own tokens — HS256 with a shared-kernel secret is sufficient while there's a single issuer and single verifier; move to asymmetric keys + JWKS only when a second service must verify tokens independently. The BFF never validates JWTs, it only transports them.
3. **Refresh:** on a 401 from the backend, the BFF calls `POST /v1/auth/refresh`, receives a new pair (old refresh token invalidated — rotation), reseals the cookie, retries the original request once.
4. **Logout & revocation:** logout clears the cookie **and** revokes the refresh token server-side. Combined with the short access-token TTL, that's the whole revocation story: a terminated employee's session dies within minutes, not at cookie expiry. There is no long-lived unrevocable credential anywhere in the design.

---

## 8. Data Conventions

- **ID strategy:** UUIDv7 (or ULID) as the default primary key across all modules — not auto-increment integers. Safe to expose in URLs/API responses without leaking sequence/volume info, and doesn't create cross-module coupling through shared auto-increment ranges if a module is ever extracted. Time-sortable variant preferred for index locality.
  - Go: `google/uuid` (`uuid.NewV7()`).
  - Fastify: the `uuid` package's `v7()` export (or the `uuidv7` package). **Not `crypto.randomUUID()`** — that generates v4 (random, not time-sortable), silently defeating the point. Node's native `crypto.randomUUIDv7()` exists only on very recent Node versions; don't assume it.
- **Audit columns:** every table gets `created_at`, `updated_at` (UTC `timestamptz`), a **`version` integer row-version column** (incremented on every update — this is what section 9.4's optimistic concurrency checks against), and `created_by`/`updated_by` where a user is involved. Cross-module user references (`created_by` pointing at the users module) are **bare UUIDs, never cross-schema foreign keys** — referential integrity across module boundaries is the interface's job, not the database's.
- **Soft delete, with its traps handled instead of discovered:** default to `deleted_at` nullable over hard delete. Three non-optional companion rules: (1) unique constraints become **partial unique indexes** (`... WHERE deleted_at IS NULL`) or a deleted row blocks re-creating its replacement; (2) the `deleted_at IS NULL` filter is baked into the query layer, never left to each call site's memory — GORM gives this for free via a `gorm.DeletedAt` field on the model, which scopes it out of every query automatically, and Drizzle gets a shared helper. **GORM's version has two escape hatches that bypass it silently**, so treat both as review-blocking: `Unscoped()` (legitimate only inside the explicit hard-delete use-case in rule 3) and any raw SQL / `Raw()` / `Exec()` path, where the filter is back to being the author's memory; (3) hard delete remains a separate, explicit use-case (e.g. GDPR erasure) — and note that real erasure must also cover outbox rows, DLQ entries, and event payloads consumers may have stored, so erasure is itself an event (`user.erased`) each module handles for its own schema.
- **Migrations:** `golang-migrate` for Go; Drizzle Kit for Fastify (pairs with the TypeBox/Drizzle stack from section 4.1). Migrations are forward-only once merged — a broken migration gets fixed by a new migration, never edited in place after it's shipped. Migrations run as a **separate deploy step before the app rolls out**, never on app startup, and each migration must be backward-compatible with the still-running version (expand → migrate → contract) so zero-downtime deploys stay possible. The shared kernel owns its own schema and migration directory (for `idempotency_keys`, processed-events, RBAC tables), with an explicit owning team per section 14 — kernel tables don't live in any feature module's schema.
- **Transactional outbox:** events are written to an outbox table **in each module's own schema** (required — same-transaction means same schema ownership) as part of the transaction that caused them; a relay publishes from the outbox after commit. The relay is just a recurring job in the existing job queue (section 7) — poll the outbox every few seconds, publish pending rows, mark them sent; no extra infrastructure. This closes the publish-side gap: without it, a process dying between "commit succeeded" and "event published" loses the event silently — and no dead-letter queue ever sees it, because the DLQ only covers consumption failures.
- **Consumers must be idempotent — at-least-once delivery guarantees duplicates.** The relay can crash between "publish" and "mark sent," so every event will eventually arrive twice. Each consuming module keeps a processed-events (inbox) table in its own schema and dedupes on event ID before handling. Without this, the doc's own `billing` example double-counts and notifications double-send — it's as mandatory as the outbox itself.
- **Cross-module consistency:** a single use-case commits to its own module's schema only — never a distributed transaction spanning two module schemas. Cross-module effects propagate via outbox events, and other modules converge eventually. If two modules constantly need atomic co-commits, that's the same signal as Conway's Law in section 14: the boundary is drawn wrong, and the fix is redrawing it, not weakening the rule.
- **Event schema versioning:** every event payload carries a `schema_version` field. Consumers reject or explicitly ignore events with an unrecognized version rather than guessing at the shape. Additive fields don't require a bump; renaming or removing a field does, with a dual-publish period (both versions emitted simultaneously) mirroring the API versioning approach in section 6.3.
- **Dead-letter handling:** failed event handlers retry with backoff (e.g. 3 attempts), then land in a dead-letter queue/table for manual inspection — never silently dropped. This is a required property of the event bus named in section 7, not optional infrastructure bolted on later.
- **File/attachment storage:** binaries go to S3-compatible object storage; the database stores only a metadata row (owner module, filename, content type, storage key). Uploads and downloads use presigned URLs so file bytes never stream through the API process. Blobs never live in Postgres.

---

## 9. API Design Conventions

### 9.1 Error Contract

All error responses share one JSON shape, defined once as a reusable OpenAPI schema component (section 6) — never invented ad hoc per handler:

```json
{
  "error": {
    "code": "PROJECTS_NOT_FOUND",
    "message": "That project doesn't exist or you don't have access to it.",
    "request_id": "req_01HXYZ...",
    "details": [
      { "field": "email", "message": "Must be a valid email address." }
    ]
  }
}
```

- `code` is a stable, module-prefixed, machine-readable string the frontend switches on. The frontend never parses `message` text to decide behavior. Codes are declared as an enum in the OpenAPI spec's shared components, so the frontend gets a generated type to switch on — the registry is the spec itself, not a wiki page.
- `message` is always safe to show a user. Internal details — stack traces, raw SQL errors, exception text — never reach `message`; they're logged server-side against `request_id` instead (see section 10).
- `details` is the optional field-level breakdown, present on validation errors (so forms highlight the actual input) and omitted otherwise — it's part of the one schema, not a second ad-hoc shape.
- Fixed HTTP status mapping: `400` validation, `401` unauthenticated, `403` unauthorized, `404` not found, `409` conflict, `422` business-rule violation, `429` rate-limited, `500` unexpected. The `api/` handler layer translates application-layer errors into this mapping — business logic in `application/` stays HTTP-agnostic, mirroring section 4.2's boundary in reverse.

### 9.2 Pagination, Filtering, Sorting

- **Cursor-based pagination is the default** for list endpoints: `?cursor=<opaque>&limit=50`, response envelope `{ "data": [...], "next_cursor": "..." | null }`. The cursor is base64 of the **full active sort tuple plus the row ID as final tiebreaker** (e.g. sorting by `-created_at,name` → cursor encodes `created_at|name|id`) — the ID tiebreaker is what keeps pagination stable when sort columns aren't unique. **Changing `sort` mid-pagination invalidates the cursor: the server rejects a cursor whose encoded sort doesn't match the request's `sort` param with `400`.** Offset pagination (`?page=2`) is allowed only for small, bounded admin lists where jump-to-page genuinely matters.
- **Sorting:** `?sort=-created_at,name` — leading `-` for descending, comma-separated for multiple fields. Sortable fields are an explicit allowlist per endpoint, not "any column."
- **Filtering:** plain query params for equality (`?status=active`), a documented suffix convention for ranges (`?created_after=...`). Whatever the convention, it's defined once in the OpenAPI spec's shared components and reused — every module's list endpoint looks the same to the frontend.

### 9.3 Idempotency

- Mutations that clients may retry — the frontend query layer (section 6.1) retries on network timeouts, and users double-click — accept an `Idempotency-Key` header. The server stores the key with the first response for a retention window and replays that response on repeats, instead of executing twice. Keys live in one shared-kernel table (`idempotency_keys`: key, request hash, stored response, expiry) with a TTL cleanup job — not per-module ad hoc storage.
- Mandatory for anything money-adjacent or side-effect-heavy (`billing`, sending notifications); recommended for all non-trivial mutations — **including version-checked `PUT`s (section 9.4)**. A version-checked `PUT` is *not* naturally retry-safe: the first attempt succeeds and increments `version`, the network-level retry then hits a version mismatch and returns a bogus `409` the frontend would misread as a real concurrent edit. The idempotency key solves exactly this — the retry replays the stored success response instead of re-executing. Only unconditional `DELETE` on a specific resource is safe without one.

### 9.4 Optimistic Concurrency

- Resources that multiple users can edit carry the `version` integer row-version column from section 8's audit columns, incremented on every update. Updates send the expected version (`If-Match` ETag or a `version` field in the body); a mismatch returns `409` and the frontend prompts a refresh/merge instead of silently overwriting the other user's change. Pair with an idempotency key (9.3) so network retries of a successful update don't masquerade as conflicts.
- Last-write-wins is acceptable only for single-owner resources (a user's own preferences) — never for shared domain objects like work packages.

### 9.5 Rate Limiting

- Named in section 2's diagram; the actual policy: per-user limits for authenticated traffic, per-IP for unauthenticated (login, password reset — which get the strictest limits, as brute-force targets). Exceeded limits return `429` with a `Retry-After` header, using the section 9.1 error shape.
- Limits live in configuration, not scattered as constants in handler code. `/healthz` and `/readyz` (section 10) are excluded.
- **Counter storage:** in-memory is acceptable only while running a single instance; the moment there's a second instance, counters move to a shared store (Redis) or the limit silently becomes N× looser. Decide which mode applies at deploy time, not after the incident.

---

## 10. Observability & Health Checks

- **Structured logging:** every log line carries `request_id`, `module`, and `user_id` (when authenticated), at minimum. Fastify: pino (already named in section 4.1), wired to Fastify's built-in request-id. Go: a structured logger (zerolog/zap) with the same fields enforced by convention or a small wrapper.
- **Health endpoints, required before any deploy behind a load balancer:**
  - `GET /healthz` — liveness: is the process up. Unauthenticated, excluded from rate limiting.
  - `GET /readyz` — readiness: can it serve traffic (DB reachable, migrations applied, critical dependencies OK).
- **Minimum metrics:** request rate/error-rate/duration per route (the RED method), plus job-queue depth and failure count for background jobs (section 7).
- **Request tracing:** propagate a request/trace ID across the entire lifecycle — into background jobs triggered by that request, and across the frontend→backend boundary. The header is **`X-Request-Id`**: the BFF generates it (or forwards the browser's), the backend echoes it in responses and error bodies (section 9.1's `request_id`). Full distributed tracing (OpenTelemetry) is a nice-to-have at small scale; request-id propagation itself is not optional.

---

## 11. Testing Strategy

- **Backend:** unit tests for `domain/` and `application/` (pure logic, no DB); integration tests for `infrastructure/` (real DB via test containers, not mocks) and `api/` (full HTTP round-trip through the router/plugin).
- **Contract testing:** section 6.2's CI check catches the spec and generated types drifting apart *structurally* — it can't catch a field that matches its declared type but returns the wrong value. A contract test suite (generated request/response schemas run against real endpoints) closes that gap. **It must also carry a negative-authz case per protected operation** — anonymous → 401, wrong-role → 403 — because no generator binds the spec's `security:` block to a check (section 6.1), so this suite is the only place that failure becomes visible.
- **Frontend:** component tests for isolated UI logic, plus a thin e2e suite (Playwright) covering critical paths only (login, primary CRUD flow per module) — not full-coverage e2e, just enough to catch integration breaks that type generation alone wouldn't.
- Specific coverage thresholds are a per-project decision, not fixed here — but *which layer gets which kind of test* is fixed, so a new engineer or an AI coding agent knows where a test belongs without guessing.

---

## 12. Local Development Environment

- `docker-compose` brings up infra (Postgres, and Redis/NATS if used) with one command. The application itself runs natively via the language's standard dev command (`go run`, `pnpm dev`), not containerized, so reload stays fast.
- **Seed data** is a scripted seed, not manual SQL — gives a new engineer a working dataset across every module on first run, invoked from a single entrypoint (`make dev-setup` or `pnpm dev:setup`).
- Environment variables are documented in a committed `.env.example`, never a real `.env`. Onboarding is "copy `.env.example`, fill in secrets, run one setup command" — not a wiki page of manual steps.

---

## 13. Secrets Management & Cross-Module Governance

- **Secrets** (JWT signing keys, DB credentials, OAuth client secrets, third-party API keys) live in a secrets manager (Vault, Doppler, cloud provider secret store) or, at minimum, environment variables injected at deploy time. Never committed to the repo, and never leaked into the OpenAPI spec or generated client code.
- **API deprecation policy:** once a versioned route (section 6.3) has a replacement, it gets a documented sunset date, announced via response headers — `Deprecation: @1735689600` (RFC 9745: the value is a structured-field Unix timestamp, not `true`) and `Sunset: <HTTP-date>` (RFC 8594) — so consuming clients can detect it programmatically, not just via a changelog someone might not read.
- **Cross-module contract governance:** when module A needs a new event or field from module B, the change is proposed as a PR against B's exported interface/event schema first, reviewed by B's owning team, and merged/released before A depends on it. Same review discipline as an external API change — from A's side, B's public surface *is* external.

---

## 14. Team Organization

- 1 team ≈ 1 (or a few) backend module(s) + the corresponding frontend feature folder.
- Module boundaries are enforced via **CI checks** (compiler for Go, lint/dependency-cruiser for Fastify), not just verbal convention.
- Conway's Law: module structure should mirror the actual team structure — if one module is regularly modified by multiple teams, that's a sign the module boundary is drawn in the wrong place and needs to be redrawn.

---

## 15. Anti-patterns to Avoid

| Anti-pattern | Consequence |
|---|---|
| Spec and code allowed to drift — no generation step binding them (either direction) | Frontend calls fields that don't exist; the "contract" is fiction |
| Business logic living inside the HTTP handler/controller | Can't be reused if a second client is added later, hard to test |
| Module A directly importing module B's internal model | Boundary is lost, back to spaghetti monolith |
| No CI check for type sync | Silent feature drift between backend and frontend |
| Frontend validation treated as the source of truth | Backend and frontend rules drift apart, bugs hard to detect |
| Full API-first ceremony for a prototype with no real API-first driver | Paying architectural cost for a need that hasn't materialized |
| Fastify backend with no boundary-lint CI step | `internal/`-style discipline exists only as a convention, gets violated silently |
| Each handler inventing its own error response shape | Frontend can't reliably switch on errors, ends up parsing message strings |
| No `/healthz`/`/readyz` endpoints before deploying behind a load balancer | Orchestrator can't detect a broken instance, traffic keeps routing to it |
| Event handler failures logged and forgotten, no dead-letter queue | Silent data loss — no one notices until a downstream report is wrong weeks later |
| Auto-increment integer IDs exposed in the API | Leaks volume/growth data, complicates any future module extraction |
| Secrets committed to the repo "just for local dev" | One `git log` away from a real credential leak |
| Module B changes its event schema without notifying module A | Runtime breakage with no code review ever having caught it |
| Frontend feature importing another feature's components/composables directly | Same spaghetti-coupling risk as backend module A/B, just relabeled "frontend" |
| Frontend has no boundary-lint step, treated as "just the backend's problem" | Feature isolation exists only until the first deadline-driven shortcut |
| Nuxt Layers used to express feature boundaries | A config-inheritance mechanism doing namespace work — auto-imports make every cross-feature call invisible to lint, so the boundary exists on the folder chart and nowhere else |
| Frontend boundary lint never watched to fail on a deliberate cross-feature import | The failure mode is silent by construction — a misconfigured rule matches nothing, `eslint` exits 0, and CI certifies a boundary that isn't there (5.3) |
| Frontend boundary rule that only covers static `import` | `import()` is uncovered by default, so the lazily-loaded cross-feature component — the likeliest real violation in a frontend — is the one that walks through (5.3) |
| Route files thick with feature logic instead of composing features | The one sanctioned cross-feature importer (5.2) becomes the place all the coupling hides |
| Events published outside the DB transaction (no outbox) | Commit succeeds, publish fails — event silently lost, and the DLQ never sees it |
| Event consumers without event-ID dedup (no inbox table) | At-least-once delivery double-sends notifications and double-counts billing — guaranteed, not hypothetical |
| JWT stored in localStorage or otherwise readable by browser JS | One XSS = stolen session; the sealed httpOnly cookie via the BFF exists for exactly this |
| File blobs stored in Postgres | DB bloat, slow backups, memory-heavy API responses — object storage + metadata row is the pattern |
| Migrations run on app startup | Schema change and deploy become coupled; zero-downtime rollout breaks the first time a migration is slow |

---

## 16. Default vs Alternate Stack

**Default: Go + Nuxt.** Use this unless there's a concrete reason not to.

**Alternate: Fastify (Node.js) + Next.js.** Reach for this when:

| Backend | Reach for Fastify over Go when... |
|---|---|
| | The team building/maintaining this service is already TS-heavy and won't realistically pick up Go, or the service needs a library that only exists in the Node ecosystem |

| Frontend | Reach for Next.js over Nuxt when... |
|---|---|
| | The consuming team is React-only, or the project must share components with an existing Next.js codebase |

Mixing is allowed (e.g. Go backend + Next frontend) if the two choices above are made independently for good reasons — it isn't an all-or-nothing pair.

Fastify (not NestJS, not Encore.ts) is the named alternate specifically because it matches BigIn's existing Node.js stack choices (TypeBox, Drizzle, Vitest, pino) and keeps the boundary-enforcement story simple: one lint rule (`eslint-plugin-boundaries`/`dependency-cruiser`), not a framework-specific DI system to reason about.

Sections 1–15 apply unchanged regardless of which stack is chosen. For the actual scaffolding commands, dependency versions, and CI templates for whichever stack is picked, invoke `bigin-skills`' **`bigin-harness-setup`** — it delegates to the matching scaffold skill (`go-scaffold`, `nuxt-scaffold`, `nodejs-scaffold`, `next-scaffold`) and then installs the governance harness, so it is the one entry point rather than four. This playbook stays at the architecture level on purpose.

---

## 17. Getting-Started Checklist

- [ ] Confirm there's a real API-first driver (decoupled backend/frontend releases, or a second client on the roadmap) — not just "might need it later"
- [ ] Repo setup decided: polyrepo (default) unless the monorepo alternate is justified — with the OpenAPI publish/pin mechanism in place if polyrepo
- [ ] Set up module boundaries from the start: `internal/` (Go) or a boundary-lint rule (Fastify), enforced in CI
- [ ] Repo created through `bigin-skills`' **`bigin-harness-setup`** (it runs the matching `*-scaffold` itself, then overlays the governance harness) — not by hand, and not by calling a scaffold skill directly
- [ ] Go only: apply section 4.1's decomposition **before the second module exists** — the scaffold ships the right stack in a flat layout, and restructuring later is a migration
- [ ] Presentation layer scaffolded in, not deferred: `@nuxt/ui` from the first commit (`npm create nuxt@latest -- --template ui`), with a reference layout picked from `github.com/nuxt-ui-templates` where one fits (section 5.5) — hand-rolling a component layer is a decision that has to be justified, not the path of least resistance
- [ ] Icon collection installed locally (e.g. `@iconify-json/lucide`) so `@nuxt/icon` never falls back to the Iconify HTTP API at render time (section 5.5)
- [ ] Frontend feature boundaries enforced: core ESLint `no-restricted-imports` per feature folder in CI (no plugin, no resolver — section 5.3), route layer as the only cross-feature importer — not assumed automatic just because it's the frontend
- [ ] That rule **watched to fail once** on a deliberate cross-feature import *and* on a lazy `import()` of one, then watched **not** to fire on own-feature, nested-relative, `shared/`, and `app/pages/` imports (section 5.3)
- [ ] Business logic 100% in the `application/` layer, handlers/controllers are a thin layer only
- [ ] Spec↔code bound by generation: spec-first via per-module oapi-codegen (Go, OpenAPI 3.0.x) or code-first via TypeBox export (Fastify) — CI diff-checks enforce it
- [ ] CI has a diff-check step between the spec and generated frontend types
- [ ] Data layer is Pinia Colada `useQuery`/`useMutation` (or TanStack Query) over `api-client/`, with a lint rule banning `$fetch`/HTTP-client calls under `features/**` and `pages/**` — watched to fail once (section 6.1)
- [ ] API versioning by path ready starting from v1
- [ ] Auth flow per section 7: login/refresh/revocation endpoints, argon2id, short access TTL, BFF catch-all proxy — implemented once, not per feature
- [ ] ID strategy (UUIDv7/ULID), audit columns incl. `version`, and migration tooling decided before the first table is created
- [ ] Transactional outbox, consumer-side event dedup (inbox table), event schema versioning, and dead-letter handling in place before the event bus carries anything business-critical
- [ ] Frontend sessions via the BFF sealed-cookie pattern (`nuxt-auth-utils` / Auth.js) — JWT never readable by browser JS, backend CORS locked down
- [ ] Pagination, idempotency, and optimistic-concurrency conventions (section 9) adopted before the first list/mutation endpoints ship
- [ ] Migrations run as a separate deploy step, backward-compatible with the still-running version
- [ ] Standardized error response shape defined as an OpenAPI schema component, used by every handler
- [ ] `/healthz` and `/readyz` endpoints exist before the first production deploy
- [ ] Structured logging includes `request_id` at minimum, propagated frontend → backend → jobs
- [ ] Testing layers assigned per section 11 (not "we'll figure out testing later")
- [ ] `docker-compose` + scripted seed data gets a new engineer running in one command
- [ ] Secrets live in a secrets manager or deploy-time env vars — none committed to the repo
- [ ] Using the default stack (Go + Nuxt) unless the alternate (Fastify + Next.js) is justified — decision recorded, not left implicit
