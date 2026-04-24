# pi-senior-review

A [pi](https://github.com/badlogic/pi-mono) extension that automatically reviews code changes after each agent turn using a separate pi reviewer instance.

## Install

```bash
pi install npm:@inceptionstack/pi-senior-review
```

Or manually:

```bash
cp index.ts ~/.pi/agent/extensions/pi-senior-review.ts
```

## How it works

```
Agent makes file changes (write, edit, bash)
         │
         ▼ agent_end fires
         │
         ▼ Extension detects file-modifying tool calls
         │
         ▼ Spawns a fresh pi instance (in-memory, isolated)
         │
         ▼ Sends per-file diffs + commit messages to reviewer
         │  Reviewer reads each file itself via read(path) tool
         │
    ┌────┴────┐
    │         │
  LGTM    Issues found
    │         │
    ▼         ▼
  Roundup  Feeds back to main agent
  gate?    Agent fixes → new review loop
    │       (up to maxReviewLoops)
    │
    ▼ Cheap heuristics
    │ (< 3 files? only tests? no fix loops? → skip)
    │
    ▼ LLM judge (2-5s)
    │ (are changes complex enough for architecture review?)
    │
    ├── No → done
    │
    └── Yes → Full roundup review
              (architecture, cross-file consistency, tech debt)
```

The reviewer checks for:

- Bugs, logic errors, off-by-one errors, race conditions
- Security issues (injection, secret leaks, auth bypasses)
- Missing error handling
- DRY violations (Don't Repeat Yourself)
- Single Responsibility Principle
- Readability and maintainability
- **Test coverage** — are there tests for new code?
- **Test quality** — naming conventions, entry/exit points, isolation (per Roy Osherove's "Art of Unit Testing" 3rd edition)

## Configuration

Config files are loaded from two locations. **Local takes precedence over global:**

1. `cwd/.senior-review/` — project-specific config
2. `~/.pi/.senior-review/` — global defaults

All config files are optional. If missing, sensible defaults are used.

Use `/scaffold-review-files` to generate config templates.

### `.senior-review/settings.json`

```json
{
  "maxReviewLoops": 100,
  "model": "amazon-bedrock/us.anthropic.claude-opus-4-6-v1",
  "thinkingLevel": "off",
  "roundupEnabled": true,
  "reviewTimeoutMs": 120000,
  "toggleShortcut": "alt+r",
  "cancelShortcut": ""
}
```

| Setting           | Type        | Default                                            | Description                                        |
| ----------------- | ----------- | -------------------------------------------------- | -------------------------------------------------- |
| `maxReviewLoops`  | integer > 0 | `100`                                              | Max review→fix→review cycles before stopping       |
| `model`           | string      | `"amazon-bedrock/us.anthropic.claude-opus-4-6-v1"` | Reviewer model (`"provider/model-id"`)             |
| `thinkingLevel`   | string      | `"off"`                                            | `off\|minimal\|low\|medium\|high\|xhigh`           |
| `roundupEnabled`  | boolean     | `true`                                             | Enable roundup reviews (gated by heuristics+judge) |
| `reviewTimeoutMs` | integer > 0 | `120000`                                           | Max wall-clock per review in ms                    |
| `toggleShortcut`  | string      | `"alt+r"`                                          | Key id for toggling review on/off                  |
| `cancelShortcut`  | string      | `""` (none)                                        | Key id for cancelling review (opt-in, see below)   |

### `.senior-review/review-rules.md`

Custom review rules appended to the reviewer prompt. Only include review criteria — the surrounding prompt (tools, budget, workflow, response format) is handled automatically.

```markdown
## Architecture

- All API endpoints must validate input with zod schemas
- Database queries must use parameterized statements

## Security

- No console.log in production code (use logger)
- No secrets in code — use environment variables
```

Use `/add-review-rule <text>` to quickly prepend rules, or `/senior-edit-review-rules` to open the file in pi's editor.

### `.senior-review/auto-review.md`

Override the "what to review / what not to report" section of the review prompt. The surrounding prompt (tools, budget, workflow, response format) is always included automatically.

### `.senior-review/roundup.md`

Custom rules for the roundup architecture review:

```markdown
## Architecture

- Verify module dependency graph has no cycles
- Check error handling is consistent across all modules
- Flag any TODO/FIXME comments added during fix loops
```

### `.senior-review/ignore`

Gitignore-style patterns to exclude files from review:

```
# Skip generated files
*.generated.ts
dist/
node_modules/

# Skip specific paths
src/vendor/**
```

## UX

### Status bar (bottom of pi)

- `senior-review on (Alt+R toggle)` — idle, no pending files
- `senior-review on · will review 3 files (Alt+R toggle)` — edits accumulating
- `senior-review reviewing… [2/100] model-name (/cancel-review)` — reviewer running
- `senior-review off (Alt+R toggle)` — disabled

### Review progress widget

During reviews, an animated widget appears below the editor showing:
- ASCII art senior dev with reading glasses
- File list with active file highlighted and per-file tool usage counts
- Elapsed time, model name, loop count

### Commands

| Command                       | Description                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `/review`                     | Toggle senior-review on/off                                                     |
| `/review N`                   | Review the last N commits                                                       |
| `/review-all`                 | Review all changes (pending diff → last commit → all files in cwd)              |
| `/cancel-review`              | Cancel an in-progress review (works during roundup)                             |
| `/scaffold-review-files`      | Create `.senior-review/` config templates in a git repo                         |
| `/senior-edit-review-rules`   | Edit `.senior-review/review-rules.md` in pi's built-in editor                   |
| `/add-review-rule <text>`     | Prepend a custom rule to `.senior-review/review-rules.md`                       |

### Keyboard shortcuts

| Key                | Default  | Configurable     | Action                                              |
| ------------------ | -------- | ---------------- | --------------------------------------------------- |
| Toggle shortcut    | `alt+r`  | `toggleShortcut` | Toggle senior-review on/off                         |
| Cancel shortcut    | _(none)_ | `cancelShortcut` | Cancel in-progress review                           |
| `ctrl+alt+r`       | built-in | no               | Cancel review (fallback, terminals that support it) |
| `ctrl+alt+shift+r` | built-in | no               | Full reset: cancel, reset loops, clear all state    |

> **Note:** `/cancel-review` is the recommended cancel method. It works in all terminals. Keyboard shortcuts for cancel are opt-in via `cancelShortcut` in settings because many terminals (especially iTerm2 on macOS) don't reliably send modifier key combos.

## Review loop behavior

1. Agent makes changes → review triggers
2. If issues found → agent fixes them → review triggers again
3. If LGTM → loop counter resets
4. If loop count reaches `maxReviewLoops` → stops with a warning
5. Toggling off/on with `/review` resets the counter

### Smart roundup review

After the review loop reaches LGTM, a **roundup review** may trigger automatically. It's gated by a two-stage filter to avoid wasting time on trivial changes:

**Stage 1 — Cheap heuristics (instant):**

- Skip if < 3 files changed across the session
- Skip if only test files changed
- Skip if no fix loops happened (first-pass LGTM)

**Stage 2 — LLM judge (2-5 seconds):**

- A quick LLM call decides if the changes warrant a broader architecture review
- Gets: file list, fix loop count, change summaries
- Valuable after: multi-module refactoring, new interfaces, complex fix loops
- Not needed for: localized bug fixes, additive changes, config/docs

If the judge recommends it, the full roundup review runs. It:

- Checks architecture coherence across all changes
- Verifies cross-file consistency (naming, patterns, types)
- Looks for accumulated tech debt from fix loops
- Validates documentation is still accurate
- Uses tools (`read`, `bash`, `grep`, `find`, `ls`) to explore the full codebase

Disable with `"roundupEnabled": false` in settings.

## What triggers a review

Only fires when file-modifying tools were used during the agent turn:

- `write` — new files
- `edit` — file edits
- `bash` — commands matching file operations (`cp`, `mv`, `rm`, `sed -i`, `cat >`, `tee`, `mkdir`, `echo >`)

Pure read/search turns are skipped. Non-file-modifying bash commands (`git commit`, `curl`, `aws`, etc.) are also skipped.

### Untracked (new) files

Files created via `write` that haven't been `git add`ed are detected via `git ls-files --others --exclude-standard` and included in the review context, labeled as `(new file)`.

## Cancellation

You can cancel a review at any time:

- **`/cancel-review`** — works in all terminals, recommended method
- **Configured shortcut** — set `cancelShortcut` in settings if you want a hotkey
- **`ctrl+alt+r`** — fallback, works in terminals that support the key combo

Cancellation stops the current review immediately, including roundup judge calls and full roundup reviews. The agent continues normally.

## License

MIT
