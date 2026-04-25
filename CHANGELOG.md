# Changelog

## 0.2.1 (2026-04-25)

### Features

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

### Refactoring

- **`computeReviewTimeoutMs()` helper** — Extracted the `Math.max(reviewTimeoutMs, fileCount * 120_000)` formula into `helpers.ts` with `REVIEW_PER_FILE_BUDGET_MS` constant. Previously duplicated in 6 places across `orchestrator.ts` and `commands.ts`.
- **`listDiffFiles()` centralized** — Single exported function for all `git diff --name-only` calls (was 6 duplicated call sites).
- **Non-modifying command list expanded** — Added `rg`, `grep`, `ag`, `ack`, `sort`, `uniq`, `cut`, `tr`, `awk`, `cat`, `head`, `tail`, `wc`, `jq`, `yq`, `stat`, `tree`, etc.
- **Git status cache per root** — Tool-call verification caches `dir→root` and `root→changedFiles` maps to avoid redundant git calls across files in the same repo.

### Documentation

- **README** — Rewrote roundup → architect terminology throughout. Added push guard section, updated status bar examples, updated settings table (`architectEnabled`), config files (`.lgtm/architect.md`).
- **AGENTS.md** — Test counts updated to 307 tests, 12 files.
- **plan.md** — Removed stale roundup LLM-judge section, updated test breakdowns.

### Tests

- 307 tests (up from 267): added 7 tests for `hasGitCommitCommand`, 18 for `review-display` helpers (`findMatchingFile`, `formatDuration`), and 5 for `computeReviewTimeoutMs`.
