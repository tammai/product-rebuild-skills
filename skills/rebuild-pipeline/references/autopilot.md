# Autopilot — unattended stretches between gates

Autopilot runs the mechanical work the user would otherwise advance by typing "continue":
mining lanes, matrix and slice drafts, ADR and contract drafts, per-slice module builds,
parity reports. It **halts at every gate**. Locking stays a human act (SKILL.md Step 5) —
autopilot never runs `gate.mjs lock`, and `stop_at_gates` has no off switch.

It is off unless the user asks for it, and asking for it is not the same as consenting to
it. "Autopilot" earns a **brief**; only an explicit yes earns a run.

## Requirements

The 5-hour rate-limit window (`rate_limits.five_hour`) is piped by Claude Code to the
**status line only** — not to hooks, not into the conversation. Autopilot therefore reads
it from a snapshot the status line writes. Without that snapshot there is no usage
awareness, so `preflight` refuses to pass.

If preflight reports a missing snapshot, the user's statusLine command needs this, once:

```sh
rl=$(echo "$input" | jq -c 'if .rate_limits then
       {five_hour: .rate_limits.five_hour, seven_day: .rate_limits.seven_day, at: (now|floor)}
     else empty end' 2>/dev/null)
if [ -n "$rl" ]; then
  printf '%s\n' "$rl" > "$HOME/.claude/.rate-limits.json.tmp" 2>/dev/null \
    && mv -f "$HOME/.claude/.rate-limits.json.tmp" "$HOME/.claude/.rate-limits.json" 2>/dev/null
fi
```

Two cases where it cannot work at all, and preflight says so rather than guessing:
`rate_limits` exists **only on Claude Pro/Max plans**, and a snapshot older than 15 minutes
means the status line has stopped rendering — **autopilot is interactive-session only**, so
it cannot run headless or from a cron job.

A workbench scaffolded before autopilot existed has no `scripts/autopilot.mjs`. Copy it and
`schemas/autopilot.schema.json` from the plugin's `skills/rebuild-pipeline/`, same as the
`erd.mjs` upgrade path — do not run the plugin's copy in place.

## Engaging

1. Steps 1–3 of the orchestration protocol as normal — locate, `gate.mjs status`, report.
2. `node scripts/autopilot.mjs preflight` and `node scripts/validate.mjs`.
   Preflight reuses `pause-check.mjs` wholesale, so a dirty tree, unpushed work in any
   `repos.yaml` repo, a stash, a gate reopened but not re-locked, or a stray dev server all
   surface here. Do not engage on a partial pass.
3. Present the **brief**:
   - current phase, from the script — not from memory of the conversation
   - the concrete units it will run, listed
   - **where it will stop**, named: "halts at Gate 2 with the slice plan drafted"
   - current 5h usage, the reset time, and the threshold
   - anything preflight noted, including a previous run's `next_action`
4. **Get an explicit yes.** If the answer is qualified ("sure, but skip lane C"), fold that
   into the brief and re-confirm rather than interpreting it mid-run.
5. `node scripts/autopilot.mjs engage` — optionally `--threshold N` if the user wants
   headroom other than 80%.

## The loop

Per unit of work:

1. `node scripts/autopilot.mjs check` — exit 3 means stop, whatever the reason. It is
   read-only and cheap; run it *before* the unit, never only after.
2. Do the unit. Delegate per `subagent-briefs.md`; run independent lanes in one turn.
3. Write the output to disk and commit it.
4. `node scripts/autopilot.mjs log --unit "..." --outcome done|failed|skipped [--note "..."]`

Step 3 is the point of the whole design. A unit that ends with its output still in the
conversation is a unit that did not happen — an unattended run cannot be asked to
re-explain itself. Each `log` also commits the state file, which keeps the tree clean for
the `gate.mjs lock` the user will run at the halt.

## Halting

**At a gate.** Write the full gate review to `plan/gate-reviews/gate-N.md` — what is being
locked, the key decisions inside it, open risks, what becomes immutable, and every point
where the draft diverged from `adr/playbook.md` or from the reference. Commit it,
then `disengage --reason gate-review --next "..."`, run `pause-check.mjs`, and present the
review. The user decides; the file is there so the decision does not depend on scrollback.

**On trouble** — stop, do not work around:

| Situation | `--reason` |
|---|---|
| 5h window hits the threshold | `usage-threshold` |
| `validate.mjs` fails and the fix is not mechanical | `validate-failed` |
| `pause-check.mjs` goes ⚠️ | `pause-check-unsafe` |
| A subagent fails twice, or returns nothing | `error` |
| Intent is ambiguous (SKILL.md 4c), or a human decision is due | `needs-user-decision` |

**Decisions autopilot may take alone:** lane dispatch and finding merges, dedup, canonical
naming drafts, the dependency graph, slice-order drafts, ADR drafts against
`adr/playbook.md`, data-model and contract drafts, module specs, slice code against
locked contracts, parity reports, and fixing its own validation failures. Vendoring the
selected playbook to `adr/playbook.md` at G4a entry is also autopilot's to do — it is a copy,
not a decision. **Choosing or switching a playbook is not**: if the applicability check finds
that the selected playbook's `not-applicable-when:` describes this rebuild, halt with
`needs-user-decision` rather than picking another one or falling back to blank-slate.

**Decisions it must never take alone** — halt with `needs-user-decision`. These are
scattered across the phase references; this is the whole list:

- license posture, and the G0 remote-purpose question (durability, or durability + CI)
- `sources.yaml` review, and confirming the reference runs locally
- taxonomy approval and canonical-name spot-checks (G2)
- learning-weighting for slice order (G3)
- the G4a team-composition question — `g4a-architecture.md` says to ask it *every time*,
  because no other artifact in this pipeline records team facts
- each ADR decision, in dependency order (G4a) — drafting is delegable, deciding is not
- the G4b coherence and callee checks, including before a re-lock after a reopen
- spec approval before any code is written (G5)
- **marking a slice done** — the slice is not done until deployed and `done_means` is
  demonstrably true
- adopting an upstream feature into the backlog (G6)
- the GP drills — the user performs them
- any gate reopen, and the reason for it
- creating a remote, and its visibility

## Pausing — identical to a user-initiated pause

1. Stop the current unit. If the guard hook blocked a write, `disengage` first — that
   unblocks writing, and the run is over either way.
2. Get in-flight work to disk as drafts (checkpoint discipline), commit, and **push** the
   workbench and every repo in `repos.yaml`.
3. `node scripts/autopilot.mjs disengage --reason <r> --next "<what comes next>"`
4. `node scripts/pause-check.mjs` — and resolve what it flags. Relaying the warning is not
   resolving it.
5. Report and stop:

```
⏸ AUTOPILOT PAUSED — 5h usage 81% (resets 14:20, in 1h 6m)
   Completed: 4 units — S4 spec, S4 backend, S4 frontend, S4 infra
   Next:      S5 spec  ·  ✅ safe to pause
   Continue when the window resets, or stop here?
```

Then **end the turn**. Do not start the next unit while asking. Nothing resumes on a timer;
the user comes back.

## Resuming

Re-run Steps 1–3 and `preflight` from scratch — usage has moved, the tree may have changed,
and a gate may have been locked while you were away. `engaged_phase` and
`paused.next_action` in `plan/autopilot.yaml` are breadcrumbs for a human reading the file;
`gate.mjs status` is the authority. Re-brief, re-confirm, re-engage. A run left `engaged` by
a session that died is not a run in progress — preflight flags it, and engaging again
overwrites the state while preserving the log.

## The threshold is a limit, not a budget

`hooks/scripts/autopilot-guard.mjs` blocks Write/Edit once an engaged run crosses its
threshold, because a rule about stopping is at its weakest exactly when it matters — mid-unit,
with the end apparently close.

It fails **open** until an engaged run is established — not in a workbench, no
`plan/autopilot.yaml`, status not `engaged`: allowed, always, because none of those is an
autopilot write and the guard must never break an unrelated edit. After that it fails
**closed**: a missing, unreadable or stale snapshot blocks too, since an unverifiable window
is not a low one and the run has already declared itself unattended. If the status line
breaks mid-run, autopilot stops rather than losing its threshold silently.

Two consequences worth knowing:

- **A run left `engaged` by a session that died will block your manual edits** in that
  workbench. The block message names the fix: `disengage --reason error`. Preflight flags the
  same leftover state before it can bite.
- **A blocked subagent gets different instructions.** A miner or spec-writer that trips the
  threshold is told to stop and report upward, explicitly *not* to run `disengage` — ending
  the run belongs to the orchestrator, which is the only party that knows the `next_action`.

The staleness bounds differ on purpose: `check` allows 15 minutes, the hook allows 45. The
status line re-renders at tool-call *boundaries*, not during a call — a 100-second call was
measured updating at each end with a 95-second silence between. `check` runs at unit
boundaries, moments after a render. The hook can fire twenty minutes into a slice build, where
an old snapshot is normal and nothing is wrong.
