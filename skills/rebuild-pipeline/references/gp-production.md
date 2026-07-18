# GP — Production readiness → GATE 5: prod-ready lock (terminal)

Feature-complete ≠ production-ready. This gate verifies the difference BY DOING.
Run fully when the slice plan completes; run the lightweight subset (deploy + backup +
error tracking) at every slice.

Checklist — each item needs EVIDENCE (log, recording, doc link), not assertion:
- Security: authn/authz reviewed against the lane-D permission matrix; secrets
  management; dependency/container scans green; headers, rate limits, input validation tested.
- Data safety: automated backups running; restore ACTUALLY performed into a clean
  environment and verified; migration rollback exercised once.
- Observability: structured logs, error tracking, metrics + alerts; "is it up / erroring
  / slow" answerable without SSH.
- Operations: one-command deploy; rollback documented and rehearsed; upgrade path
  written; runbook for top 3 failure modes.
- Docs: install/deploy doc good enough for a stranger; architecture doc matches final
  ADR state.
- Incident dry-run: one simulated failure (kill DB / fill disk) handled using only the
  runbook. The USER performs the drills; you prepare and observe.

## Gate 5 review
Walk the evidence per item. Lock on explicit approval: `gate.mjs lock gate-5`.
This is the finish line — the result now matches the promise: completed, full-featured,
production-ready.
