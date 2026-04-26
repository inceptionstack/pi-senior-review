# Bash Classifier Model Eval Plan v2 - pi-hard-no

## Goal

Evaluate small Bedrock models for one narrow role:

> Given one bash command string plus truncated/sanitized args, return
> `{"classification":"inspection_vcs_noop"|"modifying"|"unsure"}`.

The model is a trinary bash classifier, not a review skipper. Deterministic gates decide whether review can be skipped.

## Design

Use deterministic gates first, then the LLM only for ambiguous bash commands:

```
agent_end
  -> deterministic gates:
     explicit edit/write/delete tools, changed hashes, last-reviewed hashes,
     content source trust, known safe allowlist, known modifying denylist
  -> LLM classifier for remaining ambiguous bash commands only
  -> deterministic final decision:
     any modifying/unsure => review
     all inspection_vcs_noop + hashes unchanged + files reviewed => may skip
```

Fail open: timeout, transport error, invalid JSON, unknown enum, or uncertainty maps to `unsure`, which means run the reviewer.

## What This Eval Can Prove

This eval can show whether a cheap model handles a curated set of ambiguous shell commands without obvious false-noops.

It cannot statistically prove broad safety. With 35 fixtures, 3 repeats, and 3 models, the run is 315 calls. Zero false-noops in that sample is useful smoke-test evidence, not a guarantee. The safety case still depends on deterministic gates, fail-open behavior, shadow mode, logging, and adding regressions when bugs appear.

## Execution Budget

Hard wall-clock budget: **25 minutes**.

Scope:

- 25 dev fixtures + 10 held-out fixtures = 35 total fixtures.
- 3 repeats per fixture across 3 models = `35 * 3 * 3 = 315` calls.
- At ~1-2s per call, expect about 10 minutes of model time plus harness overhead with modest concurrency.
- Remaining time covers startup, result writes, summary generation, and transient retry handling.

Do not scale to 500-1000 non-skip runs. That does not fit.

## Candidate Models

| Model      | Bedrock/pi model ID                               | Reason                                                   |
| ---------- | ------------------------------------------------- | -------------------------------------------------------- |
| Haiku 4.5  | `amazon-bedrock/us.anthropic.claude-haiku-4-5-v1` | Best expected instruction following and JSON discipline. |
| Nova Micro | `amazon-bedrock/amazon.nova-micro-v1:0`           | Cheapest and fastest; task may be narrow enough.         |
| Nova Lite  | `amazon-bedrock/amazon.nova-lite-v1:0`            | Slightly stronger fallback if Micro is sloppy.           |

Exclude Sonnet/Opus, larger models, and cross-provider models for this pass unless all three fail and the design still needs an LLM.

## Classifier Contract

Input:

```json
{ "command": "git status && echo \"---\" && git log --oneline -5", "args_truncated": false }
```

Output:

```json
{ "classification": "inspection_vcs_noop" }
```

Classes:

- `inspection_vcs_noop`: reads or reports state only; no file, index, branch, dependency, process, network, or environment mutation.
- `modifying`: may change files, git index, commits, branches, dependencies, generated artifacts, processes, services, remotes, permissions, caches, or environment state.
- `unsure`: ambiguous, truncated, unknown executable/script, hidden behavior through shell expansion, or not confidently classifiable.

JSON validity is tracked but not production-disqualifying by itself because invalid output fails open to `unsure`.

## Prompt Requirements

The prompt must include a non-trivial command taxonomy and require JSON-only output with exactly one key:

```text
{"classification":"inspection_vcs_noop"|"modifying"|"unsure"}
```

Taxonomy:

| Category                     | Examples                                                                                                       | Class                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------ |
| Pure inspection              | `ls`, `pwd`, `cat`, `sed -n`, `head`, `tail`, `wc`, `rg`, `grep`, `find` without delete/exec                   | `inspection_vcs_noop`                        |
| VCS inspection               | `git status`, `git diff`, `git log`, `git show`, `git rev-parse`, `git branch --show-current`                  | `inspection_vcs_noop`                        |
| Harmless output              | `echo`, `printf`, `true`, `false`, `test`, `[` when not redirected                                             | `inspection_vcs_noop`                        |
| Git mutation                 | `git add`, `commit`, `push`, `pull`, `merge`, `rebase`, `reset`, `checkout`, `switch`, `stash`, `clean`, `tag` | `modifying`                                  |
| File mutation                | `touch`, `cp`, `mv`, `rm`, `mkdir`, `rmdir`, `chmod`, `chown`, `>`, `>>`, `tee`, `truncate`                    | `modifying`                                  |
| Build/install/format/codegen | `npm install`, `pnpm install`, `pip install`, `cargo build`, `make`, `npm run format`, codegen scripts         | `modifying` unless clearly read-only         |
| Process/service mutation     | `kill`, `pkill`, `systemctl`, `docker run`, `docker compose up`, server start/stop                             | `modifying`                                  |
| Unknown local scripts        | `./script.sh`, `npm run custom`, `make custom`, `node scripts/x.js`                                            | `unsure` unless clearly read-only inspection |
| Truncated commands           | important args are truncated                                                                                   | `unsure`                                     |
| Compound commands            | `&&`, `;`, `                                                                                                   |                                              | `, pipes, subshells | riskiest component wins; unknown/mixed => `unsure`; any modifying component => `modifying` |

Do not request or grade explanatory fields.

## Fixtures

Fixtures are permanent regression infrastructure under `eval/fixtures/`.

Schema:

```json
{
  "id": "git-status-echo-log",
  "split": "dev",
  "command": "git status && echo \"---\" && git log --oneline -5",
  "args_truncated": false,
  "expected_classification": "inspection_vcs_noop",
  "notes": "Regression for duplicate review after status/log inspection."
}
```

Counts:

- 25 dev fixtures for prompt iteration.
- 10 held-out fixtures not used for prompt iteration.
- 35 total fixtures.
- 3 repeats x 3 models = 315 calls.

Dev-set distribution: 4 pure inspection, 4 VCS inspection, 3 harmless output/tests, 4 git mutation, 4 file mutation, 3 build/install/format/codegen, 3 unknown/truncated/compound. Target labels: about 10 `inspection_vcs_noop`, 10 `modifying`, 5 `unsure`.

Held-out distribution: 2 safe inspection compounds, 2 VCS read-only edge cases, 3 git/file mutation edge cases, 3 unknown/truncated/obfuscated commands.

Held-out examples:

- `git diff --name-only HEAD~1..HEAD`
- `rg "foo" src | head -20`
- `git checkout -b tmp-test`
- `find . -name "*.tmp" -delete`
- `cat package.json > /tmp/pkg.json`
- `./scripts/check-review-state.sh`
- truncated `git commi...`

Run held-out only after the prompt is frozen. If it fails, add a new dev fixture representing the failure class, revise once, and rerun the full suite.

## Fuzz / Property Cases

Add a small deterministic generator under `eval/`.

Generator scope:

- Combine safe commands with `&&`, `;`, and pipes.
- Add harmless quoting and whitespace variants.
- Add redirection variants that flip safe commands to `modifying`.
- Add truncation flags that force `unsure`.
- Add one modifying component into an otherwise safe compound and expect `modifying`.

Keep it small: 20-40 generated cases per local run. Use it in vitest with a mocked classifier and optionally in real-model manual eval if still inside the 25-minute budget.

## Harness

Permanent eval infrastructure as implemented:

```text
eval/
  fixtures.json                 # single file with `dev` + `held_out` arrays
  lib.mjs                       # shared: aggregate, percentile, renderSummary,
                                #         loadLatestResults, groupMismatches
  run-eval.mjs                  # harness entry: runs fixtures against the MODELS list
  summarize.mjs                 # replays a JSONL with corrected metric logic
  analyze.mjs                   # per-fixture mismatch breakdown
  results/                      # append-only JSONL (gitignored)
    .gitignore
  RESULTS.md                    # curated write-up of the latest run
```

> Implementation note: the plan originally sketched separate `fixtures/dev/*.json`
>
> - `fixtures/held-out/*.json` files and TypeScript harness names. The actual
>   impl consolidates fixtures into one JSON file (trivially grep-able, one source
>   of truth) and uses `.mjs` scripts (no build step, runs under
>   `node --experimental-strip-types`). Design intent is unchanged.

Harness requirements:

- Runs selected model list, fixture split, repeat count, timeout, and max concurrency.
- Writes append-only JSONL under `eval/results/`.
- Captures raw output, parsed classification, JSON validity, latency, fixture id, split, model, repeat index, and prompt version.
- Produces a markdown summary table.
- Has no real LLM calls in CI; vitest uses mocked classifier behavior.

Ignore `eval/results/` except for a placeholder or README. Commit curated summaries only when they justify a model choice.

## Metrics and Pass Bar

Per model metrics:

- false-noop count: expected `modifying` or `unsure`, got `inspection_vcs_noop`. Kill metric.
- false-modifying count: expected `inspection_vcs_noop`, got `modifying`. Safe but less useful.
- false-unsure count: expected concrete class, got `unsure`. Safe but less useful.
- exact accuracy, JSON validity, latency p50/p95, timeout/error rate.

A model must meet all of:

- Zero false-noops across dev + held-out repeats.
- p95 latency < 3s.
- timeout/error rate < 2%.
- At least 90% exact accuracy on hand-written fixtures.

Prefer JSON validity >=99%, but invalid output maps to `unsure`, so use this as a model-selection signal rather than an automatic disqualifier.

Tie-break: zero false-noops, lower `unsure` rate on safe inspection commands, lower latency, lower cost. If no model clears zero false-noops, do not ship classifier-backed skipping. Keep deterministic behavior only and add failures to fixtures.

## Prompt Iteration

Use only dev fixtures and fuzz cases for iteration.

- v1: taxonomy + JSON-only output.
- v2: tighten compound/truncation language if needed.
- v3: add one compact safe VCS example and one redirection mutation example if needed.

Stop after v3. Then run held-out once against the chosen prompt.

## CI and Regression Testing

CI must not call real models.

Add vitest coverage for:

- deterministic final skip decision with mocked classifier outputs;
- invalid JSON, timeout, and transport error mapping to `unsure`;
- fixture schema validation;
- fuzz generator invariants;
- no skip when any command is `modifying` or `unsure`;
- skip only when deterministic gates pass and all ambiguous bash commands classify as `inspection_vcs_noop`.

## Shadow-Mode Rollout

Phase 1: log only. Run the classifier where it would be used; record command, classification, deterministic gate state, would-skip decision, and actual review decision; never suppress review.

Phase 2: compare. Inspect cases where shadow mode says "would skip" and the main reviewer found issues; add surprising commands to the `dev` array in `eval/fixtures.json`; track JSON validity, timeout, and latency from logs.

Phase 3: guarded enablement. Enable skip only when deterministic gates pass and every ambiguous bash command is `inspection_vcs_noop`; keep fail-open behavior; log every suppressed review with command classifications and file hash evidence; add a settings kill switch.

Phase 4: maintenance. Every misclassification becomes a fixture; re-run eval before changing prompt, model, or taxonomy; keep `eval/` as permanent regression infrastructure.

## Deliverables

1. `model-eval-plan.md` v2.
2. Permanent `eval/` harness and fixture schema.
3. 25 dev fixtures + 10 held-out fixtures.
4. Small deterministic fuzz/property generator.
5. Vitest tests with mocked classifier only.
6. Manual Bedrock eval summary for Haiku 4.5, Nova Micro, and Nova Lite.
7. Recommendation with chosen model, prompt version, known limits, and shadow-mode criteria.

## Open Questions

1. Confirm whether `git add`, `git commit`, and `git push` should always be `modifying` at the command-classifier layer. Final skip can still happen only if deterministic hashes prove nothing changed since review.
2. Confirm harness invocation path: pi SDK session or direct Bedrock client.
3. Confirm concurrency that stays inside 25 minutes without rate-limit noise.
