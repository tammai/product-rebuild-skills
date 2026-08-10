# G0 — Reference selection + license posture

Goal: pick the reference and record the legal posture BEFORE any agent reads anything.

## Onboarding interview (ask, don't assume)
1. Which reference product, or which category? If category only, propose 2–3 concrete
   OSS candidates and compare: domain fit, codebase readability for the user's stack
   familiarity, upstream activity (parity loop needs a living reference), deployability.
2. Distribution intent — this is the license-posture decision:
   - Private/learning use → reading any OSS source (incl. GPL/AGPL) as reference is
     low-risk; full lane-D mining allowed.
   - Possible closed-source distribution later → treat copyleft references clean-room:
     mine behavior via running product/docs/API only; lane D restricted to no-code sources.
   - Permissive reference (MIT/Apache/BSD) → no restriction; vendoring allowed with attribution.
   Record the answer in `license-posture.md`. State clearly you are not a lawyer; if
   distribution plans are ambiguous, recommend professional advice before locking G0.
3. Optional secondary reference for UX comparison only.

## Actions
- Scaffold: `node ${CLAUDE_PLUGIN_ROOT}/skills/rebuild-pipeline/scripts/rebuild-init.mjs <name>`
- Fill `sources.yaml`: exactly what agents may fetch/clone, derived from the posture.
  If clean-room: the reference repo goes on the deny list.
- **Give the workbench a remote now, before mining starts.** Everything the pipeline is
  about to produce — taxonomy, ADRs, gate history — is unreproducible: re-mining the
  reference yields different findings, not the decisions you argued yourself into. Waiting
  until "there's something worth backing up" means the loss window covers G1 and G2, the
  phases with the most output.
  ```sh
  gh repo create <name>-workbench --private --source . --push
  # Durability-only remote? Turn the host's CI off so pushes stay silent:
  gh api -X PUT repos/<owner>/<name>-workbench/actions/permissions -F enabled=false
  ```
  Pushing stays manual and stays your job: `npm run pause-check` flags anything that has not
  left the machine before a session ends, but nothing pushes on your behalf. That includes
  **gate tags** — every `gate.mjs lock` mints a `gate-N/vN` tag that code repos consume as a
  submodule pin, and `git push` sends no tags (nor does `--follow-tags`: these are
  lightweight). After every lock: `git push && git push --tags`.
  Ask which the remote is for — durability only, or durability *and* hosted CI — and record the
  answer. It decides that last line here and step 4 of G5's repo checklist. The scaffold ships
  a `validate.yml` that does pass on a hosted runner, but the code repos' workflows will not
  (see G5's private-submodule trap), so "we push to GitHub" and "GitHub runs our CI" need to be
  separate decisions rather than one assumption.
  **Visibility follows the posture just decided.** `private-learning` or
  `possible-closed-distribution` → private, non-negotiable: pushing the rebuild to a public
  remote is distribution, which neither posture covers, and would need a G0 reopen. The
  mechanism differs by reference — a copyleft reference makes it a licensing problem, a
  proprietary one a terms/trade-secret problem — but the answer is private either way. Only
  `permissive-reference` leaves it open. Say this out loud when you create the repo —
  the user chose the posture minutes ago and will not connect it to a `gh` flag.
- Confirm the user can run the reference locally (Docker preferred). This becomes a
  hard G1 exit requirement.
- **Confirm the `bigin-skills` plugin is installed**, and say why now rather than later: it
  is this pipeline's baseline for creating code repos (`bigin-harness-setup` → scaffold +
  governance harness, see `g5-build.md`), and it is not needed until G5 — which is weeks of
  gates away. Checking costs one look at the available-skills list; not checking means
  finding out on the day the first repo is due. If it is missing, tell the user to install
  it (`/plugin marketplace add tammai/bigin-skills`, then
  `/plugin install bigin-skills@bigin` — the marketplace is named `bigin`, not
  `bigin-skills`) but do **not** block G0 on it — nothing before G5 touches it.

## Exit criteria
Reference chosen with recorded rationale; `license-posture.md` complete;
`sources.yaml` reviewed by the user; workbench scaffolded and CI green on empty state;
workbench pushed to a remote whose visibility matches the recorded posture
(`npm run pause-check` confirms nothing is still local-only).
