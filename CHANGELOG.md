# Changelog

## 1.0.0 (2026-04-26)

### Breaking Changes

- **Renamed package** — `@inceptionstack/pi-lgtm` → `@inceptionstack/pi-hard-no`
- **Renamed config directory** — `.lgtm/` → `.hardno/` (both project-local and `~/.pi/.hardno/`)
- **Renamed GitHub repo** — `inceptionstack/pi-lgtm` → `inceptionstack/pi-hard-no`
- **Renamed commands** — `/lgtm-rules` → `/hardno-rules`

### Migration

1. `pi uninstall npm:@inceptionstack/pi-lgtm`
2. `pi install npm:@inceptionstack/pi-hard-no`
3. Rename `.lgtm/` directories to `.hardno/` (project-local and `~/.pi/.hardno/`)

## 0.2.1 (2026-04-25)

### Features

- **`/review-clean-logs` command** — Wipes `~/.pi/.hardno/review.log` (+ rotated `.old`) and every `reviews/*.json` structured record. Leaves user config (`.hardno/settings.json`, `.hardno/review-rules.md`, etc.) untouched. Useful when testing review-pipeline changes without noise from prior runs.
- **Persistent skip indicator** — The "review skipped" status-bar hint now stays until the next review cycle starts or real file activity happens, instead of vanishing on the next user prompt. Visibility also bumped: a ✓ glyph + success-colored "review skipped" text makes it readable at a glance, with the reason dim next to it.
- **`/review-judge-toggle` command + status-bar indicator** — Session-level toggle for the duplicate-review suppressor (the judge). Runs without edits to `.hardno/settings.json`; matches the pattern of `/review` (Alt+R). Status bar now shows a dim `⚖ judge` glyph whenever the judge is enabled, visible in all three status bar states (reviewing / pending files / idle). When the judge skips a review, a `⚖️ Review skipped by judge` message is posted to the pi chat as a persistent record and triggers a new agent turn so the agent can continue (e.g., push after a read-only check-if-clean flow). Loop-safe: capped at 3 consecutive judge-skip-triggered turns before the chain is broken (with a note in chat). Counter resets on any non-judge-skip outcome.
- **Duplicate-review suppressor ("judge")** — New opt-in gate that asks a cheap LLM (default: Claude Haiku 4.5 via Bedrock) to classify each bash tool call as `inspection_vcs_noop` | `modifying` | `unsure`. If every bash call in a turn is read-only (and no write/edit happened), the main review is skipped with reason `judge_read_only`. Fixes the spurious re-review after `git add && git commit && git push` turns where the deterministic classifier falsely flags `echo` as modifying. Fail-open: any judge error (timeout, transport, parse) → review runs as normal. Off by default; enable via `judgeEnabled: true` in `.hardno/settings.json`. New module `judge.ts` + `judgeEnabled`/`judgeModel`/`judgeTimeoutMs` settings. Model pick backed by the eval harness under `eval/` (zero false-noops in 630 calls across two runs).
- **Review timeout in widget header** — Both senior and architect review widgets now show the effective wall-clock budget alongside elapsed time (e.g. `45s/4m`) and a subline hint that the reviewer may take up to that long. Makes it obvious when a long review is expected vs. stuck.
- **Push guard** — Automatically blocks `git push` when review is needed: during active review, when issues are unresolved, or when files are pending review. Shows `🔒 push blocked` in the status bar. Respects review enabled/disabled state. ([README: Push guard](README.md#push-guard))
- **Skip status** — Status bar shows "skipped — no files to review" (or other reason) when auto-review skips, persists until real file activity replaces it.
- **Resolved issues trigger** — When a skip follows unresolved issues (files deleted/reverted), sends "✅ Review issues resolved" with `triggerTurn` so the agent can continue working. Loop-safe: the next no-op turn skips without triggering.
- **Distinct reviewer robots** — Senior reviewer has round head (╭╮), friendly smile, eyebrow animation. Architect reviewer has angular head (╱╲), stern mouth, squinting animation. Visually distinct at a glance.
- **Git-verified tool-call reviews** — The tool-call content path (Path 4) cross-checks candidate files against `git status` per repo. Read-only commands (`rg`, `grep`, `cat`) no longer falsely trigger reviews. Files outside git repos use heuristic detection.

### Bug Fixes

- **Review keeps running after cancel** — `session.abort()` is now awaited (was fire-and-forget). Added reentrancy guard in `agent_end` and late-cancel check after `runSeniorReview`.
- **Deleted files reviewed** — All `git diff --name-only` calls use `--diff-filter=d` to exclude deleted files. Centralized into `listDiffFiles()`.
- **Architect review crash** — Theme methods (`fg`, `bold`) bound at capture time to prevent stale-context errors. `safeGetUi()` helper wraps all `ctx.hasUI` access.
- **Last-commit fallback reviewing stale content** — Gated on `hasGitCommitCommand()`: only falls back to `git diff HEAD~1 HEAD` when the agent actually ran `git commit`.
- **Architecture diagram shows "home"** — `inferModuleFromPath` relativizes absolute paths against cwd before module inference.
- **Session accumulator leak** — `sessionChangedFiles` cleared via `resetCycleState()` when LGTM and architect doesn't run. Deleted files pruned via `fileExists()` before architect trigger.
- **Empty reviews wasting time** — Orchestrator skips when `files.length === 0`. Tool-call path returns null when no readable files remain.
- **LGTM triggering unnecessary cycles** — All review outcomes now trigger turns (agent can push/continue), but skips do NOT trigger turns (except resolved-issues case).
- **Stale "issues found" indicator** — Cleared when skip finds nothing to review (files deleted/reverted).
- **Skip status immediately overwritten** — `skipStatusShowing` flag prevents `updateStatus` from overwriting; cleared only on `agent_start` (new turn) or real file activity.
- **Redirect false positives** — `isNonModifyingPart` detects file redirects (`>`, `>>`) while excluding fd-to-fd redirects (`2>&1`).
- **Path matching false positives** — Git status verification uses `/`-separator-aware matching to prevent `contest.ts` matching `test.ts`.
- **Spurious ✓ checkmarks in review widget** — `findMatchingFile` now requires path-segment boundaries (`/foo/bar.ts` no longer matches `r.ts`). Bash tool calls are no longer passed through file-matching (the command string could spuriously suffix-match a listed filename). Prevents unrelated files from being flagged as reviewed after incidental tool calls.
- **Misleading "reviewing" per-file label** — Replaced `✓` "completed" marker with `•` "read" marker and renamed `← reviewing` to `← reading`. During a live review we can't know when a file is truly done — the reviewer LLM cross-references across files non-linearly — so the widget now reports what it can actually observe (tool activity) rather than implying completion.
- **Judge gate — empty-command false-positive guard** — `isTurnReadOnlyViaJudge` now tracks whether any classification actually ran and returns `false` if not. Previously, a turn whose bash tool calls all had empty or whitespace-only `command` fields would skip every loop iteration and fall through to `return true`, falsely marking the turn "confidently read-only" without ever invoking the judge. New regression test covers it.
- **Judge skip silent in the status bar** — `renderOutcome` now maps the `judge_read_only` skip reason to `"judge: read-only turn"` instead of letting it fall through to `null`. Users see feedback when the judge suppresses a review.
- **`/review-judge-toggle` status-bar stale after skip** — The judge toggle command now clears `skipStatusShowing` before calling `updateStatus`, so the `⚖ judge` indicator appears/disappears immediately instead of waiting until the next real file activity. Previously, toggling the judge after a `judge_read_only` or `no_meaningful_changes` skip left the old skip indicator pinned until a tool call refreshed the bar.
- **Spawned sub-session recursive reviews + stale-ctx crash** — pi-hard-no was being loaded fresh for every reviewer session spawned by `runReviewSession` (pi's extension loader re-executes the factory on every `createAgentSession`). The second instance's `agent_end` handler ran when the reviewer finished its prompt, recursively triggering another review on the reviewer session itself, then crashing with `"This extension ctx is stale after session replacement or reload"` once the reviewer was disposed. Fixed by a new `isSpawnedSubSession(pi)` guard (`session-kind.ts`) that detects the restricted tool set (no `write` / `edit`) of spawned sessions via `pi.getAllTools()` and no-ops the `agent_end` handler early. Result cached per-`pi` via `WeakMap`; fail-safe defaults to main-session on probe errors.

### Refactoring

- **`JudgeSkipChain` module** — Extracted the consecutive-judge-skip loop safeguard (counter + message formatting + cap) from `index.ts` into `judge-skip-chain.ts`. Same behavior — chat message content is byte-for-byte identical to the previous inlined templates — but now unit-testable without the pi SDK. 7 reset sites in `index.ts` collapsed to a single `judgeSkipChain.reset()`.
- **`computeReviewTimeoutMs()` helper** — Extracted the `Math.max(reviewTimeoutMs, fileCount * 120_000)` formula into `helpers.ts` with `REVIEW_PER_FILE_BUDGET_MS` constant. Previously duplicated in 6 places across `orchestrator.ts` and `commands.ts`.
- **`listDiffFiles()` centralized** — Single exported function for all `git diff --name-only` calls (was 6 duplicated call sites).
- **Non-modifying command list expanded** — Added `rg`, `grep`, `ag`, `ack`, `sort`, `uniq`, `cut`, `tr`, `awk`, `cat`, `head`, `tail`, `wc`, `jq`, `yq`, `stat`, `tree`, etc.
- **Git status cache per root** — Tool-call verification caches `dir→root` and `root→changedFiles` maps to avoid redundant git calls across files in the same repo.

### Eval Infrastructure (research, not shipped)

- **`eval/` directory** — Permanent harness + fixtures + results scaffolding for model selection on the bash-command classifier subsystem (`model-eval-plan.md`). Not part of the shipped extension runtime; lint/prettier/tsc exclude `eval/`.
  - `eval/fixtures.json` — 25 dev + 10 held-out bash commands labelled with expected classification (`inspection_vcs_noop` | `modifying` | `unsure`).
  - `eval/lib.mjs` — shared helpers: `aggregate`, `percentile`, `renderSummary`, `loadLatestResults`, `groupMismatches`.
  - `eval/run-eval.mjs` — harness that calls real Bedrock models via the pi SDK and writes JSONL.
  - `eval/summarize.mjs` — replays any historical JSONL with an invariant-checked metrics table.
  - `eval/analyze.mjs` — per-fixture mismatch breakdown + per-fixture model-agreement matrix.
  - `eval/RESULTS.md` — first-run findings: all three candidate models (Haiku 4.5, Nova Micro, Nova Lite) passed the zero-false-noop kill metric; Haiku 4.5 is the recommendation pending shadow-mode validation.
  - `eval/results/` — gitignored JSONL output.

### Documentation

- **README** — Rewrote roundup → architect terminology throughout. Added push guard section, updated status bar examples, updated settings table (`architectEnabled`), config files (`.hardno/architect.md`).
- **AGENTS.md** — Test counts updated to 307 tests, 12 files.
- **plan.md** — Removed stale roundup LLM-judge section, updated test breakdowns.

### Tests

- 399 tests (up from 267): added 7 tests for `hasGitCommitCommand`, 18 for `review-display` helpers (`findMatchingFile`, `formatDuration`), 5 for `computeReviewTimeoutMs`, 30 for `JudgeSkipChain` (counter semantics, cap boundary, reset, content rendering), 17 for `session-kind` (main vs spawned detection, fail-safe, caching), and assorted judge-gate coverage in `orchestrator.test.ts`.
