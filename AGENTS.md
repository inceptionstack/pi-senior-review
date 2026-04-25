# AGENTS.md — Agent Guide for pi-senior-review

## What is this project?

A [pi](https://github.com/badlogic/pi-mono) extension that automatically reviews code changes after each agent turn. It spawns a separate, isolated pi reviewer instance that reads changed files, examines diffs, and feeds findings back to the main agent for fixes. Includes an "architect" review that checks cross-file consistency after multi-file changes pass individual reviews.

## Quick orientation

```
pi-senior-review/
├── index.ts              ← Extension entry point & orchestration (~1300 lines)
├── settings.ts           ← Config loading from .senior-review/ dirs
├── prompt.ts             ← Review prompt construction (3-part structure)
├── reviewer.ts           ← Spawns pi session, runs review, parses verdict
├── changes.ts            ← Change detection, tool call classification
├── context.ts            ← Builds review content (4 fallback paths)
├── ignore.ts             ← Gitignore-style pattern matching
├── architect.ts          ← Architecture-level "zoom out" review
├── git-roots.ts          ← Multi-repo git root detection
├── helpers.ts            ← Pure utility functions
├── logger.ts             ← File logger + structured JSON review records
├── review-display.ts     ← TUI widget (ASCII art + file progress)
├── scaffold.ts           ← Template content for /scaffold-review-files
├── default-review-rules.md ← Default review criteria (OWASP, SOLID, DRY, etc.)
├── test/                 ← 248 tests across 9 files (vitest)
└── .senior-review/       ← Local config (settings.json, review-rules.md, etc.)
```

## Key commands

```bash
npm run check          # Full CI: typecheck + lint + format + tests
npm run test           # Run tests (vitest)
npm run test:watch     # Watch mode
npm run typecheck      # TypeScript type checking (tsc --noEmit)
npm run lint           # ESLint
npm run lint:fix       # ESLint with auto-fix
npm run format         # Prettier format
npm run format:check   # Prettier check
```

## Tech stack

- **Language:** TypeScript (ES2022, ESNext modules)
- **Runtime:** Node.js (runs inside pi agent)
- **Testing:** Vitest
- **Linting:** ESLint 9 + typescript-eslint
- **Formatting:** Prettier
- **Dependency:** `@mariozechner/pi-coding-agent` (peer dep — the pi SDK)
- **No runtime dependencies** — only peer dep on the pi SDK

## Git workflow

- **Never amend commits. Always append new commits.**
- Run `npm run check` before committing to catch type errors, lint issues, and test failures.
- Each commit should be self-contained and pushable.

## Architecture at a glance

The extension hooks into pi's lifecycle events:

```
session_start → load config from .senior-review/ dirs
tool_execution_start/end → track which files the agent modifies
agent_end → if files changed, trigger review pipeline
```

The review pipeline:

```
1. Detect changed files (modifiedFiles + tool call paths + git roots)
2. Build review content (4 fallback paths in context.ts)
3. Spawn isolated pi reviewer session (reviewer.ts)
4. Parse verdict (LGTM or ISSUES_FOUND)
5. If issues → feed back to main agent → agent fixes → re-review (loop)
6. If LGTM → optionally run architect review (for multi-file changes)
```

## How the modules connect

```
index.ts (orchestrator)
  ├── settings.ts      — reads .senior-review/settings.json + review-rules.md
  ├── changes.ts       — classifies tool calls as file-modifying or not
  ├── context.ts       — builds review content from git diffs / tool calls
  │     ├── helpers.ts — truncateDiff, clampCommitCount
  │     └── ignore.ts  — filters out ignored files
  ├── prompt.ts        — assembles the 3-part review prompt
  ├── reviewer.ts      — spawns pi session, runs LLM, parses verdict
  ├── architect.ts     — runs architecture-level review after LGTM
  ├── git-roots.ts     — finds git repo roots from file paths
  ├── review-display.ts — animated TUI widget during review
  ├── scaffold.ts      — templates for /scaffold-review-files command
  └── logger.ts        — file logging + structured JSON records
```

## Important patterns

### Config resolution (two locations, local wins)

1. `cwd/.senior-review/` — project-local config
2. `~/.pi/.senior-review/` — global defaults
   All config files are optional. `settings.ts` handles loading + validation with error messages for invalid values.

### Content gathering has 4 fallback paths (context.ts)

1. **Git roots** — diffs from detected git repos (best quality)
2. **CWD git repo** — `buildReviewContext` from current directory
3. **Last commit** — `git diff HEAD~1 HEAD` as fallback
4. **Tool calls only** — read files directly from agent tool call paths (no git)

### The review prompt has 3 non-negotiable parts (prompt.ts)

1. **PROMPT_PREFIX** — tools, budget, workflow (always included)
2. **Auto-review rules** — what to review / skip (user-overridable via `auto-review.md`)
3. **PROMPT_SUFFIX** — response format, verdict tags (always included)
   `review-rules.md` appends additional project-specific rules after part 3.

### Verdict parsing (reviewer.ts)

The reviewer must output `<verdict>LGTM</verdict>` or `<verdict>ISSUES_FOUND</verdict>`. If missing, up to 2 retry prompts ask for just the verdict. After retries, defaults to ISSUES_FOUND (safer).

### Architect review (architect.ts)

Triggers automatically when >1 file was reviewed across the session AND content was git-based. No heuristics or judge gating — it always runs for multi-file changes. Checks architecture coherence, cross-file consistency, and accumulated tech debt.

## Testing conventions

- Tests live in `test/` with matching names (e.g., `test/settings.test.ts` tests `settings.ts`)
- Tests use vitest (`describe`, `it`, `expect`)
- Test names follow descriptive pattern: `functionName > scenario > expected behavior`
- Pure functions are tested directly; I/O-heavy functions are tested with mocks
- 248 tests across 9 test files

## Common modification scenarios

### Adding a new setting

1. Add to `AutoReviewSettings` interface in `settings.ts`
2. Add default in `DEFAULT_SETTINGS`
3. Add validation in `parseSettings()`
4. Add to `SCAFFOLD_SETTINGS` in `scaffold.ts`
5. Use in `index.ts` where needed
6. Add tests in `test/settings.test.ts`
7. Update README.md

### Adding a new slash command

1. Add `pi.registerCommand(...)` in `index.ts`
2. Update the commands table in README.md

### Changing review prompt behavior

1. Modify `prompt.ts` (PROMPT_PREFIX, DEFAULT_AUTO_REVIEW_RULES, or PROMPT_SUFFIX)
2. Or modify `default-review-rules.md` for the scaffolded review criteria
3. Update tests in `test/prompt.test.ts`

### Adding a new content fallback path

1. Add a new function in `context.ts` (e.g., `getContentFromX`)
2. Wire it into `getBestReviewContent()` in the correct priority order
3. Add tests

## Files to read first

If you're new to this codebase, read in this order:

1. **README.md** — user-facing docs, feature overview
2. **index.ts** — the orchestrator, shows how everything connects
3. **reviewer.ts** — the core: spawning a review session, parsing results
4. **context.ts** — how review content is gathered
5. **changes.ts** — how file modifications are detected
