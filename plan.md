# DRY + SRP Refactor Plan

## Date: 2026-04-23

## Critical Bugs

### B1. Untracked (new) files invisible to reviewer
**Problem:** When agent creates a new file via `write`, it's tracked in `modifiedFiles` but `git diff HEAD` doesn't include untracked files. The reviewer never sees new files.
**Where:** `context.ts` — all git paths only use `git diff HEAD` / `git diff HEAD --name-only`
**Fix:** Also run `git ls-files --others --exclude-standard` to find untracked files, merge them into the changed files list, and read their contents. For the diff, include the full file content as an "added file" since there's no diff for untracked files.
**Priority:** HIGH — new files are completely invisible to the reviewer
**Status:** [x] Fixed — paths 1 and 2 now run `git ls-files --others --exclude-standard` and merge untracked files

## DRY Violations to Fix

### 1. File reading loop duplicated 3x in `context.ts`
**Where:** `buildReviewContext` (lines ~80-103), `getBestReviewContent` path 1 (lines ~222-240), path 3 (lines ~332-348)
**Fix:** Extract `readChangedFiles(pi, files, root?, onStatus?)` → returns `{ fileSections: string[], totalContentSize: number }`
**Status:** [ ]

### 2. Git root resolution duplicated 2x in `index.ts`
**Where:** `toggleReview` (~line 354), `agent_end` handler (~line 521)
**Fix:** Extract `resolveAllGitRoots(pi, cwd, modifiedFiles, agentToolCalls, detectedGitRoots)` → returns `Set<string>`
**Status:** [ ]

### 3. changeSummary appendix duplicated 3x in `context.ts`
**Where:** paths 1, 2, 3 in `getBestReviewContent` all do `buildChangeSummary → summarySection`
**Fix:** Build it once at the top of `getBestReviewContent` and append at the end of whichever path returns
**Status:** [ ]

### 4. Review cleanup duplicated in `index.ts`
**Where:** `agent_end` finally block, `toggleReview` finally block, `/review N` finally block
**Fix:** Extract `finishReview(ctx)` that does `isReviewing = false; reviewAbort = null; clearActivityTimer(); resetTrackingState(ctx)`
**Status:** [ ]

## SRP Violations to Fix

### 5. `index.ts` at 870 lines
**Fix:** Extract into separate modules:
- `settings.ts` — `loadSettings`, `loadReviewRules`, `AutoReviewSettings`, `DEFAULT_SETTINGS`
- `prompt.ts` — `DEFAULT_REVIEW_PROMPT`, `buildReviewPrompt`
- Keep `index.ts` as orchestration only (event handlers, state, shortcuts, commands)
**Status:** [ ]

### 6. `getBestReviewContent` at ~260 lines is a god function
**Fix:** Extract each path into its own function:
- `getContentFromGitRoots(pi, gitRoots, agentToolCalls, onStatus, ignorePatterns)`
- `getContentFromCwd(pi, agentToolCalls, onStatus, ignorePatterns)`
- `getContentFromLastCommit(pi, agentToolCalls, onStatus)`
- `getContentFromToolCalls(pi, agentToolCalls, onStatus)`
**Depends on:** #1 (readChangedFiles), #3 (changeSummary)
**Status:** [ ]

## Missing Tests to Add

### Pure functions (no mocks needed)

| # | Function | File | Status |
|---|----------|------|--------|
| T1 | `loadSettings` | `settings.ts` (after extract) | [ ] |
| T2 | `formatReviewContext` | `context.ts` | [ ] |
| T3 | `buildRoundupPrompt` | `roundup.ts` | [ ] |
| T4 | `buildReviewPrompt` | `prompt.ts` (after extract) | [ ] |
| T5 | reviewer text cleanup (extract regex logic) | `reviewer.ts` | [ ] |

### Functions needing light mocks

| # | Function | File | Status |
|---|----------|------|--------|
| T6 | `resolveGitRoots` + tilde expansion | `git-roots.ts` | [ ] |
| T7 | `readChangedFiles` (after extract) | `context.ts` | [ ] |

## Execution Order

1. **Extract `settings.ts`** (#5 partial) + tests (T1) — no deps
2. **Extract `prompt.ts`** (#5 partial) + tests (T4) — no deps
3. **Extract `readChangedFiles`** (#1) — pure extraction from context.ts
4. **Extract `resolveAllGitRoots`** (#2) — pure extraction from index.ts
5. **Build changeSummary once** (#3) — refactor getBestReviewContent
6. **Split `getBestReviewContent`** (#6) — depends on 3, 4, 5
7. **Extract `finishReview`** (#4) — cleanup in index.ts
8. **Extract reviewer cleanup regex** (T5) + tests
9. **Add remaining tests** (T2, T3, T6, T7)
10. **Final: verify index.ts is orchestration-only**

## Rules
- Each step: extract → test → verify 49 existing tests still pass → commit
- Don't refactor and add features in the same step
- Keep every commit pushable
