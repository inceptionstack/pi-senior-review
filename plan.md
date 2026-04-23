# DRY + SRP Refactor Plan

## Date: 2026-04-23

## Open Issues

### B2. Ctrl+Alt+R does NOT cancel an in-progress review
**Problem:** Pressing Ctrl+Alt+R while the status bar says "reviewing…" does nothing. `reviewAbort.abort()` fires per the log, but the review session doesn't respond to the AbortSignal and keeps running until its own timeout.
**Suspected causes:**
- The shortcut handler may not be dispatched while pi is streaming an assistant message from the previous turn (TUI input layer blocked).
- OR: `session.abort()` inside `onAbort` isn't actually stopping the LLM stream — needs investigation into pi-coding-agent SDK abort propagation.
- OR: The outer `opts.signal` ties to the main agent's abort, not the review's own lifecycle. Need a dedicated review AbortController that can be fired independently of the outer pi signal.
**Priority:** HIGH — users can't escape a stuck review except Ctrl+Alt+Shift+R full reset.
**Status:** [ ]

## Critical Bugs

### B1. Untracked (new) files invisible to reviewer
**Problem:** When agent creates a new file via `write`, it's tracked in `modifiedFiles` but `git diff HEAD` doesn't include untracked files. The reviewer never sees new files.
**Fix:** Also run `git ls-files --others --exclude-standard` to find untracked files, merge them into the changed files list. Label as `(new file)` in context.
**Status:** [x] Fixed + pushed — paths 1 and 2 now discover untracked files, labeled `(new file)` in context

## DRY Violations to Fix

### 1. File reading loop duplicated 3x in `context.ts`
**Where:** `buildReviewContext` (~line 80), `getBestReviewContent` path 1 (~line 267), path 3 (~line 375)
**Fix:** Extract `readChangedFiles(pi, files, root?, onStatus?)` → `{ fileSections: string[], totalContentSize: number }`
**Status:** [x] Done

### 2. Git root resolution duplicated 2x in `index.ts`
**Where:** `toggleReview` (~line 179), `agent_end` handler (~line 360)
**Fix:** Extract `resolveAllGitRoots()` in `git-roots.ts`
**Status:** [x] Done

### 3. changeSummary appendix duplicated 3x in `context.ts`
**Where:** paths 1, 2, 3 in `getBestReviewContent` all do `buildChangeSummary → summarySection`
**Fix:** Build once at top of `getBestReviewContent`, reuse in all paths
**Status:** [x] Done

### 4. Review cleanup duplicated in `index.ts`
**Where:** `agent_end` finally, `toggleReview` finally, `/review N` finally
**Fix:** Extract `finishReview(ctx)` — `isReviewing = false; reviewAbort = null; clearActivityTimer(); resetTrackingState(ctx)`
**Status:** [x] Done

## SRP Violations to Fix

### 5. `index.ts` too large
**Before:** 870 lines
**After refactor:** 685 lines
**Fix:** Extract into modules:
- [x] `settings.ts` — types, defaults, parsing, loading (-112 lines)
- [x] `prompt.ts` — `DEFAULT_REVIEW_PROMPT`, `buildReviewPrompt` (-62 lines)
- [x] `finishReview()` helper extracted
- Keep `index.ts` as orchestration only
**Status:** Done (870 → 685 lines)

### 6. `getBestReviewContent` ~260 lines — god function
**Fix:** Extract each path:
- `getContentFromGitRoots()` + private `buildRepoContext()` / `listDiffFiles()` / `listUntrackedFiles()`
- `getContentFromCwd()`
- `getContentFromLastCommit()`
- `getContentFromToolCalls()`
- Main `getBestReviewContent()` is now ~20 lines of orchestration
**Status:** [x] Done

## Tests

### Current: 162 tests (10 files)
| File | Tests | Coverage |
|------|-------|----------|
| `test/helpers.test.ts` | 11 | `helpers.ts` fully covered |
| `test/ignore.test.ts` | 14 | `ignore.ts` fully covered |
| `test/changes.test.ts` | 43 | `changes.ts` fully covered (incl. `isNonFileModifyingCommand`) |
| `test/settings.test.ts` | 19 | `settings.ts` parseSettings fully covered |
| `test/prompt.test.ts` | 7 | `prompt.ts` fully covered |
| `test/reviewer.test.ts` | 15 | `reviewer.ts` cleanReviewText + isLgtmResult |
| `test/context.test.ts` | 6 | `context.ts` formatReviewContext |
| `test/roundup.test.ts` | 5 | `roundup.ts` buildRoundupPrompt |
| `test/git-roots.test.ts` | 17 | `git-roots.ts` fully covered (incl. tilde expansion) |
| `test/readChangedFiles.test.ts` | 12 | `context.ts` readChangedFiles |

### Missing tests

| # | Function | File | Status |
|---|----------|------|--------|
| T1 | `parseSettings` | `settings.ts` | [x] 19 tests |
| T2 | `formatReviewContext` | `context.ts` | [x] 6 tests |
| T3 | `buildRoundupPrompt` | `roundup.ts` | [x] 5 tests |
| T4 | `buildReviewPrompt` | `prompt.ts` | [x] 7 tests |
| T5 | reviewer text cleanup | `reviewer.ts` | [x] 15 tests |
| T6 | `resolveGitRoots` + tilde expansion | `git-roots.ts` | [x] 17 tests |
| T7 | `readChangedFiles` | `context.ts` | [x] 12 tests |

## Execution Order

1. **Extract `settings.ts`** (#5) + tests (T1) — [x] Done, 19 tests
2. **Extract `prompt.ts`** (#5) + tests (T4) — [x] Done, 7 tests
3. **Extract `readChangedFiles`** (#1) — [x] Done
4. **Extract `resolveAllGitRoots`** (#2) — [x] Done
5. **Build changeSummary once** (#3) — [x] Done
6. **Split `getBestReviewContent`** (#6) — [x] Done, 4 path functions
7. **Extract `finishReview`** (#4) — [x] Done
8. **Extract reviewer cleanup regex** (T5) + tests — [x] Done, 15 tests
9. **Add remaining tests** (T2, T3) — [x] Done, 11 tests
10. **Final: verify index.ts is orchestration-only** — [x] 685 lines, all logic in modules

## Rules
- Each step: extract → test → verify all existing tests still pass → commit
- Don't refactor and add features in the same step
- Keep every commit pushable
