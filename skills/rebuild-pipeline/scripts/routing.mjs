#!/usr/bin/env node
// routing.mjs — resolves which MODEL each pipeline subagent runs on. Run from the workbench root.
// Usage:
//   node scripts/routing.mjs                     # all four roles, as JSON
//   node scripts/routing.mjs --role miner        # one role
//   node scripts/routing.mjs --agents <dir>      # read effort pins from real agent frontmatter
//
// WHY THIS EXISTS
//
// subagent-briefs.md carried the routing rule as prose — "extraction → low tier; merge/spec →
// mid; ADR drafting → high" — and the judge brief said "route it to a high tier". Neither had a
// mechanism behind it, and the four agent files carried no `model:` at all, so every dispatch
// inherited whatever model the orchestrator session happened to be running. The G1 fan-out, the
// rubric score at every gate, and every module spec all ran on one model, usually opus, and the
// prose rule describing otherwise was true of nothing.
//
// Pinning `model:` in the agent frontmatter fixed the inheritance but replaced it with a
// constant: a pin is not a decision a project can make. This script is that decision. It maps
// each ROLE to a tier, resolves the tier to a model through the project's chosen ladder, and
// prints what the orchestrator passes as `model:` on the Agent call.
//
// THE LADDER IS BIGIN-SKILLS' LADDER
//
// The two profiles below mirror `bigin-skills`' `model-router` ladder as of bigin-skills v1.105.0
// (`balanced` and `frontier`, over three tiers: worker · architect · verifier). Its
// `references/model-profiles.md` — in that plugin, not this one — is the source of truth for
// what each profile means and why).
// They are COPIED, not imported: this plugin has to work in a repo where bigin-skills is not
// installed, and reaching across plugin roots would make a rebuild project's dispatch depend on
// an unrelated install. The cost is that the two tables can drift — if you change one, change
// both, and the profile semantics live in bigin's file, not this comment.
//
// What is NOT copied is the tier assignment. model-router SCORES a task to pick a tier; here the
// roles are fixed and so are their tiers, mapped once in ROLE_TIERS by what each role's errors
// cost. There is nothing to score per dispatch.
//
// WHY EFFORT DOES NOT MOVE
//
// Effort cannot be passed at spawn time (the Agent tool has no effort parameter), so it comes
// only from the spawned agent file's frontmatter. bigin-skills solves that by duplicating agent
// files at different pins — `worker-frontier`, `architect-frontier` — with a pre-commit check
// to stop the bodies drifting apart.
//
// This pipeline deliberately does not. For a FIXED role, the argument that set its effort is
// about what its mistakes cost, and that argument does not change when a project wants cheaper
// models: a miner's omissions are just as invisible on a tight budget as on a loose one. So a
// profile here moves the MODEL and leaves effort where each role's own reasoning put it. Where
// the chosen profile's tier effort disagrees with a role's pin, that shows up in `warnings`
// rather than silently, and buying the saving back means overriding the model. Two such
// disagreements are EXPECTED and not a problem to fix: under the default `balanced` the
// architect tier runs at medium while spec-writer and adr-drafter are pinned high, and under
// `frontier` the worker tier runs at medium while miner and rubric-judge are pinned high. No role
// is on the verifier tier; it is resolved only so a `models.verifier` key stays valid.
//
// CONFIG
//
//   <workbench>/.claude/model-routing.json
//   { "profile": "frontier", "models": { "miner": "haiku", "architect": "fable" } }
//
// `profile` picks a ladder; `models` overrides on top of it and accepts either a TIER key
// (worker · architect · verifier) or a ROLE key (miner · rubric-judge · spec-writer ·
// adr-drafter), with a role key winning over the tier it belongs to. Per-role exists because the
// most likely real override in this pipeline is a single role: G1 dispatches miners many at a
// time and nothing else in the pipeline fans out like it. Fable is in no profile; it is reachable
// only as an override (a tier or role key set to "fable").
//
// There are no aliases for the pre-0.22.0 names. An old profile (`opus-centric`, `lean`) or tier
// key (`quick`, `standard`, `deep`) is an unknown value like any other: default plus a warning.
//
// Every malformed input — bad JSON, unknown profile, unknown key, unknown model — degrades to
// the default and is listed in `warnings`. This file can never block a dispatch, for the same
// reason a bad rubric score can never block a lock: a stalled pipeline is a worse failure than a
// wrong-but-visible default. RELAY NON-EMPTY WARNINGS TO THE USER — a config the user believes
// is active but is not is worse than no config at all.

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const CONFIG = ".claude/model-routing.json";
const DEFAULT_PROFILE = "balanced";

// Mirrors bigin-skills/skills/model-router — see THE LADDER IS BIGIN-SKILLS' LADDER above.
const PROFILES = {
  balanced: { worker: "sonnet", architect: "opus", verifier: "sonnet" },
  frontier: { worker: "opus", architect: "opus", verifier: "sonnet" },
};

// Informational only — used to report where a profile's effort disagrees with a role's pin.
const PROFILE_EFFORTS = {
  balanced: { worker: "high", architect: "medium", verifier: "high" },
  frontier: { worker: "medium", architect: "high", verifier: "high" },
};

const MODELS = new Set(["fable", "opus", "sonnet", "haiku"]);
const TIERS = Object.keys(PROFILES[DEFAULT_PROFILE]);

// Each role's tier, and WHY that rung — the rationale belongs next to the mapping, because the
// mapping is the only place it is load-bearing.
const ROLE_TIERS = {
  miner: {
    tier: "worker",
    why: "extraction against a fixed finding schema, one lane and source per dispatch; the largest fan-out in the pipeline, so it runs on the volume tier. Omissions are the real error, which is why its effort pin stays high.",
  },
  "rubric-judge": {
    tier: "worker",
    why: "scoring against a stated rubric; the report is advisory, so a bad score costs a human read rather than a wrong artifact. Omission-hunting is what its high effort pin buys.",
  },
  "spec-writer": {
    tier: "architect",
    why: "a module spec's acceptance criteria are what every build lane and the parity check are held to, so a gap or a wrong criterion propagates through the slice like a structural call.",
  },
  "adr-drafter": {
    tier: "architect",
    why: "architecture decisions, and a wrong structural call propagates into every slice built on it.",
  },
};

// Fallback effort pins, used only when the agent files cannot be located. Kept in sync with
// agents/*.md frontmatter; --agents reads the real thing and makes this table irrelevant.
const PIN_FALLBACK = {
  miner: "high",
  "rubric-judge": "high",
  "spec-writer": "high",
  "adr-drafter": "high",
};

// --- effort pins, from the agent files themselves where we can reach them ---

function readPins(agentsDir, warnings) {
  if (!agentsDir) return { pins: { ...PIN_FALLBACK }, source: "fallback-table" };
  let files;
  try {
    files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch (err) {
    warnings.push(`could not read agents dir ${agentsDir} (${err.message}) — using this script's pin table`);
    return { pins: { ...PIN_FALLBACK }, source: "fallback-table" };
  }
  const pins = {};
  for (const f of files) {
    const role = f.replace(/\.md$/, "");
    if (!Object.hasOwn(ROLE_TIERS, role)) continue;
    const text = readFileSync(join(agentsDir, f), "utf8");
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    const effort = fm && /^effort:\s*(\S+)\s*$/m.exec(fm[1]);
    if (effort) pins[role] = effort[1];
    else warnings.push(`${f} declares no effort: — it will run at the model's default`);
  }
  for (const role of Object.keys(ROLE_TIERS)) {
    if (!Object.hasOwn(pins, role)) {
      warnings.push(`no agent file found for role "${role}" in ${agentsDir} — using this script's pin table`);
      pins[role] = PIN_FALLBACK[role];
    }
  }
  return { pins, source: agentsDir };
}

// --- config ---

function loadConfig(root, warnings) {
  const path = join(root, CONFIG);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { profile: DEFAULT_PROFILE, models: {}, source: "default" };
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    warnings.push(`${CONFIG} is not valid JSON (${err.message}) — using the ${DEFAULT_PROFILE} default`);
    return { profile: DEFAULT_PROFILE, models: {}, source: "default" };
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    warnings.push(`${CONFIG} must be a JSON object — using the ${DEFAULT_PROFILE} default`);
    return { profile: DEFAULT_PROFILE, models: {}, source: "default" };
  }

  let profile = DEFAULT_PROFILE;
  if (config.profile !== undefined) {
    if (Object.hasOwn(PROFILES, config.profile)) profile = config.profile;
    else
      warnings.push(
        `unknown profile "${config.profile}" in ${CONFIG} (known: ${Object.keys(PROFILES).join(", ")}) — using ${DEFAULT_PROFILE}`
      );
  }

  const models = {};
  if (config.models !== undefined) {
    if (config.models === null || typeof config.models !== "object" || Array.isArray(config.models)) {
      warnings.push(`${CONFIG} "models" must be an object of key → model — ignored`);
    } else {
      for (const [key, model] of Object.entries(config.models)) {
        const isTier = TIERS.includes(key);
        const isRole = Object.hasOwn(ROLE_TIERS, key);
        if (!isTier && !isRole) {
          warnings.push(
            `unknown key "${key}" in ${CONFIG} "models" (tiers: ${TIERS.join(" · ")}; roles: ${Object.keys(ROLE_TIERS).join(" · ")}) — ignored`
          );
          continue;
        }
        if (!MODELS.has(model)) {
          warnings.push(`unknown model "${model}" for "${key}" in ${CONFIG} (known: ${[...MODELS].join(" · ")}) — ignored`);
          continue;
        }
        models[key] = model;
      }
    }
  }

  if (config.effort !== undefined)
    warnings.push(
      `effort is not settable in ${CONFIG} — it comes from the spawned agent's frontmatter and the Agent tool has no effort parameter. See WHY EFFORT DOES NOT MOVE in scripts/routing.mjs.`
    );

  return { profile, models, source: "config" };
}

// --- resolve ---

function resolve_(root, agentsDir) {
  const warnings = [];
  const { profile, models, source } = loadConfig(root, warnings);
  const { pins, source: pinSource } = readPins(agentsDir, warnings);
  const ladder = PROFILES[profile];

  const roles = {};
  for (const [role, { tier, why }] of Object.entries(ROLE_TIERS)) {
    let model = ladder[tier];
    let from = `profile:${profile}`;
    if (Object.hasOwn(models, tier)) {
      model = models[tier];
      from = `override:tier:${tier}`;
    }
    if (Object.hasOwn(models, role)) {
      model = models[role];
      from = `override:role:${role}`;
    }

    const effort = pins[role];
    const ladderEffort = PROFILE_EFFORTS[profile][tier];

    // Haiku 4.5 accepts no effort level, so a role routed to it runs with its pin inert. Not an
    // error — but on a role whose whole argument for `high` was that its mistakes are omissions,
    // giving up effort control is the thing you would most want said out loud.
    if (model === "haiku")
      warnings.push(
        `${role} resolves to haiku, which accepts no effort level — its effort: ${effort} pin is inert on this dispatch.`
      );
    if (effort !== ladderEffort) {
      warnings.push(
        `${role} runs at effort ${effort} (its agent file's pin); the ${profile} ladder puts the ${tier} tier at ${ladderEffort}. ` +
          `Effort is not movable here by design — override the model if you need the saving.`
      );
    }

    roles[role] = { tier, model, effort, modelFrom: from, why };
  }

  return { profile, profileSource: source, effortSource: pinSource, roles, warnings };
}

// --- cli ---

const argv = process.argv.slice(2);
const arg = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};

const root = arg("--root") ?? process.cwd();
const agentsDir =
  arg("--agents") ??
  (process.env.CLAUDE_PLUGIN_ROOT ? join(process.env.CLAUDE_PLUGIN_ROOT, "agents") : undefined);

const out = resolve_(resolve(root), agentsDir ? resolve(agentsDir) : undefined);

const only = arg("--role");
if (only !== undefined) {
  if (!Object.hasOwn(out.roles, only)) {
    console.error(`unknown role "${only}" — known: ${Object.keys(ROLE_TIERS).join(" · ")}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ ...out, roles: { [only]: out.roles[only] } }, null, 2));
} else {
  console.log(JSON.stringify(out, null, 2));
}

export { PROFILES, PROFILE_EFFORTS, ROLE_TIERS, MODELS, TIERS, DEFAULT_PROFILE };
