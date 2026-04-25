# DRY + SRP Refactor Plan

## Date: 2026-04-23

## Open Issues

### Smart roundup: LLM-as-judge gate for architecture reviews

**Goal:** Roundup reviews are valuable after refactorings and cross-cutting changes, but waste time on trivial single-file fixes. Gate roundup with cheap heuristics + a fast LLM judge call.
**Design:**

1. After LGTM, check cheap heuristics first (skip immediately if obviously not needed):
   - < 3 files changed across the session → skip
   - Only test files changed → skip
   - peakReviewLoopCount === 0 (first-pass LGTM, no fix loops) → skip
2. If heuristics say "maybe", run a **quick judge call** (~2-5s, small context):
   - Feed: file list, git log (recent commits), change summary snippets
   - Ask: "Does this warrant a broader architecture review? YES/NO + one sentence."
   - Reuse `runReviewSession` with tight timeout (20s), maps verdict: ISSUES_FOUND=yes, LGTM=no
3. If judge says YES → run full roundup automatically (unattended)
4. `/cancel-review` cancels both judge and roundup (shared abort signal) ✓
   **Config:** `roundupEnabled: true` by default
   **Status:** [ ]

### B3. `buildRepoContext` ignores agent-modified file list — reviews wrong files

**Problem:** When agent creates new (untracked) files via `write`, `buildRepoContext` runs `git diff HEAD` on the entire repo. If the working tree has no staged/modified _tracked_ files, the diff is empty and the code falls through to the `git diff HEAD~1 HEAD` (last commit) branch. This branch always has content, so it "succeeds" — but it reviews the _last commit's_ files instead of the untracked files the agent just created.
**Root cause (two-part):**

1. The untracked-file discovery only runs when `git diff HEAD` is non-empty (step 1) or when ALL diffs are empty (step 3). The "last commit" fallback (step 2) short-circuits before untracked files are checked.
2. More fundamentally, `buildRepoContext` never receives the set of files the agent actually modified (`modifiedFiles` / `collectModifiedPaths`). It does a blanket repo-wide diff instead of scoping to agent-touched files. This means even when it does find changes, it may review irrelevant files.
   **Fix:**

- Always check for untracked files in `buildRepoContext`, not just in step 1 and step 3.
- Pass `modifiedFiles` into `getContentFromGitRoots` → `buildRepoContext` and use it to scope/prioritize which files are reviewed. If the agent touched specific files, prefer those over a blanket repo diff.
- When only untracked files exist (no tracked changes), don't fall through to the last-commit path — go directly to untracked-only.
  **Priority:** HIGH — reviewer sees stale/wrong files, missing the actual changes.
  **Status:** [x] Fixed

### B2. Ctrl+Alt+R does NOT cancel an in-progress review

**Problem:** Pressing Ctrl+Alt+R while the status bar says "reviewing…" does nothing. `reviewAbort.abort()` fires per the log, but the review session doesn't respond to the AbortSignal and keeps running until its own timeout.
**Suspected causes:**

- The shortcut handler may not be dispatched while pi is streaming an assistant message from the previous turn (TUI input layer blocked).
- OR: `session.abort()` inside `onAbort` isn't actually stopping the LLM stream — needs investigation into pi-coding-agent SDK abort propagation.
- OR: The outer `opts.signal` ties to the main agent's abort, not the review's own lifecycle. Need a dedicated review AbortController that can be fired independently of the outer pi signal.
- **Most likely (confirmed):** iTerm2 on macOS doesn't send Ctrl+Alt+letter combos — the keypress never reaches pi at all. The shortcut handler never fires (no log entry).
  **Fix:** Added `/cancel-review` slash command and `Alt+X` shortcut as terminal-independent alternatives. Slash commands work regardless of terminal key mapping or focus state. `Alt+X` works in iTerm2 with Option-as-Meta enabled.
  **Priority:** HIGH — users can't escape a stuck review except Ctrl+Alt+Shift+R full reset.
  **Status:** [x] Fixed — `/cancel-review` command added

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

- `getContentFromGitRoots()` + `listDiffFiles()` (exported) / private `buildRepoContext()` / `listUntrackedFiles()`
- `getContentFromCwd()`
- `getContentFromLastCommit()`
- `getContentFromToolCalls()`
- Main `getBestReviewContent()` is now ~20 lines of orchestration
  **Status:** [x] Done

## Tests

### Current: 267 tests (10 files)

| File                        | Tests | Coverage                                                       |
| --------------------------- | ----- | -------------------------------------------------------------- |
| `test/architect.test.ts`    | 12    | `architect.ts` fully covered                                   |
| `test/changes.test.ts`      | 92    | `changes.ts` fully covered (incl. `isNonFileModifyingCommand`) |
| `test/context.test.ts`      | 6     | `context.ts` formatReviewContext                               |
| `test/git-roots.test.ts`    | 17    | `git-roots.ts` fully covered (incl. tilde expansion)           |
| `test/helpers.test.ts`      | 11    | `helpers.ts` fully covered                                     |
| `test/ignore.test.ts`       | 14    | `ignore.ts` fully covered                                      |
| `test/orchestrator.test.ts` | 19    | `orchestrator.ts` state machine                                |
| `test/prompt.test.ts`       | 15    | `prompt.ts` fully covered                                      |
| `test/reviewer.test.ts`     | 31    | `reviewer.ts` cleanReviewText + isLgtmResult + parseVerdict    |
| `test/settings.test.ts`     | 50    | `settings.ts` parseSettings fully covered                      |

### Missing tests

| #   | Function                            | File              | Status       |
| --- | ----------------------------------- | ----------------- | ------------ |
| T1  | `parseSettings`                     | `settings.ts`     | [x] 50 tests |
| T2  | `formatReviewContext`               | `context.ts`      | [x] 6 tests  |
| T3  | `buildArchitectPrompt`              | `architect.ts`    | [x] 12 tests |
| T4  | `buildReviewPrompt`                 | `prompt.ts`       | [x] 15 tests |
| T5  | reviewer text cleanup               | `reviewer.ts`     | [x] 31 tests |
| T6  | `resolveGitRoots` + tilde expansion | `git-roots.ts`    | [x] 17 tests |
| T7  | orchestrator state machine          | `orchestrator.ts` | [x] 19 tests |

## Execution Order

1. **Extract `settings.ts`** (#5) + tests (T1) — [x] Done, 50 tests
2. **Extract `prompt.ts`** (#5) + tests (T4) — [x] Done, 15 tests
3. **Extract `readChangedFiles`** (#1) — [x] Done
4. **Extract `resolveAllGitRoots`** (#2) — [x] Done
5. **Build changeSummary once** (#3) — [x] Done
6. **Split `getBestReviewContent`** (#6) — [x] Done, 4 path functions
7. **Extract `finishReview`** (#4) — [x] Done
8. **Extract reviewer cleanup regex** (T5) + tests — [x] Done, 31 tests
9. **Add remaining tests** (T2, T3) — [x] Done
10. **Final: verify index.ts is orchestration-only** — [x] 685 lines, all logic in modules

## Rules

- Each step: extract → test → verify all existing tests still pass → commit
- Don't refactor and add features in the same step
- Keep every commit pushable
