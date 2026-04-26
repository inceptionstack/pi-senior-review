# Judge Scenarios — Manual Test Plan

A runbook for verifying the pi-hard-no duplicate-review suppressor ("judge") end-to-end from a live pi session. Each scenario is a single agent turn whose observable outcome (chat message + `~/.pi/.hardno/review.log` entries) unambiguously confirms or denies a specific code path.

Complements the automated test suite (`test/judge.test.ts`, `test/judge-skip-chain.test.ts`, `test/orchestrator.test.ts > judge gate`) by covering the live wiring that unit tests can't reach: the pi SDK, the actual reviewer subprocess, the chat-message rendering, the status-bar updates, and the cross-session interactions that exposed the stale-ctx bug fixed in commit `52e5289`.

## What this proves

| #   | Scenario                                  | Code path validated                                                                                     |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | Judge OFF, ambiguous read-only bash       | orchestrator skips the judge gate entirely when `judgeEnabled: false`                                   |
| 2   | Judge ON, ambiguous read-only bash        | judge fires → `inspection_vcs_noop` → orchestrator skips with `judge_read_only`                         |
| 3   | Judge ON, modifying bash                  | judge fires → `modifying` → `isTurnReadOnlyViaJudge` returns false → review runs                        |
| 4   | Judge ON, write tool                      | judge bypassed before any LLM call (write/edit short-circuit)                                           |
| 5   | Post-`/reload` sub-session guard          | `isSpawnedSubSession(pi)` no-ops the reviewer-instance's `agent_end` (regression: `52e5289`)            |
| 6   | `/review-judge-toggle` status-bar refresh | Toggle immediately updates `⚖ judge` glyph even when `skipStatusShowing` is set (regression: `dc75b3b`) |

## Preconditions

- Live pi interactive session with pi-hard-no loaded
- Settings start at defaults (`judgeEnabled: false`, no `.hardno/settings.json` overrides)
- Working directory = this extension root (or any git repo; only Scenario 4 uses `/tmp/`)
- Optional: `/review-clean-logs` to get a clean log for diffing before/after

## Scenario 1 — Judge OFF, ambiguous read-only bash

**Trigger:**

```bash
echo "probe 1" && cat AGENTS.md | head -5
```

**Why this shape works:** `echo` is not in the static classifier's allowlist (`NON_MODIFYING_COMMAND_ROOTS` in `changes.ts`), so the compound is flagged as modifying. Path extraction picks up `AGENTS.md`, so `realFiles.size > 0`. The orchestrator reaches the judge gate — but since `judgeEnabled: false`, the gate is bypassed without an LLM call.

**Expected:**

- ❌ No `⚖️ Review skipped by judge` message in chat
- 📝 Log has NO `judge:` line for this turn
- 💬 Either silent (`getBestReviewContent` returns null → `no_meaningful_changes`) or a short ~5s review

**Pass signal:** absence of any `⚖️` message. The judge never ran.

## Scenario 2 — Judge ON, ambiguous read-only bash

**Setup:** `/review-judge-toggle` (status bar should gain `⚖ judge`)

**Trigger:**

```bash
echo "probe 2" && cat AGENTS.md | head -5
```

**Expected chat message (verbatim):**

> ⚖️ **Review skipped by judge** — all bash commands this turn classified as read-only (no file mutation). Skipping the main review.
>
> _Model: `us.anthropic.claude-haiku-4-5-20251001-v1:0` — toggle with `/review-judge-toggle`_

**Expected log line:**

```
[timestamp] judge: inspection_vcs_noop ← echo "probe 2" && cat AGENTS.md | head -5
```

**Pass signal:** chat message text matches exactly (including model footer), judge log line shows `inspection_vcs_noop`, no main review runs.

## Scenario 3 — Judge ON, modifying bash

**Trigger:**

```bash
echo "probe 3" && date > /tmp/lgtm-judge-test.txt && cat /tmp/lgtm-judge-test.txt && rm /tmp/lgtm-judge-test.txt
```

**Why this shape works:** `>` redirection and `rm` are both explicitly "modifying" in the judge's taxonomy prompt. Any one modifying subcommand in a compound → entire turn classified `modifying`.

**Expected:**

- ❌ No `⚖️ Review skipped by judge` message (judge ran but didn't cause skip)
- 📝 Log has a single `judge: modifying ← ...` line for this turn
- 💬 Status-bar skip: `✓ review skipped — no files to review` (downstream `no_meaningful_changes` because `/tmp/` isn't in any git repo)

**Pass signal:** judge log line shows `modifying`, no `⚖️` chat message.

## Scenario 4 — Judge ON, write tool (bypass)

**Trigger:** use the `write` tool to create any file in `/tmp/` (e.g. `/tmp/lgtm-judge-probe.txt`).

**Why write/edit bypass fires:** `isTurnReadOnlyViaJudge` in `orchestrator.ts` short-circuits with `return false` the moment it sees any `write` or `edit` tool call — BEFORE looping over bash calls. No LLM invocation, no latency cost.

**Expected:**

- ❌ No `⚖️ Review skipped by judge` message
- 📝 Log for this review cycle: NO `judge:` line at all
- ✅ Full review runs (~5–10s) via the tool-call fallback path in `context.ts` (the file is outside any git repo, so git-diff paths fall through)

**Pass signal:** a `✅ Automated Code Review …` chat message appears, and `grep '^\[.*\] judge:' ~/.pi/.hardno/review.log` shows NO new entries for this review's `review-id`.

## Scenario 5 — Post-`/reload` sub-session guard

Regression test for the stale-ctx + recursive-review bug fixed in `52e5289`.

**Setup:**

- Fresh `/reload` (or fresh session)
- Judge may be on or off — doesn't matter for this scenario

**Trigger:** repeat Scenario 4 (write tool to `/tmp/`).

**Why this specifically tests the fix:** The main session's `agent_end` starts a reviewer session via `runReviewSession` → `createAgentSession({...})`. pi's extension loader re-executes the pi-hard-no factory for the reviewer session, creating a fresh instance. When the reviewer completes its one-shot prompt, the reviewer session emits `agent_end` internally. The reviewer-instance's `agent_end` handler must detect it's running in a spawned sub-session and no-op.

**Expected log:**

- ✅ One `session-kind: spawned sub-session detected (tools=[read,bash,grep,find,ls]) — pi-hard-no hooks will no-op for this instance` line per review cycle (cached per-`pi`, so one per spawned session, not one per event)
- ❌ Zero `ERROR: Review failed (outer): This extension ctx is stale after session replacement or reload …` lines

**Fail signal (the original bug):** any `ctx is stale` line in the log. If present, the sub-session guard isn't firing.

## Scenario 6 — `/review-judge-toggle` status-bar refresh

Regression test for the cosmetic fix in `dc75b3b`.

**Setup:** put the status bar into a "skip" state by running a turn that produces a non-judge skip. E.g., with judge OFF:

```bash
cat AGENTS.md | head -5
```

(Pure read-only, static classifier says non-modifying → `hasFileChanges=false` → skip with `no_file_changes`.) Status bar shows `✓ review skipped — no file changes`.

**Trigger:** `/review-judge-toggle` → `/review-judge-toggle` (toggle on then off, or vice versa).

**Expected:** status bar refreshes on each toggle — `⚖ judge` glyph appears/disappears **immediately**. Previously (before `dc75b3b`) the toggle notification showed but the bar stayed pinned on the skip indicator until the next real file activity.

**Pass signal:** visual confirmation in the status bar. No log entry to check.

## Log verification cheatsheet

Useful `grep`s during/after a test run:

```bash
# Every judge classification this session
grep '^\[.*\] judge:' ~/.pi/.hardno/review.log

# Stale-ctx errors — MUST be empty after 52e5289
grep 'ctx is stale' ~/.pi/.hardno/review.log

# Sub-session guard firings — should appear once per reviewer session
grep 'session-kind:' ~/.pi/.hardno/review.log

# Full trace for one review cycle (replace review-id)
grep 'r-<id>' ~/.pi/.hardno/review.log
```

## Known-good output examples

From the live run on 2026-04-25 after landing `52e5289`:

```
[20:04:39.767Z] judge: inspection_vcs_noop ← echo "probe 2: judge ON, expect ⚖️ skip message in chat" && cat AGENTS.md | head
[20:05:28.636Z] judge: modifying ← echo "probe 3: judge ON + modifying bash — expect NO ⚖️ skip" && date > /tmp/lgt
```

And for Scenario 4 (no judge line for the `r-ebe88ff8` review cycle — bypass fired):

```
[20:06:22.895Z] [r-ebe88ff8] review cycle started (loop 1/100)
[20:06:28.812Z] [r-ebe88ff8] result: {"isLgtm":true,"durationMs":5868,"textLen":16}
```

## Troubleshooting

| Symptom                                    | Likely cause                                                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Judge didn't fire in Scenario 2            | Turn was skipped before the judge gate (e.g. `realFiles.size === 0`). Check that the bash command references a real file with an extension.                |
| `ctx is stale` error in log                | `session-kind.ts` → `isSpawnedSubSession` probe isn't detecting the reviewer session. Verify `pi.getAllTools()` returns no `write`/`edit` on the reviewer. |
| Scenario 6 toggle doesn't refresh          | `skipStatusShowing = false` missing from `/review-judge-toggle` handler (before `dc75b3b`).                                                                |
| Chain-cap message never appears (cap at 3) | Something else is resetting `judgeSkipChain` between skips (see `renderOutcome` branches in `index.ts`).                                                   |

## History

- 2026-04-25 — First captured during live test of judge feature + sub-session guard fix. Scenarios 1–4 informed the initial design; Scenarios 5–6 added after the post-reload stale-ctx bug surfaced and was fixed in `52e5289` / `dc75b3b`.
