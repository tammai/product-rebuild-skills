# G6 — Parity loop (automated)

Run after each slice and on schedule (monthly default).

1. **AC suite**: run the tests; "is the feature done" is a test result, not a meeting.
2. **Parity diff**: `node .../scripts/parity.mjs` — rebuild coverage vs `matrix/`:
   covered / partial / missing per feature, plus scope-creep detection (built but not
   in matrix). Report lands in `parity/<date>.md`.
3. **Upstream re-mine**: re-run lane A (changelog) against the reference's latest
   release; content-hashing surfaces only real changes. New upstream features enter the
   matrix as backlog candidates flagged for the next slice boundary — they NEVER bypass
   gates or reorder the current slice.

Present the report briefly: coverage %, AC pass rate, upstream movements, creep items.
Ask the user only when a decision is needed (e.g. adopt an upstream feature into the
backlog or ignore it with reason).
