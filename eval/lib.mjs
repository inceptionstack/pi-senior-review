// eval/lib.mjs — shared helpers used by run-eval / summarize / analyze.
// Centralized so metric conditions, JSONL loading, and mismatch grouping
// live in exactly one place.

import { readdirSync, readFileSync } from "node:fs";

export const CLASSES = ["inspection_vcs_noop", "modifying", "unsure"];

/**
 * Compute per-model aggregates from a flat array of result rows.
 *
 * Each row must have: { model, classification, expected, ok, json_valid, latency }
 *
 * Invariant: for every model,
 *   false_noop.length + false_mod.length + false_unsure.length + uncategorized.length
 *     === total - correct
 *
 * Buckets are symmetric (each captures "got CLASS when expected wasn't CLASS").
 * The `uncategorized` bucket catches mismatches whose classification is NOT in
 * {inspection_vcs_noop, modifying, unsure} — for future enum additions or
 * parser bugs that emit unexpected values. Should be empty in practice.
 */
export function aggregate(rows) {
  const byModel = new Map();
  for (const r of rows) {
    const m =
      byModel.get(r.model) ??
      {
        total: 0,
        correct: 0,
        json_valid: 0,
        errors: 0,
        latencies: [],
        false_noop: [], //    got=inspection_vcs_noop, expected=(modifying|unsure)
        false_mod: [], //     got=modifying,           expected=(inspection_vcs_noop|unsure)
        false_unsure: [], //  got=unsure,              expected=(inspection_vcs_noop|modifying)
        uncategorized: [], // got=<unknown>,           expected=anything  (invariant-preserving catch-all)
      };
    byModel.set(r.model, m);

    m.total++;
    if (!r.ok) m.errors++;
    if (r.json_valid) m.json_valid++;
    if (r.latency != null) m.latencies.push(r.latency);

    if (r.classification === r.expected) {
      m.correct++;
    } else if (r.classification === "inspection_vcs_noop" && r.expected !== "inspection_vcs_noop") {
      m.false_noop.push(r);
    } else if (r.classification === "modifying" && r.expected !== "modifying") {
      m.false_mod.push(r);
    } else if (r.classification === "unsure" && r.expected !== "unsure") {
      m.false_unsure.push(r);
    } else {
      // Classification is not one of CLASSES — future enum, parser regression,
      // or corrupted row. Keep the invariant by bucketing explicitly.
      m.uncategorized.push(r);
    }
  }
  return byModel;
}

/** Percentile of a numeric array (`pct` in [0,1]). Returns 0 for empty input.
 *  Clamps index so `pct=1.0` returns the max rather than an out-of-bounds undefined. */
export function percentile(arr, pct) {
  if (!arr || arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(Math.max(0, Math.floor(s.length * pct)), s.length - 1);
  return s[idx];
}

/**
 * Render the standard markdown summary table + KILL-metric breakdown to
 * console.log. Shared between run-eval.mjs (after a live run) and summarize.mjs
 * (replaying existing JSONL) so the two report formats can never drift.
 *
 * `showInvariant: true` adds a `Σ err = total - correct` check column (useful
 * when replaying; less useful in a fresh run).
 */
export function renderSummary(byModel, { showInvariant = false } = {}) {
  const header = showInvariant
    ? "| Model | N | Acc | False-NoOp | False-Mod | False-Unsure | Uncat | Σ err | JSONvalid | p50 | p95 | Errors |"
    : "| Model | N | Acc | False-NoOp | False-Mod | False-Unsure | JSONvalid | p50 | p95 | Errors |";
  const sep = showInvariant
    ? "|---|---|---|---|---|---|---|---|---|---|---|---|"
    : "|---|---|---|---|---|---|---|---|---|---|";
  console.log("\n## Results summary\n");
  console.log(header);
  console.log(sep);
  for (const [model, m] of byModel) {
    const shortId = model.split("/").pop().slice(0, 38);
    const acc = ((m.correct / m.total) * 100).toFixed(1);
    const jv = ((m.json_valid / m.total) * 100).toFixed(0);
    const p50 = percentile(m.latencies, 0.5);
    const p95 = percentile(m.latencies, 0.95);
    const cells = [
      `\`${shortId}\``,
      m.total,
      `${acc}%`,
      `**${m.false_noop.length}**`,
      m.false_mod.length,
      m.false_unsure.length,
    ];
    if (showInvariant) {
      const sumErr =
        m.false_noop.length + m.false_mod.length + m.false_unsure.length + m.uncategorized.length;
      const ok = sumErr === m.total - m.correct ? "✓" : `✗ (exp ${m.total - m.correct})`;
      cells.push(m.uncategorized.length, `${sumErr} ${ok}`);
    }
    cells.push(`${jv}%`, `${p50}ms`, `${p95}ms`, m.errors);
    console.log("| " + cells.join(" | ") + " |");
  }

  console.log("\n### False-noop details (KILL METRIC)\n");
  for (const [model, m] of byModel) {
    if (m.false_noop.length > 0) {
      console.log(`\n**${model.split("/").pop()}** — ${m.false_noop.length} false-noops`);
      for (const r of m.false_noop) {
        console.log(
          `- [${r.fixture_id}/${r.split}] expected=${r.expected} got=inspection_vcs_noop | cmd: \`${r.command}\``,
        );
      }
    } else {
      console.log(`**${model.split("/").pop()}** — zero false-noops ✓`);
    }
  }
}

/**
 * Load the newest run-*.jsonl from `dir` (defaults to eval/results).
 * If `pathOverride` is provided, loads that exact file instead.
 * Returns `{ path, rows }`. Exits the process if nothing to load.
 */
export function loadLatestResults(dir = "eval/results", pathOverride = null) {
  let path = pathOverride;
  if (!path) {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
    const latest = files[files.length - 1];
    if (!latest) {
      console.error(`No .jsonl files found in ${dir}. Run eval/run-eval.mjs first.`);
      process.exit(1);
    }
    path = `${dir}/${latest}`;
  }
  const rows = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
  return { path, rows };
}

/**
 * Group mismatches by a composite key and return `[{key, count, sample, rows}]`
 * entries sorted by key. Consumers use this to show `[N/3] fixture_id | ...`
 * style output without each reimplementing the grouping loop.
 */
export function groupMismatches(mismatches) {
  const groups = new Map();
  for (const r of mismatches) {
    const k = `${r.fixture_id} | expected=${r.expected} got=${r.classification}`;
    const g = groups.get(k) ?? { key: k, count: 0, sample: r, rows: [] };
    g.count++;
    g.rows.push(r);
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}
