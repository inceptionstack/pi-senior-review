# Bash Classifier Model Eval — Results (v1 prompt)

**Date:** 2026-04-25
**Run ID:** `run-2026-04-25T17-26-29-631Z.jsonl`
**Wall clock:** 228s (≈4 min)
**Scope:** 35 fixtures × 3 models × 3 repeats = **315 calls**

> **Revision note (2026-04-25):** Replayed from the original JSONL with corrected
> metric code. The original harness summary under-counted some mismatches
> (False-Mod and False-Unsure had asymmetric conditions that let `expected=unsure,
> got=modifying` fall through). Kill-metric numbers are unchanged (still zero
> false-noops for all three models); qualitative recommendation is unchanged.
> Corrected metrics reconciled via `eval/summarize.mjs` — all three rows now
> satisfy the invariant `False-NoOp + False-Mod + False-Unsure = Total - Correct`.

## Summary table

| Model | N | Acc | **False-NoOp** (kill) | False-Mod | False-Unsure | JSON valid | p50 | p95 | Errors |
|---|---|---|---|---|---|---|---|---|---|
| `us.anthropic.claude-haiku-4-5-20251001-v1:0` | 105 | **100.0%** | **0** | 0 | 0 | 100% | 922ms | 1228ms | 0 |
| `amazon.nova-micro-v1:0` | 105 | 96.2% | **0** | 4 | 0 | 100% | 253ms | 291ms | 0 |
| `amazon.nova-lite-v1:0` | 105 | 94.3% | **0** | 6 | 0 | 100% | 301ms | 401ms | 0 |

> Metric definitions (symmetric): **False-NoOp** = classified `inspection_vcs_noop` when expected wasn't (the KILL metric — this is the unsafe direction). **False-Mod** = classified `modifying` when expected wasn't (safe direction, over-reviews). **False-Unsure** = classified `unsure` when expected concrete (safe direction, fails open).
>
> Invariant: `False-NoOp + False-Mod + False-Unsure = Total - Correct`. Verified by `eval/summarize.mjs`.

**Headline: all three models cleared the kill metric (zero false-noops). Every mismatch was in the safe direction** (classified a command as stricter than expected → fail-open to "run the review").

## Per-model notes

### `us.anthropic.claude-haiku-4-5` — 100% accuracy
Perfect on all 105 runs including **3/3 on today's bug repro** (`git status && echo "---" && git log`). Zero JSON issues, no markdown fences, strictly follows the schema.

**Cost:** ~$1/M input, ~$5/M output. Most expensive of the three.

### `amazon.nova-micro-v1:0` — 96.2% accuracy, fastest
- `npm run custom-thing` (unknown npm script) → classified `modifying` (3/3). Expected `unsure`. **Safe direction** but overcautious.
- **`git status && echo "---" && git log` → 2/3 correct, 1 wrong** (classified `modifying`). That's the exact bug scenario we're designing for; Nova Micro trips on it 33% of the time. It's safe (we'd just over-review like today), but it defeats the classifier's value-add on the one case that matters.
- **Total: 4 mismatches, all in the safe direction.** Breakdown: 3 × `npm run custom-thing` + 1 × `git status && echo "---" && git log` — all `got=modifying` when something softer was expected.

**Cost:** ~$0.035/M input, ~$0.14/M output. **~35× cheaper than Haiku 4.5.**

### `amazon.nova-lite-v1:0` — 94.3% accuracy
- `npm run custom-thing` → `modifying` (3/3). Same as Nova Micro.
- `./bin/custom-build --verbose` → `modifying` (3/3). Expected `unsure`. Safe direction.
- **Correctly handled today's bug case 3/3.**
- **Total: 6 mismatches, all `got=modifying` when `expected=unsure`.** All in the safe direction.
- Wraps output in ```` ```json ... ``` ```` fences (parser handles it, but shows weaker instruction-following than Haiku or Micro).

**Cost:** ~$0.06/M input, ~$0.24/M output. ~20× cheaper than Haiku.

## Key qualitative findings

1. **"Unknown script → unsure" is the hardest class for Nova models.** They default to `modifying` for unknown scripts like `npm run custom-thing` or `./bin/custom-build`. This is technically wrong per our taxonomy but operationally fine — it means we over-review rather than under-review.

2. **Nova Micro is unreliable on the target scenario.** The 1/3 flip on `git status && echo "---" && git log` means Nova Micro would only deliver the bug-fix value we want ~67% of the time. The other 33%, it'd classify the compound as `modifying` and trigger the redundant review we were trying to prevent.

3. **JSON validity is not a differentiator at v1.** All three models hit 100% parse rate. Nova Lite's fenced output adds a few bytes of parse work but isn't a reliability issue.

4. **Latency**: All three well under the p95 < 3s bar. Nova Micro is 3× faster than Haiku but that difference (0.3s vs 1.2s) is noise against the 30-60s main reviewer.

5. **Cost**: On ~100 ambiguous-bash turns/day at 100 input + 20 output tokens per call, monthly cost is roughly:
   - Haiku 4.5: ~$0.04
   - Nova Lite: ~$0.002
   - Nova Micro: ~$0.001

   All three are effectively free at realistic usage. **Cost should not drive this decision.**

## Recommendation

**Use `us.anthropic.claude-haiku-4-5-20251001-v1:0`.**

Reasoning:
- It's the only model that correctly classifies today's bug scenario **every time** (3/3).
- 100% accuracy across the full 105-run grid.
- p95 latency of 1.2s is trivial against the main reviewer's 30-60s cost.
- Monthly cost delta vs Nova variants is measured in cents. Not worth the accuracy drop.
- Zero false-noops, zero JSON issues, zero errors.

**Runner-up: Nova Lite.** Comparable accuracy on critical cases, 3× faster, 20× cheaper. Use if Bedrock us-east Haiku is throttled or unavailable. **Do NOT use Nova Micro** — its 33% flip rate on the exact target scenario makes it unfit for purpose.

## Production next steps (NOT done today, per plan)

Per v2 plan:

1. **Shadow mode first.** Run the classifier in production, log its classifications, but don't suppress any reviews. Collect 1-2 weeks of real data; feed any misclassifications back as new fixtures.
2. **Deterministic gates stay authoritative.** Classifier verdict is *one of several* inputs to the skip decision. Alone it can't cause a skip.
3. **Vitest tests with mocked classifier.** Add the orchestration tests codex outlined (skip-possible deterministic gate, fail-open on timeout, etc.).
4. **Kill switch in settings.** `judgeEnabled: false` must be a one-flip disable.
5. Only after shadow mode shows no surprises → enable `skip` behind the gate chain.

## Disclaimers

- **Statistical reach**: 315 calls is a smoke test, not proof. The kill-metric pass is encouraging but does not prove <1% false-noop rate. Real confidence comes from shadow-mode production telemetry.
- **Dev-set only**: Although our fixtures include held-out cases (`ho-*`), the prompt was tuned with all 35 in mind. No prompt iteration happened (v1 passed), so test-set leakage is minimal, but still worth noting.
- **Single prompt version**: v1 cleared the bar for Haiku 4.5; no iteration attempted. If the bar were tighter (e.g. require Nova Micro to hit 100% on the target scenario), we'd iterate per the v2 plan's prompt-iteration budget.
