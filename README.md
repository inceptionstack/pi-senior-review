# pi-autoreview

A [pi](https://github.com/badlogic/pi-mono) extension that automatically reviews code changes after each agent turn using a separate pi reviewer instance.

## Install

```bash
pi install npm:@inceptionstack/pi-autoreview
```

Or manually:

```bash
cp index.ts ~/.pi/agent/extensions/pi-autoreview.ts
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
         ▼ Sends change summary to reviewer
         │
    ┌────┴────┐
    │         │
  LGTM    Issues found
    │         │
    ▼         ▼
  Roundup  Feeds back to main agent
  review?   Agent fixes → new review loop
    │       (up to maxReviewLoops)
    ▼
  (if >1 loop happened)
  Final architecture review
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

### `.autoreview/review-rules.md`

Place in your git repo root to add project-specific review rules. These are appended to the default prompt:

```markdown
# Project review rules

- All API endpoints must validate input with zod schemas
- Database queries must use parameterized statements
- React components must have PropTypes or TypeScript props interface
- No console.log in production code (use logger)
```

### `.autoreview/roundup.md`

Customize the final "zoom out" roundup review. Runs automatically after mini-review loops complete with fixes:

```markdown
# Roundup review rules

- Verify module dependency graph has no cycles
- Check error handling is consistent across all modules
- Flag any TODO/FIXME comments added during fix loops
- Verify README and architecture docs still accurate
```

See `.autoreview-examples/roundup.md` for a full example.

### `.autoreview/settings.json`

```json
{
  "maxReviewLoops": 100
}
```

| Setting          | Type        | Default | Description                                  |
| ---------------- | ----------- | ------- | -------------------------------------------- |
| `maxReviewLoops` | integer > 0 | 100     | Max review→fix→review cycles before stopping |

If files are missing, defaults are used silently. If files are malformed, a clear warning is shown in pi's log.

## UX

### Status bar (bottom of pi)

- `auto-review on (Alt+R toggle)` — idle, no pending files
- `auto-review on · will review 3 files (Alt+R toggle)` — edits accumulating
- `auto-review reviewing… [2/100] (Ctrl+Alt+R to cancel)` — reviewer running
- `auto-review off (Alt+R toggle)` — disabled

### Keyboard shortcuts

| Key              | Action                                          |
| ---------------- | ----------------------------------------------- |
| **Alt+R**          | Toggle auto-review on/off (resets loop counter) |
| **Ctrl+Alt+R**      | Cancel in-progress review                       |
| **Ctrl+Alt+Cmd+R**  | Full reset: cancel, reset loops, clear all state |

### Command

```
/review    Toggle auto-review on/off
```

## Review loop behavior

1. Agent makes changes → review triggers
2. If issues found → agent fixes them → review triggers again
3. If LGTM → loop counter resets
4. If loop count reaches `maxReviewLoops` → stops with a warning
5. Toggling off/on with Alt+R or `/review` resets the counter

### Roundup review

If more than 1 review loop happened (meaning fixes were made), a final **roundup review** triggers automatically after LGTM. This "zoom out" review:

- Checks architecture coherence across all changes
- Verifies cross-file consistency
- Looks for accumulated tech debt from fix loops
- Validates documentation is still accurate
- Uses tools to explore the full codebase

Customize with `.autoreview/roundup.md`.

When issues are found, the agent is told **not to push** until the review cycle completes cleanly.

## What triggers a review

Only fires when file-modifying tools were used during the agent run:

- `write` — new files
- `edit` — file edits
- `bash` — commands matching file operations (`cp`, `mv`, `rm`, `sed -i`, `cat >`, `tee`, `mkdir`, `echo >`)

Pure read/search turns are skipped.

## License

MIT
