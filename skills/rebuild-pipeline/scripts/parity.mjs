#!/usr/bin/env node
// parity.mjs — G6 parity report. Run from the workbench root.
// Diffs matrix feature statuses and writes parity/<date>.md.
// Feature `status` is maintained at slice completion (orchestrator updates it);
// this script aggregates, detects gaps, and lists upstream candidates.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { parse } from "yaml";

if (!existsSync("matrix/features.yaml")) { console.error("No matrix/features.yaml."); process.exit(1); }
const features = parse(readFileSync("matrix/features.yaml", "utf8")) || [];
const slices = existsSync("plan/slices.yaml") ? parse(readFileSync("plan/slices.yaml", "utf8")) || [] : [];

const by = (s) => features.filter((f) => (f.status || "planned") === s);
const buckets = {
  covered: by("covered"), partial: by("partial"),
  missing: by("missing"), planned: by("planned"),
  upstream: by("upstream-candidate"),
};
const doneSliceFeatures = new Set(slices.filter((s) => s.status === "done").flatMap((s) => s.features));
const suspicious = features.filter((f) => doneSliceFeatures.has(f.id) && (f.status || "planned") === "planned");

const date = new Date().toISOString().slice(0, 10);
const pct = features.length ? Math.round((buckets.covered.length / features.length) * 100) : 0;
const list = (arr) => arr.length ? arr.map((f) => `- ${f.id} ${f.name}`).join("\n") : "- none";

mkdirSync("parity", { recursive: true });
writeFileSync(`parity/${date}.md`, `# Parity report — ${date}

Coverage: ${buckets.covered.length}/${features.length} covered (${pct}%), ${buckets.partial.length} partial, ${buckets.missing.length} missing, ${buckets.planned.length} planned.

## Missing (in a done slice but not covered — investigate)
${list(suspicious)}

## Partial
${list(buckets.partial)}

## Upstream candidates (from re-mining — decide at next slice boundary)
${list(buckets.upstream)}

## Slice progress
${slices.map((s) => `- ${s.id} ${s.name}: ${s.status || "pending"}`).join("\n") || "- no slice plan yet"}
`);
console.log(`Wrote parity/${date}.md — coverage ${pct}%.`);
