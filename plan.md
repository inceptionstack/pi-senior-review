# DRY + SRP Refactor Plan

## Date: 2026-04-23

---

# Design Brainstorm — Review Pipeline v2 (2026-04-25)

New design topics captured during a working session; **none implemented yet**, all need design + sign-off before code. Keep this section as living notes — add trade-offs, don't commit to a solution until discussed.

## D1. Eyebrow animation starts neutral, only changes on file switch

**Problem:** The senior/architect robot has a two-frame eye animation (neutral ↔ furrowed/inquisitive). Currently the frames tick on a fixed interval regardless of review activity, and the review starts in the neutral frame. With a single-file review (which is most auto-reviews), the eyebrow barely moves — the robot looks bored instead of inquisitive.

**Intent:** Make the robot look **actively thinking** from the first frame. Furrowed should be the default state while reviewing.

**Brainstorm directions (pick later):**

1. **Start furrowed, keep ticking on timer** — minimal change. Just flip `animFrame = 1` in initial state. Low cost; still looks OK when idle-ish.
2. **Tie animation to activity, not to timer** — frame advances on each `onToolCall` event. When reviewer is actively reading/grepping, the eyebrow pulses. When idle (waiting for LLM response), the frame holds on furrowed. More honest but slightly more code.
3. **Separate frames for "reading" vs "thinking" vs "done"** — more art, more states. Probably overkill for v2; revisit if we add more personalities.
4. **Switch to a richer expression set tied to review outcome at the END** — after LGTM show a smile, after issues show a worried brow. Distinct concern from the "start furrowed" request; log separately.

**Tests to add:** snapshot test in `test/review-display.test.ts` asserting the initial frame is the furrowed one.

**Status:** [x] Done (commit `d055843`) — picked option 2 (tie animation to activity) + seed furrowed. `animFrame` starts at 1 (furrowed frame); timer only ticks spinner; `recordToolCall` advances frame when `activeFile` changes; `setArchitectMode` resets to furrowed.

## D2. Widget truncation when >5 reviewed files

**Problem:** `buildReviewWidget` renders every file in `state.files` as a list row. When >5 files are being reviewed, the widget grows past the visible terminal area below the editor and the bottom rows are effectively invisible (or push the editor off-screen). Architect review is the worst case — it routinely reviews 10+ files across a session.

**Brainstorm directions (not picked yet):**

1. **Hard cap + "... N more"** — show first 5 files, then `... 7 more files` summary. Simple, always fits. Loses per-file progress for tail files.
2. **Scrolling window centered on active file** — always show the currently-reading file + 2 before + 2 after. Fits in 5 rows. Requires keeping the active-file index reliable (see D3).
3. **Group by module/directory** — if >5 files, group by top-level dir and show module-level counts. `src/ [▸ 3/5 read]`, `test/ [1/2 read]`. Looks clean for monorepos but needs good grouping heuristics.
4. **Two-line compact format** — drop per-file rows entirely when >5. Show a single line: `reviewing 11 files • 7 read • currently: src/index.ts`. Sacrifices detail for always-fits.
5. **Collapse finished files** — once a file's tool-call count exceeds a threshold (say, 3 reads), collapse it to a single line `• N files read (click to expand)`. Not really interactive in a TUI widget though.
6. **Scroll indicator** — just show the first 5 and print `↓ 5 more below` at the bottom. Simplest scroll UI, no actual scroll needed since the widget redraws each tick.

**Tension:** we want at-a-glance visibility of _which file is active_ and _overall progress_. Option 2 (scrolling window) preserves both; option 4 (compact line) is the most disciplined if we trust the active-file indicator.

**Tests:** property-style fixture test in `test/review-display.test.ts` — for file counts from 0 to 30, assert widget height ≤ some budget (e.g. 12 lines).

**Status:** [ ] brainstorming — need to pick an option

## D3. Active-file highlight not actually working in practice

**Problem:** Observation during recent reviews: the `▸ ... ← reading` indicator frequently doesn't match the file the reviewer is actually working on. Previously tightened `findMatchingFile` (path-segment boundaries) and skipped `bash` tool calls, but the indicator still seems to lag or mis-track.

**Suspected root causes (need investigation):**

1. **Reviewer reads files outside the listed set for cross-reference.** When it does, no file matches, `activeFile` is left stale from the last matched read. Net effect: the highlight sticks to an old file while the reviewer is clearly reading something else.
2. **Path absolute/relative mismatch.** If `files` contains relative paths (`src/a.ts`) but the reviewer reads absolute paths, the boundary match should work — but what if git gave back paths with a `./` prefix or a symlinked root?
3. **Multi-root reviews.** When `gitRoots` has >1 entry, `files` contains `root/path` tuples but the reviewer's `read(...)` tool gets just `path`. Boundary match may drop these.
4. **Widget tick race.** The widget redraws on a 150ms timer; `onToolCall` fires on the reviewer's loop. A fast sequence of reads might only update state for the last one before the next redraw.

**Diagnostic approach:**

- Add a debug mode that logs every `(tool_name, target_path, matched_file)` triple to `~/.pi/.hardno/review.log`.
- Cross-reference against the reviewer's actual output: did the file indicator ever match the file it was critiquing?
- If causes 1 or 3 dominate, make `activeFile` fall back to a "currently unlisted read" state (e.g. show `▸ (cross-ref) node_modules/x/y.ts`) instead of holding stale.

**Status:** [ ] investigating — capture logs first, then decide fix

## D4. Refactor: reviewers as pluggable "agent personalities" in a pipeline

**Vision:** Today's hard-coded pair (senior review then optional architect review) should become a generic review _pipeline_ where each step is an "agent personality" with its own:

- **System prompt** (the role / charter)
- **Review rules** (appended to prompt; e.g. `review-rules.md`, `architect.md`, `security.md`, ...)
- **Context strategy** (per-file diffs, full repo tree, commit history, branch diff, ...)
- **Verdict parser** (currently LGTM/ISSUES_FOUND; future: rating, tag list, json summary)
- **Trigger condition** (when to run: every turn, multi-file only, on commit, on PR, ...)
- **Output handling** (sendMessage + triggerTurn | inline status | commit message amendment)

**Why:** user wants to add e.g. a security review, commit-message review, test-coverage review, architectural-debt review — each with its own prompt and rules. Hard-coding more functions/modules per reviewer is the wrong shape.

**Design sketch (to iterate on):**

```ts
// One personality = one reviewer role
export interface ReviewPersonality {
  id: string; // "senior" | "architect" | "security" | ...
  displayName: string; // "Senior Review" (shown to user)
  systemPrompt: string; // the role/charter
  customRulesFile?: string; // .hardno/<id>.md (optional)
  contextStrategy: ContextStrategy; // per-file diff | full repo | last commit | ...
  verdictParser: (raw: string) => Verdict;
  outputHandler: (result, api) => void; // how to deliver to user/agent
}

// One pipeline step = one personality invocation, with DAG metadata
export interface PipelineStep {
  personality: ReviewPersonality;
  trigger: TriggerCondition; // e.g. always | multi-file | on-commit
  dependsOn: string[]; // ids of steps that must pass before this runs
  runMode: "serial" | "parallel";
}

// Orchestrator consumes a DAG and resolves it
export interface ReviewPipeline {
  steps: PipelineStep[];
}
```

**Invariants to preserve:**

- Fail-closed on missing API key or timeout (current architect-failure surfacing).
- Existing senior → architect sequence must express as a 2-step DAG with no behavior change.
- `settings.json` gets a `pipeline` key to declare which steps are enabled + their trigger + runMode. Default pipeline matches today's behavior exactly.

**Key open questions:**

- **Parallel runs**: can multiple reviewers safely share a single SDK auth context? Probably yes (each spawns its own `createAgentSession`). But rate limits matter — if we parallel-fire 4 reviewers they all hit Bedrock at once.
- **Result aggregation for parallel**: if security + senior both fire, and security LGTMs but senior finds issues, what's the combined message to the user? Probably per-step sections in a single summary message.
- **Cross-step context**: should a later step see earlier steps' findings? E.g. architect sees senior's output. Current code does this implicitly; needs an explicit contract.
- **Config file shape**: a single `settings.json` with nested pipeline config? Or per-step `.hardno/<id>.json`? Probably the latter for cleanliness.
- **Backward compat**: users with existing `.hardno/review-rules.md` + `.hardno/architect.md` must see zero behavior change.

**Status:** [ ] design only. Needs an architecture RFC before code.

## D5. External agent CLI as review backend (codex / claude / kiro / shell)

**Vision:** Today the reviewer is hard-wired to use pi's SDK (`createAgentSession` + Bedrock). The user wants to be able to delegate a review step to an **external CLI** instead — codex, claude-cli, kiro, or a generic shell command — so power users can swap in their tool of choice per step.

**Why this is structurally interesting:** it's a clean separation between "who runs the review" (backend) and "what the review is" (personality). A user might pair the senior personality with the pi SDK and the architect personality with codex CLI, because codex is better at cross-file reasoning.

**Design sketch:**

```ts
export interface ReviewBackend {
  id: string; // "pi-sdk" | "codex-cli" | "claude-cli" | "shell"
  invoke(prompt: string, opts: InvokeOpts): Promise<BackendResult>;
  capabilities: {
    hasReadTool: boolean;
    hasBashTool: boolean;
    hasFileSearch: boolean;
    supportsStreaming: boolean;
  };
}

export interface InvokeOpts {
  cwd: string;
  timeoutMs: number;
  onActivity?: (msg: string) => void;
  onToolCall?: (tool: string, target: string | null) => void;
  signal: AbortSignal;
}
```

**Concrete backends to support:**

1. **pi-sdk** (current behavior) — `createAgentSession` with Bedrock. Default.
2. **codex-cli** — `codex exec --sandbox read-only --cd <cwd> "<prompt>"`. Stream stdout, parse verdict. Already used in our brainstorm loops; proves it works.
3. **claude-cli** — `claude --print "<prompt>"` or via MCP.
4. **kiro** — similar CLI invocation; check their API surface.
5. **generic shell** — `${cmd} <prompt-file>`; the user writes their own wrapper.

**Trade-offs / open questions:**

- **Activity streaming**: pi SDK emits structured tool-call events so the widget can update in real-time. External CLIs emit free-form stdout. We'd need heuristics (grep for `read <path>`) or settle for a simpler widget when backends don't support structured events.
- **Tool capabilities vary**: codex has its own read-only sandbox; claude-cli via MCP has different tool shape; a shell backend has none. Personalities should declare what capabilities they need, and backends should be rejected if missing (e.g. security-review needs bash + read, so can't pair with a shell backend that only has text-in/text-out).
- **Auth**: each external backend has its own auth (codex uses OpenAI, claude-cli uses Anthropic, etc.). We don't manage it; we just invoke the binary and trust it's set up. Add a health-check on extension init: `which codex` etc.
- **Error surfaces**: external CLIs can fail in more ways (binary missing, auth broken, sandbox rejected, etc.). Fail-open logic stays the same but the error messages need to be clear about _which backend_ failed.
- **Security**: invoking an external CLI with a large prompt that contains user code — make sure we don't accidentally exfil. Should be fine since the user opted in, but worth a paragraph in README.

**Integration with D4:**

D4's `ReviewPersonality` gets a new field:

```ts
backend: string; // "pi-sdk" | "codex-cli" | "claude-cli" | "shell:my-custom"
```

Default to pi-sdk for all existing personalities; users override per step in their settings.

**Status:** [ ] design only. Needs backend contract RFC first, then pilot with codex-cli as the second backend (since we already use it in the dev loop — fastest path to validate the abstraction).

## D6. Don't re-review the same file across cycles if it hasn't changed

**Problem:** Captured during the 2026-04-25 manual judge-scenarios live test (see `judge-scenarios-manual-test.md`). The uncommitted `judge-scenarios-manual-test.md` was reviewed by the senior reviewer **four separate times in a row** within ~10 minutes (review-ids `r-f7c27f95`, `r-2f61ce21`, `r-4b1dd662`, `r-0f2f62cc`). Between reviews the file's content on disk was identical — no edits — but each cycle paid the full 7–53s + token cost anyway. Reason: `getBestReviewContent` path-2 (cwd git repo fallback) re-queries `git status` each turn and picks up every untracked/modified file it finds, with no memory of what was already reviewed and unchanged.

**Intent:** A review is worth running when there is _new_ content to examine. If file X was reviewed on cycle N with an LGTM verdict, and cycle N+K reaches X again with bit-identical content, that cycle should skip X (or skip entirely if X is the only file). Don't pay to be told "LGTM" again on the same bytes.

Contrast with the existing `duplicate_content` hash check in the orchestrator — that hashes the _combined_ review content (prompt input). It catches "exact same diff text" but not "same file that keeps showing up in `git status` because it's still untracked". Path-2 content includes e.g. the current `git status` output which changes between reviews even when the file content doesn't. So the existing dedup misses this case.

**Brainstorm directions (pick later):**

1. **Per-file content-hash memory** — on LGTM for file X, record `sha256(file X content)` → verdict into a session-local Map. Next cycle, before handing X to the reviewer, hash it again; if the hash matches a prior LGTM, drop X from the review set. If every file drops, skip the whole cycle (new skip reason: `all_files_unchanged_since_lgtm`). Simple and correct. Doesn't cache across pi sessions — fresh start on `/reload` is fine.
2. **Per-file content-hash + verdict (LGTM or ISSUES)** — richer variant: cache the verdict too. Unchanged file with a prior ISSUES verdict means "issues still unresolved", which is the `hadIssuesBefore` branch in `renderOutcome`. We could surface "still needs fixing" without re-running the reviewer. More invasive; defer unless D6.1 proves insufficient.
3. **Git-tree SHA per path** — instead of hashing content ourselves, use `git ls-files -s` / `git hash-object` to get git's blob sha per path. Free hash for tracked files, works for untracked via `git hash-object --no-filters --stdin`. Slightly faster than reading + sha256'ing. Trade-off: one extra `git` call per candidate file.
4. **Skip files whose mtime + size are unchanged** — cheapest but wrong for sub-second edits and for files rewritten to identical content. Not recommended; hashes are worth the cost.
5. **Per-review-id cache only (no cross-review memory)** — rejected: doesn't solve the observed problem, which is _across_ review cycles.

**Where it lives:** `orchestrator.ts` — same layer as the existing `lastReviewedContentHash` dedup. Add a `reviewedFileHashes: Map<string, {hash: string, verdict: "lgtm" | "issues"}>` on the orchestrator, populated inside `handleAgentEnd` after a completed cycle, consulted at the start before content building. Cache keyed by absolute path; cleared on `reset()` and `setEnabled(false)`.

**Edge cases to think through:**

- File was LGTM, then edited, then edited back to the original content — we'd currently re-review (hash differs at the mid-point), then skip. Fine.
- File was ISSUES, user did nothing, file still in working tree next turn — skip-file would hide unresolved issues; we need to keep re-reviewing ISSUES files OR surface "still unresolved" without running. Direction 2 solves this; direction 1 needs to only skip on prior LGTM.
- Architect review — architect operates on cross-file consistency, so a single unchanged file shouldn't block architect; skip logic should apply to the _senior_ review cycle only. Architect has its own `shouldRunArchitectReview` gate that already considers file count.
- File deleted between reviews — drop from cache on detection (cheap `existsSync` check, or trust `git status`).

**Tests to add:**

- Orchestrator unit test: cycle 1 reviews X → LGTM, cycle 2 with identical X content skips X, cycle 3 with edited X re-reviews it.
- Orchestrator unit test: cycle 1 reviews X → ISSUES, cycle 2 with identical X still re-reviews (until LGTM resolves).
- Multi-file cycle: skip only the unchanged subset, still review the changed files.
- Regression: `resetCycleState()` clears the per-file hash map (in addition to existing state).

**Status:** [ ] design only. Needs a small RFC covering the verdict-semantics (direction 1 vs 2) before code. D6.1 is the minimum viable.

## Open Issues

### Changelog check in default review rules

**Problem:** Reviewers didn't flag missing or stale changelog entries. User-visible changes could land without a corresponding `CHANGELOG.md` update, which hurts release hygiene and makes upgrade impact hard to judge.

**Fix:** Added a "Documentation & Release Notes" section to `default-review-rules.md` that:

- Asserts a changelog file should exist at the project root (`CHANGELOG.md`, `CHANGES.md`, `HISTORY.md`, or equivalent)
- Instructs the reviewer to flag missing changelog entries for user-visible changes (features, bug fixes, breaking changes, deprecations)
- Explicitly excludes internal-only changes (refactors with no behavior change, test-only updates, docs-only, build/tooling) so the reviewer doesn't false-positive on internal commits
- Flags `package.json` version bumps without a matching changelog entry as a smell
- Suggests creating a changelog (Keep a Changelog format) if none exists

**Status:** [x] Done

### Extract PushGuard class from index.ts

**Problem:** The push guard logic (regex matching, command stripping, block reason detection, status bar integration) is inline in index.ts's `tool_call` handler. It mixes concerns: command parsing, review state querying, command mutation, and agent notification.

**Fix:** Extract a `PushGuard` class (or module `push-guard.ts`) that owns:

- `shouldBlock(command): { blocked: boolean; reason?: string }`
- `stripPush(command): { modified: string; hadPush: boolean }`
- `getBlockReason(): string | null`

index.ts wires it up via `tool_call` but the logic is testable independently.

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

### Current: 274 tests (10 files)

| File                        | Tests | Coverage                                                       |
| --------------------------- | ----- | -------------------------------------------------------------- |
| `test/architect.test.ts`    | 12    | `architect.ts` fully covered                                   |
| `test/changes.test.ts`      | 99    | `changes.ts` fully covered (incl. `isNonFileModifyingCommand`) |
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
