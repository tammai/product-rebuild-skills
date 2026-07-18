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
- Confirm the user can run the reference locally (Docker preferred). This becomes a
  hard G1 exit requirement.

## Exit criteria
Reference chosen with recorded rationale; `license-posture.md` complete;
`sources.yaml` reviewed by the user; workbench scaffolded and CI green on empty state.
