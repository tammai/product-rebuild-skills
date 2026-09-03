#!/usr/bin/env node
// sequence.mjs — the logged-decision mechanism for slice ORDER. Run from the workbench root.
// Usage:
//   node scripts/sequence.mjs status
//   node scripts/sequence.mjs init [--force]
//   node scripts/sequence.mjs sync [--by <name>]
//   node scripts/sequence.mjs reorder <Sn> (--before <Sm> | --after <Sm> | --first | --last)
//                                          --reason "..." [--by <name>]
//
// WHY THIS EXISTS
//
// G3 states the Gate 2 decision outright: "'full features' is the fixed destination, so decide
// SEQUENCE, not scope." But sequence had nowhere to live except the ARRAY ORDER of
// plan/slices.yaml, which gate-2 hashes whole. So the one thing G3 calls the decision was the
// most expensive thing in the pipeline to revise: a formal reopen, a new hash, and a moved pin
// for every code repo holding the workbench as a submodule — all to say "build S6 before S4".
// The predictable result is not that the order never changes. It is that it changes in
// someone's head and nowhere on disk.
//
// So the file splits in two along the line plan/progress.yaml and parity/flows/ already drew:
//
//   plan/slices.yaml  — slice BOUNDARIES (features, depends_on, done_means). Gate 2, unchanged.
//   plan/sequence.yaml — the SEQUENCE. Ungated, but every change carries a reason and a log
//                        entry, exactly like `flows unlock` and a gate reopen.
//
// Cheap in mechanism, deliberately not cheap in ceremony.
//
// THE FROZEN HEAD
//
// Reordering is a BETWEEN-SLICES act. Everything at or before the current slice is history and
// does not move; only the pending tail does. That single rule is what keeps this script able to
// be strict without ever standing between anyone and progress — it refuses while a slice is
// in-progress, it refuses to move a slice that has shipped, and it refuses an order that
// violates a depends_on edge gate-2 already locked. The dependency graph is machine-checkable;
// the learning-value tradeoff G3 asks about is not, and this script does not pretend otherwise.
//
// A mid-slice finding ("S6 should come before S4") does not need this script at all. It goes in
// plan/progress.yaml's `notes:` for the slice you are IN, which parity.mjs already carries into
// the report and slice-review.mjs surfaces as a reorder candidate. Observed when it is real,
// acted on when it is safe.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const SEQUENCE_FILE = "plan/sequence.yaml";
export const DECISION_LOG = "plan/sequence-decisions.md";

const readYaml = (p, fallback) => {
  if (!existsSync(p)) return fallback;
  try { return parse(readFileSync(p, "utf8")) ?? fallback; } catch { return fallback; }
};

/** Slice ids in plan/slices.yaml's positional order — the pre-sequence.yaml fallback. */
export const positionalOrder = (root = ".") =>
  (readYaml(join(root, "plan/slices.yaml"), []) || []).map((s) => s?.id).filter(Boolean);

/**
 * The execution order, and where it came from. Every consumer goes through here so the
 * fallback is identical everywhere: a workbench with no sequence.yaml (every one scaffolded
 * before 0.15.0) keeps behaving exactly as it did, reading order off the array.
 */
export const readSequence = (root = ".") => {
  const positional = positionalOrder(root);
  const seq = readYaml(join(root, SEQUENCE_FILE), null);
  if (!seq || !Array.isArray(seq.order)) {
    return { order: positional, baseline: positional, source: "positional", present: false };
  }
  return {
    order: seq.order, baseline: Array.isArray(seq.baseline) ? seq.baseline : seq.order,
    source: "sequence.yaml", present: true,
  };
};

/** Slice id -> effective status, progress.yaml overlaying the gate-2 `status:`. */
export const sliceStatuses = (root = ".") => {
  const progress = readYaml(join(root, "plan/progress.yaml"), {}) || {};
  const overlay = progress.slices || {};
  const out = new Map();
  for (const s of readYaml(join(root, "plan/slices.yaml"), []) || []) {
    if (s?.id) out.set(s.id, overlay[s.id] || s.status || "pending");
  }
  return out;
};

const SHIPPED = new Set(["done", "deployed"]);

/**
 * Everything the callers need to reason about movability, in one shape.
 *
 * `frozenBoundary` is the first index the pending tail starts at: one past the LAST
 * non-pending slice in the current order, not the first. Taking the last matters — a slice
 * built out of order leaves pending slices sitting behind it, and those are behind shipped
 * work whatever their own status says. Freezing to the last non-pending slice is the
 * conservative reading, and `status` reports the anomaly rather than quietly allowing a move
 * into a region that is already history.
 */
export const analyse = (root = ".") => {
  const slices = readYaml(join(root, "plan/slices.yaml"), []) || [];
  const byId = new Map(slices.filter((s) => s?.id).map((s) => [s.id, s]));
  const { order, baseline, source, present } = readSequence(root);
  const statuses = sliceStatuses(root);
  const statusOf = (id) => statuses.get(id) || "pending";

  let lastNonPending = -1;
  order.forEach((id, i) => { if (statusOf(id) !== "pending") lastNonPending = i; });
  const frozenBoundary = lastNonPending + 1;

  const inProgress = order.filter((id) => statusOf(id) === "in-progress");
  // Pending slices stuck behind shipped work: the order was overtaken in practice.
  const stranded = order.slice(0, frozenBoundary).filter((id) => statusOf(id) === "pending");

  // Which pending slices could run next, dependency-wise. This is the input to a between-slices
  // reorder conversation, and it is the one part of the tradeoff a machine can compute.
  const shippedIds = new Set(order.filter((id) => SHIPPED.has(statusOf(id))));
  const ready = order.slice(frozenBoundary)
    .filter((id) => (byId.get(id)?.depends_on || []).every((d) => shippedIds.has(d)));

  return { slices, byId, order, baseline, source, present, statuses, statusOf,
           frozenBoundary, inProgress, stranded, ready, shippedIds };
};

/** First depends_on edge the given order violates, or null. depends_on is gate-2 locked. */
export const dependencyViolation = (order, byId) => {
  const pos = new Map(order.map((id, i) => [id, i]));
  for (const id of order) {
    for (const dep of byId.get(id)?.depends_on || []) {
      if (!pos.has(dep)) continue; // unknown dep — validate.mjs reports it against slices.yaml
      if (pos.get(dep) > pos.get(id)) return { slice: id, dep };
    }
  }
  return null;
};

// --- CLI below. Importing this module runs nothing. ---
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  if (!existsSync(join("locks", "pipeline.yaml"))) {
    console.error("No locks/pipeline.yaml here — run from the workbench root.");
    process.exit(1);
  }
  const argv = process.argv;
  const cmd = argv[2] || "status";
  const argAfter = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : undefined; };
  const has = (flag) => argv.includes(flag);
  const by = argAfter("--by") || process.env.USER || "unknown";
  const now = new Date().toISOString();
  const yamlStr = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;

  const writeSequence = ({ baseline, order, recorded }) => {
    mkdirSync("plan", { recursive: true });
    writeFileSync(SEQUENCE_FILE,
`# Slice execution order. Written by scripts/sequence.mjs — do not hand-edit.
#
# plan/slices.yaml holds the slice BOUNDARIES and is hashed whole by gate-2. This file holds
# the SEQUENCE, which G3 calls the actual Gate 2 decision, so that revising it is a logged
# decision rather than a formal gate reopen. Only the pending tail moves; see
# plan/sequence-decisions.md for every change and its reason.
recorded: ${recorded}
baseline: [${baseline.join(", ")}]
order:    [${order.join(", ")}]
`);
  };
  const logDecision = (body) => {
    mkdirSync("plan", { recursive: true });
    if (!existsSync(DECISION_LOG)) {
      writeFileSync(DECISION_LOG, "# Slice sequence decisions\n\n" +
        "Every change to the slice execution order, in order, with its reason.\n" +
        "Written by `npm run sequence`. Do not edit by hand — the point of the log is that it\n" +
        "records what happened, not what someone remembers happening.\n\n" +
        "Slice *boundaries* are gate-2 locked and are not changed here; a change to what is IN\n" +
        "a slice is still a gate-2 reopen.\n\n");
    }
    appendFileSync(DECISION_LOG, body);
  };
  const gateLocked = (id) => {
    const p = join("locks", `${id}.yaml`);
    return existsSync(p) && /^status: locked$/m.test(readFileSync(p, "utf8"));
  };

  // ---------------------------------------------------------------- status
  if (cmd === "status") {
    const a = analyse();
    // Emptiness is decided by plan/slices.yaml, not by the order: an overlay left behind after
    // the plan was emptied would otherwise print rows for slices that no longer exist.
    if (!a.slices.length) {
      console.log("No slice plan yet — plan/slices.yaml is empty or absent (normal before G3).");
      if (a.present) {
        console.log(`${SEQUENCE_FILE} still names ${a.order.join(", ")}. Reconcile: npm run sequence -- sync`);
      }
      process.exit(0);
    }
    if (!a.present) {
      console.log(`Slice order: reading plan/slices.yaml positionally — ${SEQUENCE_FILE} does not exist.`);
      console.log(`Reordering is a gate-2 reopen until it does. Create it: npm run sequence -- init\n`);
    }
    const orphans = a.order.filter((id) => !a.byId.has(id));
    const missing = a.slices.map((s) => s.id).filter((id) => !a.order.includes(id));
    const mark = { done: "done", deployed: "deployed", "in-progress": "IN PROGRESS", pending: "pending" };
    a.order.filter((id) => a.byId.has(id)).forEach((id, i) => {
      const s = a.byId.get(id);
      const st = a.statusOf(id);
      const frozen = i < a.frozenBoundary;
      const readyMark = !frozen && a.ready.includes(id) ? "  ← deps met" : "";
      console.log(`  ${frozen ? " " : "·"} ${id.padEnd(4)} ${(s?.name || "(unknown slice)").padEnd(34)} ${(mark[st] || st).padEnd(11)}${readyMark}`);
      if (i + 1 === a.frozenBoundary && a.frozenBoundary < a.order.length) {
        console.log(`    ${"─".repeat(58)}  pending tail — the only part that moves`);
      }
    });
    const drift = a.baseline.join(",") !== a.order.join(",");
    // Only claim agreement with the baseline when a baseline was actually recorded. Without
    // sequence.yaml, baseline and order are the same array by construction, and saying they
    // match would assert something no artifact establishes.
    console.log(`\n  ${a.frozenBoundary} of ${a.order.length} slice(s) frozen.` +
      (!a.present ? "" : drift
        ? ` Order has diverged from the gate-2 baseline (${a.baseline.join(" → ")}).`
        : " Order matches the gate-2 baseline."));
    if (a.inProgress.length) {
      console.log(`  ${a.inProgress.join(", ")} in progress — reordering is refused until it finishes ` +
        `or is set back to pending. Reordering is a between-slices act.`);
    }
    if (a.stranded.length) {
      console.log(`  ⚠ ${a.stranded.join(", ")} still pending but positioned before shipped work — ` +
        `the plan was overtaken. Reorder to move them into the tail, or record why they stay put.`);
    }
    if (orphans.length || missing.length) {
      // validate.mjs fails on the same condition; naming it here too matters because `status` is
      // where someone looks when the order surprises them, and "(unknown slice)" is not an answer.
      if (orphans.length) console.log(`  ⚠ ${orphans.join(", ")} in the order but not in plan/slices.yaml.`);
      if (missing.length) console.log(`  ⚠ ${missing.join(", ")} in plan/slices.yaml but not in the order — never scheduled.`);
      console.log(`    Reconcile after a gate-2 reopen: npm run sequence -- sync`);
    }
    if (existsSync(DECISION_LOG)) console.log(`  Decision log: ${DECISION_LOG}`);
    process.exit(0);
  }

  // ------------------------------------------------------------------ init
  if (cmd === "init") {
    const positional = positionalOrder();
    if (!positional.length) {
      console.error("plan/slices.yaml has no slices — nothing to sequence. Run this after G3 drafts the plan.");
      process.exit(1);
    }
    if (existsSync(SEQUENCE_FILE) && !has("--force")) {
      console.error(`${SEQUENCE_FILE} already exists. Reorder it with \`reorder\`, or pass --force to ` +
        `re-baseline from plan/slices.yaml (which discards the current order and the drift it records).`);
      process.exit(1);
    }
    writeSequence({ baseline: positional, order: positional, recorded: now });
    logDecision(`- **${now}** · initialised by ${by}\n  - baseline ${positional.join(" → ")}\n`);
    console.log(`Wrote ${SEQUENCE_FILE} — baseline and order both ${positional.join(" → ")}.`);
    if (!gateLocked("gate-2")) {
      console.log(`Note: gate-2 is not locked, so plan/slices.yaml can still change freely and this ` +
        `baseline is provisional. Re-run with --force after the lock to record the real one.`);
    }
    console.log(`Commit it. From here, reordering the pending tail is \`npm run sequence -- reorder\`, ` +
      `not a gate-2 reopen.`);
    process.exit(0);
  }

  // ------------------------------------------------------------------ sync
  // A gate-2 reopen that adds or drops a slice leaves this file a non-permutation, which
  // validate.mjs fails on. Reconciling is bookkeeping, not a decision — the decision was the
  // reopen — so it needs no reason. It is still logged, because a slice appearing at the end of
  // the tail by default is a placement somebody should see.
  if (cmd === "sync") {
    if (!existsSync(SEQUENCE_FILE)) {
      console.error(`${SEQUENCE_FILE} does not exist — run \`npm run sequence -- init\` first.`);
      process.exit(1);
    }
    const positional = positionalOrder();
    const known = new Set(positional);
    const a = analyse();
    const keep = (arr) => arr.filter((id) => known.has(id));
    const added = positional.filter((id) => !a.order.includes(id));
    const removed = a.order.filter((id) => !known.has(id));
    if (!added.length && !removed.length) { console.log("Already in sync with plan/slices.yaml — nothing to do."); process.exit(0); }
    const order = [...keep(a.order), ...added];
    const baseline = [...keep(a.baseline), ...added];
    writeSequence({ baseline, order, recorded: now });
    const lines = [
      ...added.map((id) => `  - added ${id} (${a.byId.get(id)?.name || "?"}) at the end of the tail — ` +
        `reorder it if that is not where it belongs`),
      ...removed.map((id) => `  - removed ${id}, no longer in plan/slices.yaml`),
    ];
    logDecision(`- **${now}** · synced with plan/slices.yaml by ${by}\n${lines.join("\n")}\n`);
    console.log(`Synced ${SEQUENCE_FILE}.\n${lines.join("\n")}`);
    if (added.length) console.log(`\nNew slices land last by default. Move them with \`reorder\` — that one needs a --reason.`);
    process.exit(0);
  }

  // --------------------------------------------------------------- reorder
  if (cmd === "reorder") {
    const slice = argv[3];
    const reason = argAfter("--reason");
    const before = argAfter("--before"), after = argAfter("--after");
    const first = has("--first"), last = has("--last");

    if (!slice || slice.startsWith("--")) {
      console.error("Usage: reorder <Sn> (--before <Sm> | --after <Sm> | --first | --last) --reason \"...\"");
      process.exit(1);
    }
    const targets = [before && "--before", after && "--after", first && "--first", last && "--last"].filter(Boolean);
    if (targets.length !== 1) {
      console.error(`Give exactly one destination: --before <Sm>, --after <Sm>, --first or --last (got ${targets.length}).`);
      process.exit(1);
    }
    if (!reason) {
      console.error("Reordering requires --reason \"...\" — it is a formal, logged event, same register as a gate reopen.");
      console.error("Say what the build taught you that the Gate 2 order did not know. This is the only record");
      console.error("that the plan moved and why; without it, drift is indistinguishable from the original plan.");
      process.exit(1);
    }
    if (!existsSync(SEQUENCE_FILE)) {
      console.error(`${SEQUENCE_FILE} does not exist, so order still lives in plan/slices.yaml's array — which`);
      console.error(`gate-2 hashes, making this a gate reopen rather than a logged decision.`);
      console.error(`Create the overlay first: npm run sequence -- init`);
      process.exit(1);
    }

    const a = analyse();
    const fail = (msg, ...rest) => { console.error(msg); for (const r of rest) console.error(r); process.exit(1); };

    if (!a.order.includes(slice)) fail(`${slice} is not in the slice plan.`);

    // (1) The rule the whole design rests on: reordering is a between-slices act.
    if (a.inProgress.length) {
      fail(`${a.inProgress.join(", ")} is in progress — reordering is refused while a slice is being built.`,
        `Reordering is a between-slices act: finish the slice (or set it back to \`pending\` in`,
        `plan/progress.yaml if it is being abandoned), then reorder.`,
        ``,
        `Record the finding now so it survives to the boundary — plan/progress.yaml \`notes:\` on the`,
        `slice you are IN. It reaches the parity report and the next slice review by itself.`);
    }
    // (2) The past is not reorderable.
    const fromIdx = a.order.indexOf(slice);
    if (fromIdx < a.frozenBoundary) {
      fail(`${slice} is ${a.statusOf(slice)} (or sits before shipped work) — the frozen head does not move.`,
        `Only the pending tail reorders: ${a.order.slice(a.frozenBoundary).join(", ") || "(empty)"}.`);
    }

    // Resolve the destination index within the tail.
    const rest = a.order.filter((id) => id !== slice);
    let insertAt;
    if (first) insertAt = a.frozenBoundary;
    else if (last) insertAt = rest.length;
    else {
      const anchor = before || after;
      if (!rest.includes(anchor)) fail(`Anchor ${anchor} is not in the slice plan (or is the slice being moved).`);
      const anchorIdx = rest.indexOf(anchor);
      // (3) A destination inside the frozen head is the same violation as moving a frozen slice.
      if (anchorIdx < a.frozenBoundary || (before && anchorIdx < a.frozenBoundary)) {
        fail(`${anchor} is in the frozen head — ${slice} cannot be placed there.`,
          `The tail starts at ${a.order[a.frozenBoundary] || "(nothing pending)"}.`);
      }
      insertAt = before ? anchorIdx : anchorIdx + 1;
    }
    if (insertAt < a.frozenBoundary) fail(`That destination is inside the frozen head — only the pending tail moves.`);

    const order = [...rest.slice(0, insertAt), slice, ...rest.slice(insertAt)];
    if (order.join(",") === a.order.join(",")) { console.log(`${slice} is already there — nothing to do.`); process.exit(0); }

    // (4) depends_on is gate-2 locked, so the graph check is free and is not negotiable here.
    const v = dependencyViolation(order, a.byId);
    if (v) {
      fail(`That order puts ${v.slice} before ${v.dep}, which it depends on.`,
        `\`depends_on\` is gate-2 locked — changing it is a reopen, not a reorder.`,
        `Proposed: ${order.join(" → ")}`);
    }

    writeSequence({ baseline: a.baseline, order, recorded: now });
    const where = first ? "to the front of the tail" : last ? "to the end"
      : before ? `before ${before}` : `after ${after}`;
    logDecision(`- **${now}** · moved ${slice} ${where}, by ${by}\n` +
      `  - ${reason}\n` +
      `  - was: ${a.order.join(" → ")}\n` +
      `  - now: ${order.join(" → ")}\n`);
    console.log(`Moved ${slice} ${where}.`);
    console.log(`  was: ${a.order.join(" → ")}`);
    console.log(`  now: ${order.join(" → ")}`);
    console.log(`Logged to ${DECISION_LOG}. Commit both files.`);
    process.exit(0);
  }

  console.error("Usage: sequence.mjs status | init [--force] | sync | " +
    "reorder <Sn> (--before <Sm>|--after <Sm>|--first|--last) --reason \"...\"");
  process.exit(1);
}
