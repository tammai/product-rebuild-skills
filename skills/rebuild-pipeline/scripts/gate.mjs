#!/usr/bin/env node
// gate.mjs — view and manage gate locks. Run from the workbench root.
// Usage:
//   node scripts/gate.mjs status
//   node scripts/gate.mjs lock <gate-id> [--by <name>]
//   node scripts/gate.mjs reopen <gate-id> --reason "..."
// Locking records sha256 hashes of every file under the gate's `protects:` paths.
// Zero-dependency: lock files use a fixed YAML subset written/parsed here.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { execSync } from "node:child_process";

const LOCKS = "locks";
const ORDER = ["gate-1", "gate-2", "gate-3", "gate-4", "gate-5"];

// Paths a gate protects REGARDLESS of what its lock file's `protects:` list says.
//
// `protects:` is written once by rebuild-init.mjs at scaffold time, which means a path
// added to a gate by a later release reaches new workbenches only. That is fine for a
// script (the plugin's copy still runs) and not fine for a lock: a gate-1 that does not
// hash findings/rules/ leaves the Rule Cards editable after the taxonomy locks, in every
// workbench scaffolded before 0.17.0 — silently, and exactly in the projects most likely
// to have rules worth locking.
//
// So the list is unioned in here at lock time and written into the lock file, which also
// hands it to gate-guard.mjs for free: that hook reads `protects:` out of the locked file,
// so a path this adds is enforced by the guard from the moment the gate locks.
//
// Rules are TAXONOMY, not design — the same argument that puts matrix/features.yaml behind
// gate-1. A rule discovered later enters the way a late feature does: added under the
// existing structure, never restructuring it.
const REQUIRED_PROTECTS = {
  "gate-1": ["findings/rules/"],
};
const PHASE_BEFORE = {
  "gate-1": "G2 feature matrix", "gate-2": "G3 milestone slicing",
  "gate-3": "G4a system design", "gate-4": "G4b data model + contracts",
  // NOT "GP production readiness" — see phaseBeforeGate5 below. Kept as the fallback for a
  // workbench with no slice plan at all.
  "gate-5": "GP production readiness",
};

// Slice states, for the one phase the gate sequence alone cannot name.
//
// G5 (build) and G6 (parity) sit BETWEEN gate-4 and gate-5 and are gated by neither, so deriving
// the phase from "first unlocked gate" reports GP production readiness the moment contracts lock —
// through every slice of the build, which is where a project spends most of its life. That is not
// a cosmetic slip: SKILL.md's orchestration protocol tells the model to trust this script's output
// over its memory of the conversation, so a wrong answer here is a wrong answer at the one step
// designed to catch stale assumptions.
//
// Zero-dependency by the same rule as the lock files: a fixed YAML subset, parsed here.
// plan/progress.yaml's `slices:` map wins over plan/slices.yaml's own `status:`, matching
// parity.mjs's overlay precedence.
const sliceStates = () => {
  const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const overlay = {};
  const progress = read("plan/progress.yaml");
  // Indented lines OR blank ones: a hand-written progress file groups its entries with blank
  // lines and comments, and a pattern that stops at the first blank line silently reads only the
  // first group — which is a wrong phase rather than an error. The block still ends at the next
  // top-level key, because that line is neither indented nor empty.
  const slicesBlock = progress.match(/^slices:\n((?:(?:[ \t]+.*)?\n)*)/m);
  if (slicesBlock) {
    for (const m of slicesBlock[1].matchAll(/^\s+(S\d+):\s*([a-z-]+)/gm)) overlay[m[1]] = m[2];
  }
  const plan = read("plan/slices.yaml");
  const out = [];
  // One entry per `- id: SN`, carrying the nearest following `status:` before the next entry.
  const entries = plan.split(/^- id: /m).slice(1);
  for (const e of entries) {
    const id = (e.match(/^(S\d+)/) || [])[1];
    if (!id) continue;
    const own = (e.match(/^\s{2}status:\s*([a-z-]+)/m) || [])[1] || "pending";
    out.push({ id, status: overlay[id] || own });
  }
  return out;
};

// What to call the phase when contracts are locked and prod-ready is not.
const phaseBeforeGate5 = () => {
  const slices = sliceStates();
  if (!slices.length) return null; // no slice plan — fall back to the table above
  const done = slices.filter((s) => s.status === "done" || s.status === "deployed");
  const next = slices.find((s) => s.status !== "done" && s.status !== "deployed");
  const count = `${done.length}/${slices.length} slices`;
  return next
    ? `G5 build — next unfinished slice ${next.id} (${next.status}), ${count} done`
    : `GP production readiness (${count} done)`;
};

if (!existsSync(join(LOCKS, "pipeline.yaml"))) {
  console.error("No locks/pipeline.yaml here — run from the workbench root.");
  process.exit(1);
}

// Free-text fields (title, reason, locked_by) go through here before being written —
// unquoted plain scalars break as soon as the value contains a colon-space, a leading
// indicator char, a trailing colon, or a "#" (comment start). Quoting is conditional
// (not "always double-quote") so pre-existing simple values round-trip unchanged.
const needsQuoting = (s) => /: |:$|^[-?:,[\]{}#&*!|>'"%@`]|\n/.test(s);
const yamlStr = (s) => needsQuoting(s)
  ? `"${String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"')}"`
  : s;
const unquote = (s) => s !== undefined && /^".*"$/.test(s)
  ? s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\")
  : s;

const parseLock = (id) => {
  const text = readFileSync(join(LOCKS, `${id}.yaml`), "utf8");
  const get = (k) => unquote((text.match(new RegExp(`^${k}: (.*)$`, "m")) || [])[1]?.trim());
  const protects = [...text.matchAll(/^  - (.+)$/gm)].map((m) => m[1].trim())
    .filter((p) => !p.startsWith("action:"));
  return { id, title: get("title"), status: get("status"), locked_at: get("locked_at"), text, protects };
};

const filesUnder = (p) => {
  if (!existsSync(p)) return [];
  if (statSync(p).isFile()) return [p];
  return readdirSync(p, { recursive: true })
    .map((f) => join(p, String(f))).filter((f) => statSync(f).isFile());
};
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

const cmd = process.argv[2];

if (cmd === "status" || !cmd) {
  const locks = ORDER.map(parseLock);
  for (const l of locks) {
    const mark = l.status === "locked" ? "LOCKED" : "open  ";
    console.log(`${l.id}  [${mark}]  ${l.title}${l.locked_at ? `  (${l.locked_at})` : ""}`);
  }
  const current = locks.find((l) => l.status !== "locked");
  if (!current) {
    console.log("\nAll gates locked — pipeline complete.");
    process.exit(0);
  }
  const phase = (current.id === "gate-5" && phaseBeforeGate5()) || PHASE_BEFORE[current.id];
  console.log(`\nCurrent phase: ${phase} (working toward ${current.id})`);
  process.exit(0);
}

const id = process.argv[3];
if (!ORDER.includes(id)) { console.error(`Unknown gate: ${id}`); process.exit(1); }
const lock = parseLock(id);
const now = new Date().toISOString();
const argAfter = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

if (cmd === "lock") {
  const prevOpen = ORDER.slice(0, ORDER.indexOf(id)).map(parseLock).filter((l) => l.status !== "locked");
  if (prevOpen.length) {
    console.error(`Cannot lock ${id}: earlier gate(s) still open: ${prevOpen.map((l) => l.id).join(", ")}`);
    process.exit(1);
  }
  // Gate 4 locks the data model as well as the three contract layers, and G4b drafts it
  // FIRST — Gate 3 decided where data lives, this decides what it is. The check has to be
  // here rather than in validate.mjs: gate status is open|locked with nothing in between,
  // so a validator that fires on `locked` reports a missing data model only after the tag
  // is cut, turning a one-line edit into a reopen and a new gate-4/vN.
  //
  // Imported here, not at the top of the file: `erd.mjs` is a newer script than the four
  // rebuild-init has always copied, so a workbench upgraded by hand can be missing it. A
  // top-level import makes that absence take out `gate.mjs status` too — the command the
  // orchestration protocol runs first, and the one thing that must never stop answering.
  // Lock is the only path that needs it, so lock is the only path that fails on it.
  if (id === "gate-4") {
    let erd;
    try { erd = await import("./erd.mjs"); }
    catch {
      console.error(`Cannot lock ${id}: scripts/erd.mjs is missing, so the data model cannot be ` +
        `checked. Copy it from the plugin's skills/rebuild-pipeline/scripts/ alongside the copies ` +
        `of validate.mjs and gate.mjs already in this workbench.`);
      process.exit(1);
    }
    const { DATA_MODEL_DIR, DATA_MODEL_REMEDY, checkDataModel, isLegacyWorkbench } = erd;
    const dm = checkDataModel();
    const issues = [...dm.problems];
    if (dm.missing) issues.push(`${DATA_MODEL_DIR}/ contains no .mermaid file`);
    if (issues.length) {
      const body = issues.map((i) => `  ${i}`).join("\n") + `\n  ${DATA_MODEL_REMEDY}`;
      if (isLegacyWorkbench()) {
        console.warn(`WARNING: locking ${id} without a checked data model:\n${body}\n` +
          `  Allowed because this workbench predates schema_version 0.2.0. To enforce it, add the\n` +
          `  data model and set schema_version: "0.2.0" in locks/pipeline.yaml.`);
      } else {
        console.error(`Cannot lock ${id}:\n${body}`);
        process.exit(1);
      }
    }
  }

  // Gate 3 locks the ADRs AND the playbook they cite. G4a vendors the selected playbook to
  // adr/playbook.md precisely so the citations survive a plugin upgrade — a copy that never
  // arrived leaves every "cites §7" pointing at whatever the registry says months from now.
  // The undecided-concerns check is the other half: "every cross-cutting concern decided"
  // was a prose exit criterion until the playbook's concerns: map made it a list, and a list
  // is checkable. Same placement reasoning as gate-4's data model — a validator that fires
  // on `locked` reports the gap only after the tag is cut.
  if (id === "gate-3") {
    let pb;
    try { pb = await import("./playbook.mjs"); }
    catch {
      console.error(`Cannot lock ${id}: scripts/playbook.mjs is missing, so the architecture ` +
        `playbook cannot be checked. Copy it from the plugin's skills/rebuild-pipeline/scripts/ ` +
        `alongside the copies of validate.mjs and gate.mjs already in this workbench.`);
      process.exit(1);
    }
    const { checkPlaybook, PLAYBOOK_REMEDY, VENDORED_PLAYBOOK, isPrePlaybookWorkbench } = pb;
    const res = checkPlaybook();
    if (!res.disabled) {
      const issues = [...res.problems];
      if (res.missingVendored) {
        issues.push(`${VENDORED_PLAYBOOK} does not exist — G4a step 0.3 must vendor the ` +
          `"${res.selected}" playbook (selected ${res.selectedBy === "default"
            ? "by default: sources.yaml's architecture.playbook is empty"
            : "in sources.yaml"}) before this gate can lock, so the ADR citations are pinned by the lock`);
      }
      if (res.undecided.length) {
        issues.push(`no ADR for concern(s): ${res.undecided.join(", ")} ` +
          `(every key in the playbook's concerns: map needs one, even to record N/A)`);
      }
      if (issues.length) {
        const body = issues.map((i) => `  ${i}`).join("\n") + `\n  ${PLAYBOOK_REMEDY}`;
        if (isPrePlaybookWorkbench()) {
          console.warn(`WARNING: locking ${id} without a checked architecture playbook:\n${body}\n` +
            `  Allowed because this workbench predates schema_version 0.3.0. To enforce it, backfill\n` +
            `  and set schema_version: "0.3.0" in locks/pipeline.yaml.`);
        } else {
          console.error(`Cannot lock ${id}:\n${body}`);
          process.exit(1);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Gate 5 refuses to lock while the newest equivalence run has a failure nobody explained.
  //
  // Gate 5 is terminal. Nothing downstream catches an overclaim here, which is why its rubric is
  // almost entirely about honesty — and a red equivalence trace is the least deniable thing in
  // the project: it says the rebuild returns something the old system did not, on traffic
  // recorded from the old system before the rebuild existed. Locking over it would be the
  // pipeline's own definition of done disagreeing with its own evidence.
  //
  // It refuses on UNDECIDED failures only. An intended difference — the Gate 4 contract renamed
  // a field, a bug was deliberately not reproduced — is legitimate and expected; it just has to
  // be on the record. `npm run equiv -- accept "<trace>" --reason "..."` writes that record, and
  // this check reads it. So the gate is not "every trace green", it is "every red trace
  // explained", which is the same standard the readiness checklist applies to everything else.
  //
  // Zero-dependency by the same rule as the rest of this file: the JUnit is regex-read for
  // failing testcase names (acsuite.mjs makes the same argument about JUnit's fixed shape), and
  // the decision log is markdown with one machine-readable token per accepted trace.
  // ---------------------------------------------------------------------------
  if (id === "gate-5") {
    const parityDir = "parity";
    const runs = existsSync(parityDir)
      ? readdirSync(parityDir).map(String)
          .map((f) => /^(\d{4}-\d{2}-\d{2})-equiv\.xml$/.exec(f))
          .filter(Boolean).map((m) => ({ date: m[1], path: join(parityDir, m[0]) }))
          .sort((a, b) => (a.date < b.date ? 1 : -1))
      : [];
    if (runs.length) {
      const xml = readFileSync(runs[0].path, "utf8");
      // One chunk per <testcase>, so a <failure> is attributed to the case that contained it.
      const failing = xml.split(/<testcase\b/).slice(1)
        .map((chunk) => {
          const end = chunk.indexOf("</testcase>");
          const body = end === -1 ? chunk : chunk.slice(0, end);
          return { name: (body.match(/\bname="([^"]*)"/) || [])[1] || "(unnamed)", failed: /<(failure|error)\b/.test(body) };
        })
        .filter((c) => c.failed).map((c) => c.name);
      if (failing.length) {
        const log = join("parity", "equiv", "DECISIONS.md");
        const decisions = existsSync(log) ? readFileSync(log, "utf8") : "";
        const accepted = new Set([...decisions.matchAll(/^\s*-\s*accepted:\s*`([^`]+)`/gm)].map((m) => m[1]));
        const undecided = failing.filter((n) => !accepted.has(n));
        if (undecided.length) {
          console.error(`Cannot lock ${id}: the newest equivalence run (${runs[0].path}) has ` +
            `${undecided.length} failing trace(s) that no decision explains:\n` +
            undecided.map((n) => `  - ${n}`).join("\n") +
            `\n\n  A red trace means the rebuild returns something the legacy system did not, on ` +
            `traffic recorded from the legacy system before the rebuild existed. Gate 5 is ` +
            `terminal — nothing after it catches this.` +
            `\n  Fix the difference and re-run \`npm run equiv -- replay --all\`, or, if the ` +
            `difference is intended, put it on the record:` +
            `\n    npm run equiv -- accept "<trace name>" --reason "..."` +
            `\n  Accepting does not make the trace green. It makes it explained, which is all this ` +
            `gate asks of anything else that is still imperfect.`);
          process.exit(1);
        }
        console.log(`Equivalence: ${failing.length} red trace(s) in ${runs[0].path}, all named in ` +
          `parity/equiv/DECISIONS.md. Locking.`);
      }
    }
  }

  // artifact_hashes below is computed from the WORKING TREE, but the lock commit further
  // down stages only the lock file itself. If any protected (or other) file is dirty, the
  // hash recorded here describes content that never lands in the gate-tagged commit — a
  // code repo pinning that tag then gets the OLD file while the lock claims the NEW hash.
  // Refuse rather than let that drift through silently. (Not `git add -A`: sweeping in
  // unrelated in-progress work would land it in a "gate-N: locked" commit uninvited.)
  const lockPath = join(LOCKS, `${id}.yaml`);
  try {
    const dirty = execSync("git status --porcelain", { encoding: "utf8" })
      .split("\n").filter(Boolean).map((l) => l.slice(3).trim())
      .filter((f) => f !== lockPath);
    if (dirty.length) {
      console.error(`Cannot lock ${id}: working tree has uncommitted changes outside ${lockPath}:\n` +
        dirty.map((f) => `  ${f}`).join("\n") +
        `\nCommit or stash these first, then lock — otherwise the hashes recorded would not match ` +
        `what the gate tag actually points at.`);
      process.exit(1);
    }
  } catch { /* git unavailable — same fallback as the commit/tag step below */ }

  // Union in anything this gate must protect that its scaffolded `protects:` predates.
  // Absent directories contribute no files and no hashes, so a project with no Rule Cards
  // locks exactly as it did before — the line appears in the lock file and protects an
  // empty set, which is the correct description of that project.
  const protects = [...new Set([...lock.protects, ...(REQUIRED_PROTECTS[id] || [])])];
  const added = protects.filter((p) => !lock.protects.includes(p));
  if (added.length) {
    console.log(`Adding to ${id} protects: ${added.join(", ")} ` +
      `(required by this plugin version; this workbench was scaffolded before it).`);
  }

  const hashes = protects.flatMap(filesUnder).map((f) => `  ${f}: ${sha(f)}`);
  if (!hashes.length) { console.error(`Nothing to lock: no files under ${protects.join(", ")}`); process.exit(1); }
  const by = argAfter("--by") || process.env.USER || "unknown";
  const history = lock.text.includes("history: []")
    ? `history:\n  - action: locked\n    at: ${now}\n    reason: ${yamlStr("gate review approved")}`
    : lock.text.match(/history:[\s\S]*$/)[0].trimEnd() + `\n  - action: locked\n    at: ${now}\n    reason: ${yamlStr("gate review approved")}`;
  writeFileSync(join(LOCKS, `${id}.yaml`),
`gate: ${id}
title: ${yamlStr(lock.title)}
status: locked
locked_at: ${now}
locked_by: ${yamlStr(by)}
protects:
${protects.map((p) => `  - ${p}`).join("\n")}
artifact_hashes:
${hashes.join("\n")}
${history}
`);
  try {
    // Gate tags are IMMUTABLE and versioned: each lock mints the next vN and never moves
    // an existing one.
    //
    // This used to be `git tag -f ${id}/v1`, and force-moving it was a real hazard rather
    // than a tidiness question. Code repos consume this workbench as a submodule pinned by
    // COMMIT, and resolve that pin's name with `git describe --exact-match`. A submodule
    // clone that had already fetched `gate-4/v1` kept resolving it to the OLD commit after
    // a reopen, so the consumer's contract-sync reported success while pinning the previous
    // contract — the exact drift that ceremony exists to make impossible. Found during S9
    // stage 4 (plan/backlog.md); nothing was mis-synced only because neither reopen that
    // day touched openapi.yaml.
    //
    // A moving `latest` alias was rejected for the same reason: any mutable ref reintroduces
    // "the name resolves differently depending on when you last fetched".
    const existing = execSync(`git tag -l "${id}/v*"`, { encoding: "utf8" })
      .split("\n").map((t) => t.trim()).filter(Boolean);
    const next = 1 + existing.reduce((max, t) => {
      const n = Number(t.slice(`${id}/v`.length));
      return Number.isInteger(n) && n > max ? n : max;
    }, 0);
    const tag = `${id}/v${next}`;
    execSync(`git add ${LOCKS}/${id}.yaml && git commit -qm "${id}: locked" && git tag ${tag}`, { stdio: "pipe" });
    console.log(`${id} locked, committed, tagged ${tag}.`);
    // The commit and the tag are both local until pushed, and nothing in this pipeline pushes
    // on anyone's behalf. Two traps make it worth spelling out here, at the moment of locking,
    // rather than trusting a doc step:
    //   - `git push` alone sends no tags at all, so the commit lands and the pin does not. A
    //     code repo then gets `pathspec '${tag}' did not match` from its submodule checkout —
    //     or, worse, silently stays on the previous vN and keeps building against the old
    //     contract, which is exactly the drift the immutable-tag scheme exists to prevent.
    //   - `--follow-tags` looks like the fix and is not: it pushes annotated tags only, and
    //     these are lightweight (`git tag ${tag}`). Naming a command that quietly does nothing
    //     would be worse than naming none.
    console.log(`      Push both now — the tag is a submodule pin, not a label:`);
    console.log(`        git push && git push --tags`);
    if (next > 1) {
      console.log(`NOTE: ${tag} is a NEW tag — ${id}/v${next - 1} still points at the previous lock.`);
      console.log(`      Every code repo pinning this gate must re-pin deliberately (after the push above):`);
      console.log(`        git -C <submodule> fetch --tags && git -C <submodule> checkout --detach ${tag}`);
      console.log(`      A repo that does not re-pin keeps building against the older contract,`);
      console.log(`      which is now visible rather than silent.`);
    }
  } catch { console.log(`${id} locked. Commit and tag manually (git unavailable or dirty tree).`); }
  process.exit(0);
}

if (cmd === "reopen") {
  const reason = argAfter("--reason");
  if (!reason) { console.error("Reopening requires --reason \"...\" — it is a formal, logged event."); process.exit(1); }
  const body = lock.text
    .replace(/^status: locked$/m, "status: open")
    .replace(/^locked_at: .*$\n/m, "").replace(/^locked_by: .*$\n/m, "")
    .replace(/^artifact_hashes:[\s\S]*?(?=history:)/m, "")
    .trimEnd() + `\n  - action: reopened\n    at: ${now}\n    reason: ${yamlStr(reason)}\n`;
  writeFileSync(join(LOCKS, `${id}.yaml`), body);
  console.log(`${id} reopened: ${reason}\nRemember: downstream artifacts built on this gate may now be stale.`);
  process.exit(0);
}

console.error("Usage: gate.mjs status | lock <gate-id> [--by <name>] | reopen <gate-id> --reason \"...\"");
process.exit(1);
