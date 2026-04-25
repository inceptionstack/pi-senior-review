# ARCHITECTURE.md — pi-senior-review

## System overview

pi-senior-review is a pi extension that provides automated code review after every agent turn that modifies files. It works by spawning an isolated, read-only pi reviewer instance that examines changes and feeds findings back to the main agent.

```
┌─────────────────────────────────────────────────────────┐
│                    Pi Agent (main)                       │
│                                                         │
│  User prompt → Agent modifies files → agent_end fires   │
│                                          │              │
│                                          ▼              │
│  ┌─────────────────────────────────────────────┐        │
│  │         pi-senior-review extension          │        │
│  │                                             │        │
│  │  1. Detect changed files (changes.ts)       │        │
│  │  2. Build review content (context.ts)       │        │
│  │  3. Spawn reviewer session (reviewer.ts)    │        │
│  │  4. Parse verdict (LGTM / ISSUES_FOUND)     │        │
│  │  5. Feed back via sendMessage()             │        │
│  │                                             │        │
│  │  If issues → agent fixes → re-review (loop) │        │
│  │  If LGTM → maybe architect review           │        │
│  └─────────────────────────────────────────────┘        │
│                                                         │
│  Agent receives review feedback as a follow-up message  │
│  and decides whether to fix or explain                  │
└─────────────────────────────────────────────────────────┘
```

## Module dependency graph

All arrows mean "imports from". No circular dependencies exist.

```
                         index.ts
                      (orchestrator)
                     /   |   |  |  \   \
                    /    |   |  |   \   \
                   ▼     ▼   ▼  ▼    ▼   ▼
          settings.ts  prompt.ts  reviewer.ts  review-display.ts  scaffold.ts
               |              |        |
               |              |        ▼
               |              |    logger.ts
               ▼              |
           (node:fs)          |
                              ▼
                          (pi SDK)

        context.ts ──────► helpers.ts
            │
            ├──────────► ignore.ts ──► settings.ts (readConfigFile)
            │
            ├──────────► changes.ts
            │
            └──────────► logger.ts

        architect.ts ──► reviewer.ts
            │
            └──────────► settings.ts (readConfigFile)

        git-roots.ts ──► (pi SDK)

        changes.ts ──── (standalone, no local imports)

        helpers.ts ──── (standalone, no local imports)

        logger.ts ───── (standalone, only node:fs + node:path + node:os)
```

## Data flow

### 1. Change detection (changes.ts)

The extension tracks every tool call the main agent makes via `tool_execution_start` / `tool_execution_end` events.

```
Tool calls from main agent
         │
         ▼
┌─────────────────────┐
│  isFileModifyingTool │ ── write, edit → always file-modifying
│                      │ ── bash → check isNonFileModifyingCommand()
│                      │       ├── git push/commit/add → non-modifying
│                      │       ├── aws/curl/wget → non-modifying
│                      │       └── cp/mv/sed -i/cat > → file-modifying
└─────────────────────┘
         │
         ▼
  modifiedFiles (Set<string>)  +  agentToolCalls (TrackedToolCall[])
```

### 2. Content gathering (context.ts)

When `agent_end` fires and file changes were detected, the extension gathers review content through 4 fallback paths:

```
getBestReviewContent()
         │
         ├── Path 1: getContentFromGitRoots()
         │     For each git root: buildRepoContext()
         │       ├── Uncommitted changes (git diff HEAD)
         │       ├── Untracked files (git ls-files --others)
         │       ├── Or last commit (git diff HEAD~1 HEAD)
         │       └── Per-file: diff + commit messages
         │
         ├── Path 2: getContentFromCwd()
         │     buildReviewContext() from current directory
         │     (full diff, file tree, commit log)
         │
         ├── Path 3: getContentFromLastCommit()
         │     git diff HEAD~1 HEAD as final git fallback
         │
         └── Path 4: getContentFromToolCalls()
               No git available — use tool call paths directly
               (reviewer reads files itself)
```

Each path produces a `ReviewContent` object: `{ content, label, files, isGitBased }`.

### 3. Prompt construction (prompt.ts)

The review prompt has a fixed 3-part structure:

```
┌──────────────────────────────────────────┐
│ PROMPT_PREFIX (always included)          │
│   - Role: senior code reviewer           │
│   - Tools: read, bash, grep, find, ls    │
│   - Budget: 30 tool calls per file       │
│   - Workflow: read → cross-reference →   │
│     additional checks → write review     │
├──────────────────────────────────────────┤
│ AUTO_REVIEW_RULES (user-overridable)     │
│   - What to review (priority order):     │
│     correctness, security, data loss     │
│   - What NOT to report:                  │
│     style, missing tests, refactors      │
│   Override: .senior-review/auto-review.md│
├──────────────────────────────────────────┤
│ PROMPT_SUFFIX (always included)          │
│   - Response format: bullet list         │
│   - Severity: High / Medium / Low        │
│   - Verdict tag: <verdict>LGTM</verdict> │
│     or <verdict>ISSUES_FOUND</verdict>   │
├──────────────────────────────────────────┤
│ Custom rules (appended if present)       │
│   From: .senior-review/review-rules.md   │
├──────────────────────────────────────────┤
│ User request context (appended)          │
│   The last user message that triggered   │
│   the agent turn                         │
├──────────────────────────────────────────┤
│ Review content (diffs, file paths, etc.) │
│   From context.ts                        │
└──────────────────────────────────────────┘
```

### 4. Review execution (reviewer.ts)

```
┌──────────────────────────────────────────────┐
│               runReviewSession()             │
│                                              │
│  1. Create in-memory pi session              │
│     (SessionManager.inMemory())              │
│  2. Set model + thinking level               │
│  3. Subscribe to session events              │
│     - Track tool calls for display widget    │
│     - Accumulate assistant text              │
│  4. Send prompt → agent loop runs            │
│     - Reviewer reads files via read(path)    │
│     - Reviewer explores via bash/grep/find   │
│     - Reviewer writes findings + verdict     │
│  5. Parse verdict from <verdict> tag         │
│     - If missing: up to 2 retries           │
│     - Final fallback: ISSUES_FOUND           │
│  6. Clean review text (strip tool noise)     │
│  7. Log structured JSON record               │
│                                              │
│  Returns: ReviewResult                       │
│    { text, rawText, isLgtm, durationMs,     │
│      toolCalls, model, thinkingLevel }       │
└──────────────────────────────────────────────┘
```

### 5. Review loop (index.ts)

```
agent modifies files
       │
       ▼
  agent_end fires
       │
       ├── reviewEnabled? ── no → track files, update status
       │
       ├── maxReviewLoops reached? ── yes → warn, stop
       │
       ├── hasFileChanges? ── no → skip
       │
       ├── isFormattingOnlyTurn? ── yes → skip (prettier/eslint --fix/etc.)
       │
       ▼
  Build review content
       │
       ├── content too small? → skip
       ├── same hash as last review? → skip (avoid re-reviewing identical content)
       │
       ▼
  Run review session
       │
       ├── Context overflow? → retry with FALLBACK_LIMITS (smaller diffs)
       │
       ▼
  Parse result
       │
       ├── LGTM → reset loop counter
       │     │
       │     ├── architectEnabled && >1 file && git-based?
       │     │     yes → run architect review (architect.ts)
       │     │     no  → done
       │     │
       │     └── sendMessage(LGTM) → triggers agent turn (for any user notification)
       │
       └── ISSUES_FOUND → sendMessage(issues) → triggers agent turn
             Agent sees review feedback, makes fixes
             agent_end fires again → new review cycle
             (up to maxReviewLoops)
```

## Configuration system (settings.ts)

```
Config resolution order (local wins):
  1. cwd/.senior-review/settings.json      ← project-local
  2. ~/.pi/.senior-review/settings.json    ← global

Config files:
  settings.json      ← JSON: model, maxLoops, shortcuts, timeouts
  review-rules.md    ← Markdown: appended to prompt as custom rules
  auto-review.md     ← Markdown: overrides "what to review" section
  architect.md       ← Markdown: custom architect review rules (legacy: roundup.md)
  ignore             ← Gitignore-style: files to exclude from review
```

Settings validation is in `parseSettings()` — a pure function that returns `{ settings, errors }`. Every setting has a typed default in `DEFAULT_SETTINGS`. Unknown keys produce warnings but don't fail.

## Ignore system (ignore.ts)

Follows gitignore semantics:

- `*` matches anything except `/`
- `**` matches everything including `/`
- `!` prefix negates a pattern
- Last matching pattern wins
- Patterns without `/` match filename only
- Patterns with `/` match full path

Applied at two points:

1. When gathering review content (filters files from git diffs)
2. When running `/review N` or `/review-all` commands

## TUI integration (review-display.ts)

During reviews, an animated widget renders below the editor:

```
────────────────────────────────────────────────────────────
    ┌─────────┐   ⣾ Reviewing… [1/100] claude-opus 42s tools: 12
    │  ◉   ◉  │
    │ ═══════ │   Files:
    │    ▽    │     ▸ src/index.ts [5] read index.ts ← reviewing
    │  ╰───╯  │     ✓ src/helpers.ts [3] read helpers.ts
    └────┬────┘     · src/utils.ts
    ╭────┴────╮
   ╱│ SENIOR  │╲    reading src/index.ts
  ╱ │ REVIEW  │ ╲
    ╰─────────╯
────────────────────────────────────────────────────────────
```

The widget tracks:

- Which file is currently being reviewed (via tool call path matching)
- Tool call counts per file
- Elapsed time, model name, loop count
- Animation (alternating eye frames + spinner)

In architect mode, the ASCII art changes to "ARCHITCT" and an architecture diagram with module boxes is shown.

## Logging (logger.ts)

Two output channels under `~/.pi/.senior-review/`:

| Output           | Format                     | Purpose                                                                              |
| ---------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `review.log`     | Timestamped text lines     | Free-text debug log (rotates at 1MB)                                                 |
| `reviews/*.json` | Structured JSON per review | Full review records (prompt length, raw/cleaned text, tool calls, verdict, duration) |

All logging is synchronous (`appendFileSync` / `writeFileSync`) to guarantee output in complex async flows.

## Cancellation

Cancellation uses `AbortController` / `AbortSignal`:

```
reviewAbort = new AbortController()
     │
     ▼
signal passed to runReviewSession()
     │
     ▼
sendPrompt() listens on signal.addEventListener("abort")
     │
     ├── On abort: session.abort() + reject("Review cancelled")
     └── On timeout: session.abort() + reject("Review timed out")
```

Cancellation sources:

- `/cancel-review` slash command (recommended, works everywhere)
- Configured `cancelShortcut` in settings (opt-in)
- `ctrl+alt+r` (fallback, terminal-dependent)
- `ctrl+alt+shift+r` (full reset: cancel + clear all state)

## Error handling

- **Context overflow**: If the reviewer model's context window is exceeded, the extension retries with `FALLBACK_LIMITS` (smaller diffs/files).
- **Model not found / no API key**: Falls back to the session's default model with a log warning.
- **Review timeout**: Configurable via `reviewTimeoutMs`, automatically scaled up for large file counts (`filesReviewed.length * 120_000`).
- **Verdict missing**: Up to 2 retry prompts ask for just the verdict tag. After retries, defaults to `ISSUES_FOUND`.
- **All errors**: Caught at the top level in `agent_end`, displayed to user via `ui.notify()`, and logged to `review.log`.

## Key design decisions

1. **Isolated reviewer session**: The reviewer runs in its own pi session with read-only tools (no write/edit). This prevents the reviewer from accidentally modifying files.

2. **Per-file context over monolithic diff**: Instead of one giant diff, each file gets its own section with path, diff, and recent commit messages. The reviewer reads each file itself via `read(path)`.

3. **4-path content fallback**: The extension works in git repos (3 git-based paths) and non-git directories (tool-call-only path). This makes it usable in any project.

4. **Formatting detection**: Turns that only run formatters (prettier, eslint --fix, black, gofmt, etc.) are automatically skipped to avoid reviewing cosmetic-only changes.

5. **Content deduplication**: A SHA-256 hash of the review content prevents re-reviewing identical changes across consecutive agent turns.

6. **Architect review without gating**: Earlier designs had heuristics + LLM judge to gate architect reviews. Current design simply triggers for any multi-file git-based change — simpler and more predictable.

7. **Synchronous logging**: All log writes are synchronous to guarantee output order and completeness, even during abrupt cancellation or error paths.
