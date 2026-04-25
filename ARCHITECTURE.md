# ARCHITECTURE.md — pi-lgtm

## System overview

pi-lgtm is a pi extension that provides automated code review after every agent turn that modifies files. It works by spawning an isolated, read-only pi reviewer instance that examines changes and feeds findings back to the main agent.

```
┌─────────────────────────────────────────────────────────┐
│                    Pi Agent (main)                       │
│                                                         │
│  User prompt → Agent modifies files → agent_end fires   │
│                                          │              │
│                                          ▼              │
│  ┌─────────────────────────────────────────────┐        │
│  │         pi-lgtm extension          │        │
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
                    index.ts (pi wiring, UI, renderOutcome)
                   /    |     |     \      \
                  ▼     ▼     ▼      ▼      ▼
      orchestrator.ts  commands.ts  message-sender.ts  review-display.ts
           |               |              |
           ├── reviewer.ts (injected)     ├── reviewer.ts (types)
           ├── context.ts  (injected)     └── logger.ts
           ├── architect.ts
           ├── prompt.ts               commands.ts
           ├── changes.ts                  ├── reviewer.ts (direct)
           ├── helpers.ts                  ├── context.ts
           └── logger.ts                   ├── prompt.ts
                                           ├── helpers.ts
                                           ├── ignore.ts
                                           └── scaffold.ts

        context.ts ──────► helpers.ts
            │
            ├──────────► ignore.ts
            │
            ├──────────► changes.ts
            │
            └──────────► logger.ts

        architect.ts ──► settings.ts (readConfigFile)
        ignore.ts    ──► settings.ts (readConfigFile)
        commands.ts  ──► settings.ts (configDirs, plus AutoReviewSettings type)

        git-roots.ts ──► (pi SDK)

        changes.ts ──── (standalone, no local imports)
        helpers.ts ──── (standalone, no local imports — imported by
                          context.ts, orchestrator.ts, commands.ts)
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
│   Override: .lgtm/auto-review.md│
├──────────────────────────────────────────┤
│ PROMPT_SUFFIX (always included)          │
│   - Response format: bullet list         │
│   - Severity: High / Medium / Low        │
│   - Verdict tag: <verdict>LGTM</verdict> │
│     or <verdict>ISSUES_FOUND</verdict>   │
├──────────────────────────────────────────┤
│ Custom rules (appended if present)       │
│   From: .lgtm/review-rules.md   │
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

### 5. Review loop (orchestrator.ts + index.ts)

```
agent modifies files
       │
       ▼
  agent_end fires (index.ts)
       │
       ├── aborted? disabled? → skip, update status
       │
       ▼
  orchestrator.handleAgentEnd(input)
       │
       ├── reviewEnabled? ── no → { type: "skipped" }
       ├── maxReviewLoops? ── yes → { type: "max_loops" }
       ├── hasFileChanges? ── no → { type: "skipped" }
       ├── formattingOnly? ── yes → { type: "skipped" }
       ├── no real files?  ── yes → { type: "skipped" }
       │
       ▼
  Build content (injected ContentBuilder)
       │
       ├── null / too small? → { type: "skipped" }
       ├── same hash? → { type: "skipped", reason: "duplicate_content" }
       │
       ▼
  Run review (injected ReviewRunner)
       │
       ├── Context overflow? → retry with FALLBACK_LIMITS
       │
       ▼
  Parse result
       │
       ├── LGTM → reset loop counter → check architect
       │     │
       │     ├── >1 file && git-based → run architect
       │     │     → { type: "completed", senior: LGTM, architect: result }
       │     │
       │     └── no architect → { type: "completed", senior: LGTM }
       │
       └── ISSUES_FOUND → { type: "completed", senior: issues }
       │
       ▼
  renderOutcome(outcome) in index.ts
       │
       ├── completed + no architect → sendMessage(senior, triggerTurn: true)
       ├── completed + architect → sendMessage(senior, triggerTurn: false)
       │                          sendMessage(architect, triggerTurn: true)
       ├── error → sendMessage(error)
       └── skipped/cancelled/max_loops → UI notification only
```

## Configuration system (settings.ts)

```
Config resolution order (local wins):
  1. cwd/.lgtm/settings.json      ← project-local
  2. ~/.pi/.lgtm/settings.json    ← global

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
    ┌─────────┐   ⣾ Reviewing… [1/100] claude-opus 42s/4m tools: 12
    │  ◉   ◉  │     (reviewer may take up to 4m — LLMs explore files out of list order)
    │ ═══════ │   Files:
    │    ▽    │     ▸ src/index.ts [5] read index.ts ← reading
    │  ╰───╯  │     • src/helpers.ts [3] read helpers.ts
    └────┬────┘     · src/utils.ts
    ╭────┴────╮
   ╱│ SENIOR  │╲    reading src/index.ts
  ╱ │ REVIEW  │ ╲
    ╰─────────╯
────────────────────────────────────────────────────────────
```

File-status markers — no ✓ is ever shown during a live review, because the
reviewer LLM cross-references across files non-linearly and the widget can't
honestly claim a file is "done":

- `·` untouched — the reviewer hasn't opened this file yet
- `•` read at least once — has a positive tool-call count
- `▸ … ← reading` currently the last-touched file via `read`/`grep`/`find`/`ls`
  (bash commands don't set this, since the command string isn't a file path)

Header shows `elapsed/timeout` (e.g. `42s/4m`) using the same
`computeReviewTimeoutMs(settings.reviewTimeoutMs, files.length)` budget as
the reviewer itself, so users know when a long review is expected vs. stuck.

The widget tracks:

- Which file is currently being reviewed (via tool call path matching)
- Tool call counts per file
- Elapsed time, model name, loop count
- Animation (alternating eye frames + spinner)

In architect mode, the ASCII art changes to "ARCHITCT" and an architecture diagram with module boxes is shown.

## Logging (logger.ts)

Two output channels under `~/.pi/.lgtm/`:

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
