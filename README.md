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
  (skip)      │
              ▼
    Feeds findings back to the main agent
    as a follow-up message
```

The reviewer checks for:

- Bugs, logic errors, off-by-one errors
- Security issues
- Missing error handling
- DRY violations

## UX

### Status bar (bottom of pi)

- `★ review on (Shift+R toggle)` — idle, no pending files
- `★ review on · will review 3 files (Shift+R toggle)` — edits accumulating
- `★ review reviewing… (Ctrl+Shift+R to cancel)` — reviewer running
- `☆ review off (Shift+R toggle)` — disabled

### Keyboard shortcuts

| Key              | Action                    |
| ---------------- | ------------------------- |
| **Shift+R**      | Toggle review on/off      |
| **Ctrl+Shift+R** | Cancel in-progress review |

### Command

```
/review    Toggle review on/off
```

## What triggers a review

Only fires when file-modifying tools were used during the agent run:

- `write` — new files
- `edit` — file edits
- `bash` — commands matching file operations (`cp`, `mv`, `rm`, `sed -i`, `cat >`, `tee`, `mkdir`, `echo >`)

Pure read/search turns are skipped. If the reviewer says "LGTM", no follow-up is injected.

## License

MIT
