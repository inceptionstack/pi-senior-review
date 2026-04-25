// eval/analyze.mjs — per-fixture breakdown of mismatches.
// Uses lib.mjs so its bucketing matches run-eval.mjs / summarize.mjs exactly.

import { aggregate, groupMismatches, loadLatestResults } from "./lib.mjs";

const { rows } = loadLatestResults();
const byModel = aggregate(rows);

console.log(`\n=== All mismatches (non-correct classifications) ===\n`);
for (const [model, m] of byModel) {
  const mismatches = [...m.false_noop, ...m.false_mod, ...m.false_unsure, ...m.uncategorized];
  const key = model.split("/").pop();
  console.log(`\n**${key}** — ${mismatches.length} mismatches out of ${m.total}`);
  if (mismatches.length === 0) continue;
  for (const g of groupMismatches(mismatches)) {
    const s = g.sample;
    // `(s.raw ?? "")` guards against `ok: false` rows that have no `raw` field.
    // Previously `s.raw?.slice(0, 80).replace(...)` crashed because `?.` only
    // short-circuits the slice call, not the chained replace.
    const rawSnippet = (s.raw ?? "").slice(0, 80).replace(/\n/g, " ");
    console.log(`  [${g.count}/3] ${g.key}`);
    console.log(`         cmd: \`${s.command}\``);
    console.log(`         raw: ${rawSnippet}`);
  }
}

// Per-fixture agreement matrix — spotlight any fixture where any model disagreed.
console.log(`\n\n=== Per-fixture consistency (where any model disagreed) ===\n`);
const fixtures = [...new Set(rows.map((r) => r.fixture_id))];
for (const fid of fixtures) {
  const fRows = rows.filter((r) => r.fixture_id === fid);
  const expected = fRows[0].expected;
  const verdicts = new Map();
  for (const r of fRows) {
    const k = r.model.split("/").pop();
    if (!verdicts.has(k)) verdicts.set(k, []);
    verdicts.get(k).push(r.classification);
  }
  const allCorrect = [...verdicts.values()].every((cs) => cs.every((c) => c === expected));
  if (!allCorrect) {
    console.log(`${fid} (expected=${expected}) cmd=\`${fRows[0].command}\``);
    for (const [m, cs] of verdicts) {
      const cor = cs.filter((c) => c === expected).length;
      console.log(`  ${m.slice(0, 32).padEnd(32)} ${cs.join(",")}  (${cor}/${cs.length} correct)`);
    }
  }
}
