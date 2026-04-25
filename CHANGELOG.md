# Changelog

## 0.2.1 (2026-04-25)

### Features

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

### Refactoring

- **`listDiffFiles()` centralized** — Single exported function for all `git diff --name-only` calls (was 6 duplicated call sites).
- **Non-modifying command list expanded** — Added `rg`, `grep`, `ag`, `ack`, `sort`, `uniq`, `cut`, `tr`, `awk`, `cat`, `head`, `tail`, `wc`, `jq`, `yq`, `stat`, `tree`, etc.
- **Git status cache per root** — Tool-call verification caches `dir→root` and `root→changedFiles` maps to avoid redundant git calls across files in the same repo.

### Documentation

- **README** — Rewrote roundup → architect terminology throughout. Added push guard section, updated status bar examples, updated settings table (`architectEnabled`), config files (`.senior-review/architect.md`).
- **AGENTS.md** — Test counts updated (274 tests, 10 files).
- **plan.md** — Removed stale roundup LLM-judge section, updated test breakdowns.

### Tests

- 274 tests (up from 267): added 7 tests for `hasGitCommitCommand`.
