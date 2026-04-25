// eval/summarize.mjs — replay existing JSONL with the shared aggregation logic.
// Usage:
//   node --experimental-strip-types --no-warnings eval/summarize.mjs
//   node --experimental-strip-types --no-warnings eval/summarize.mjs path/to/run.jsonl

import { aggregate, groupMismatches, loadLatestResults, renderSummary } from "./lib.mjs";

const { path, rows } = loadLatestResults("eval/results", process.argv[2] ?? null);
console.log(`Replayed ${rows.length} rows from ${path}`);

const byModel = aggregate(rows);
// showInvariant adds a `Σ err = total - correct` check column — useful when
// replaying historical runs to catch off-by-one or asymmetric-condition bugs.
renderSummary(byModel, { showInvariant: true });

console.log("\n### All other mismatches\n");
for (const [model, m] of byModel) {
  const other = [...m.false_mod, ...m.false_unsure, ...m.uncategorized];
  if (other.length === 0) {
    console.log(`**${model.split("/").pop()}** — no mismatches`);
    continue;
  }
  console.log(
    `\n**${model.split("/").pop()}** — ${other.length} mismatches (all fail-safe direction)`,
  );
  for (const g of groupMismatches(other)) {
    console.log(`  [${g.count}/3] ${g.key}`);
    console.log(`         cmd: \`${g.sample.command}\``);
  }
}
