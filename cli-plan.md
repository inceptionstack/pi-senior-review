# hardno-cli Extraction Plan

## 1. Goals & Non-goals

### Goals

- Extract the review pipeline from `@inceptionstack/pi-lgtm` into a separate npm package and CLI.
- Publish the new package as a standalone tool agents can run with `hardno review [path...]`.
- Keep `pi-lgtm` as the pi harness: event tracking, UI, status bar, chat messages, commands, push guard, and subprocess lifecycle.
- Enforce the boundary with subprocess-only integration. `pi-lgtm` must not import hardno library code.
- Preserve current behavior where practical: senior review, verdict parsing, architect review, config-driven prompts, ignore rules, judge gate, logging, timeout scaling, and context-overflow retry.
- Keep pi-sdk as the only review backend in v1, but introduce a backend interface so codex, Claude Code, direct API, and shell backends can be added later.
- Split tests by ownership and keep `npm run check` green in both repos at each commit.
- Release `pi-lgtm` `0.3.0` as a breaking migration from `.lgtm/` review config to `.hardno/`.

### Non-goals

- No monorepo. hardno lives in a separate repo.
- No git history preservation requirement for copied files.
- No multi-backend implementation in v1.
- No public commit-range flags, stdin mode, prompt flags, or backend flags in hardno v1.
- No pi UI, status bar, slash command, or chat-rendering code in hardno.
- No circular dependency between packages.

## 2. Proposed names

| Item        | Recommended                  | Alternatives                                            | Reasoning                                                       |
| ----------- | ---------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| GitHub repo | `inceptionstack/hardno-cli`  | `inceptionstack/hardno`, `inceptionstack/hardno-review` | Clear repo purpose; leaves room for future `hardno-*` packages. |
| npm package | `@inceptionstack/hardno-cli` | `@inceptionstack/hardno`, `hardno-cli`                  | Matches current npm scope and avoids unscoped name risk.        |
| CLI binary  | `hardno`                     | `hardno-cli`, `hn`                                      | Short, memorable, agent-friendly.                               |

Recommendation: repo `inceptionstack/hardno-cli`, npm package `@inceptionstack/hardno-cli`, binary `hardno`.

## 3. CLI v1 surface

### Commands

```bash
hardno review
hardno review <path>...
hardno --help
hardno --version
hardno review --help
```

`hardno review` reviews changed content in cwd using git-based heuristics.

`hardno review <path>...` treats paths as focus hints. It still uses git where possible and scopes file discovery to those paths when safe.

### Flags

```bash
--json          print one final JSON object instead of NDJSON
--no-progress   suppress progress events; still print final event
--help
--version
```

No v1 public flags for commit ranges, model selection, config paths, stdin, or backend selection. Those come from config/env.

**Precedence:** CLI flag > env var > config file > default. So `hardno review --json` wins over `HARDNO_OUTPUT=ndjson`, and `HARDNO_JUDGE_ENABLED=false` wins over `settings.json`'s `judge.enabled: true`.

### Output

Default stdout is NDJSON: one JSON event per line. Routine logs go to hardno log files, not stdout. stderr is diagnostic only.

`--json` emits the final `complete` event only.

### Event schema

```ts
type HardnoEvent =
  | StartedEvent
  | StatusEvent
  | ContentReadyEvent
  | ToolCallEvent
  | StepCompleteEvent
  | CompleteEvent;

interface BaseEvent {
  schemaVersion: 1;
  runId: string;
  timestamp: string;
}

interface StartedEvent extends BaseEvent {
  type: "started";
  command: "review";
  cwd: string;
  pathHints: string[];
  configSource: {
    settings: string | null;
    localDir: string;
    globalDir: string;
  };
}

interface StatusEvent extends BaseEvent {
  type: "status";
  phase:
    | "loading_config"
    | "detecting_changes"
    | "building_context"
    | "judge"
    | "reviewing"
    | "retrying_context"
    | "architect"
    | "writing_logs";
  message: string;
}

interface ContentReadyEvent extends BaseEvent {
  type: "content_ready";
  step: "senior";
  files: string[];
  label: string;
  isGitBased: boolean;
  loopCount: number;
  maxReviewLoops: number;
  timeoutMs: number;
}

interface ToolCallEvent extends BaseEvent {
  type: "tool_call";
  step: "senior" | "architect" | "judge";
  reviewId: string;
  toolName: string;
  targetPath: string | null;
}

interface StepCompleteEvent extends BaseEvent {
  type: "step_complete";
  step: "senior" | "architect";
  reviewId: string;
  isLgtm: boolean;
  durationMs: number;
  model: string;
  thinkingLevel: string;
  toolCallCount: number;
}

interface CompleteEvent extends BaseEvent {
  type: "complete";
  outcome: "lgtm" | "issues_found" | "skipped" | "error" | "cancelled";
  exitCode: number;
  files: string[];
  senior?: ReviewStepResult;
  architect?: ReviewStepResult;
  architectFailure?: { reviewId: string; message: string };
  skipped?: SkipReason;
  error?: HardnoError;
  judge?: JudgeSummary;
}

type SkipReason =
  | "disabled"
  | "no_file_changes"
  | "no_real_files"
  | "formatting_only"
  | "judge_read_only"
  | "no_meaningful_changes"
  | "fallback_too_small"
  | "duplicate_content"
  | "max_loops";

interface ReviewStepResult {
  reviewId: string;
  label: string;
  isLgtm: boolean;
  text: string;
  rawText: string;
  durationMs: number;
  model: string;
  thinkingLevel: string;
  toolCalls: Array<{ name: string; args?: unknown; timestamp: string }>;
  loopInfo?: string;
}

interface HardnoError {
  code:
    | "CONFIG_ERROR"
    | "BACKEND_AUTH_ERROR"
    | "BACKEND_NOT_AVAILABLE"
    | "REVIEW_TIMEOUT"
    | "REVIEW_CANCELLED"
    | "CONTEXT_ERROR"
    | "UNKNOWN";
  message: string;
  reviewId?: string;
  stack?: string;
}

interface JudgeSummary {
  model: string;
  classifications: Array<{
    command: string;
    classification: "inspection_vcs_noop" | "modifying" | "unsure";
  }>;
}
```

### Exit codes

| Code | Meaning                                 |
| ---- | --------------------------------------- |
| `0`  | LGTM or skipped for a non-error reason. |
| `1`  | Review completed and found issues.      |
| `2`  | Config error.                           |
| `3`  | Backend/auth/model unavailable.         |
| `4`  | Review timeout.                         |
| `5`  | Cancelled by signal or stdin close.     |
| `6`  | Unexpected internal error.              |

`pi-lgtm` must parse the final `complete` event and treat exit code as secondary.

### Examples

```bash
hardno review
hardno review index.ts orchestrator.ts
hardno review --json
hardno review --no-progress src/reviewer.ts
```

## 4. Config file format

### Locations

Hardno owns its config.

Precedence:

1. Project-local: `<cwd>/.hardno/`
2. Global: `$XDG_CONFIG_HOME/hardno/`
3. Global fallback: `~/.config/hardno/`

Hardno does not read `.lgtm/` or `~/.pi/.lgtm/`.

### Files

```text
.hardno/
  settings.json
  auto-review.md
  review-rules.md
  architect.md
  ignore
```

### TypeScript schema

```ts
export interface HardnoSettings {
  enabled: boolean;
  maxReviewLoops: number;
  backend: { id: "pi-sdk" };
  senior: ReviewerSettings;
  architect: ArchitectSettings;
  judge: JudgeSettings;
  context: ContextSettings;
  logging: LoggingSettings;
}

export interface ReviewerSettings {
  model: string;
  thinkingLevel: ThinkingLevel;
  timeoutMs: number;
}

export interface ArchitectSettings {
  enabled: boolean;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  timeoutMs?: number;
}

export interface JudgeSettings {
  enabled: boolean;
  model: string;
  timeoutMs: number;
  maxSkipChain: number;
}

export interface ContextSettings {
  maxFileSize: number;
  maxTotalContentSize: number;
  maxDiffSize: number;
  fallbackMaxFileSize: number;
  fallbackMaxTotalContentSize: number;
  fallbackMaxDiffSize: number;
}

export interface LoggingSettings {
  dir: string | null;
  structuredRecords: boolean;
  maxLogBytes: number;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
```

### Defaults

```json
{
  "enabled": true,
  "maxReviewLoops": 100,
  "backend": { "id": "pi-sdk" },
  "senior": {
    "model": "amazon-bedrock/us.anthropic.claude-opus-4-6-v1",
    "thinkingLevel": "off",
    "timeoutMs": 120000
  },
  "architect": { "enabled": true },
  "judge": {
    "enabled": false,
    "model": "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "timeoutMs": 10000,
    "maxSkipChain": 3
  },
  "context": {
    "maxFileSize": 80000,
    "maxTotalContentSize": 400000,
    "maxDiffSize": 200000,
    "fallbackMaxFileSize": 10000,
    "fallbackMaxTotalContentSize": 60000,
    "fallbackMaxDiffSize": 30000
  },
  "logging": {
    "dir": null,
    "structuredRecords": true,
    "maxLogBytes": 1000000
  }
}
```

### Env overrides

| Env var                       | Setting                       |
| ----------------------------- | ----------------------------- |
| `HARDNO_ENABLED`              | `enabled`                     |
| `HARDNO_MODEL`                | `senior.model`                |
| `HARDNO_THINKING_LEVEL`       | `senior.thinkingLevel`        |
| `HARDNO_REVIEW_TIMEOUT_MS`    | `senior.timeoutMs`            |
| `HARDNO_MAX_REVIEW_LOOPS`     | `maxReviewLoops`              |
| `HARDNO_ARCHITECT_ENABLED`    | `architect.enabled`           |
| `HARDNO_ARCHITECT_MODEL`      | `architect.model`             |
| `HARDNO_ARCHITECT_TIMEOUT_MS` | `architect.timeoutMs`         |
| `HARDNO_JUDGE_ENABLED`        | `judge.enabled`               |
| `HARDNO_JUDGE_MODEL`          | `judge.model`                 |
| `HARDNO_JUDGE_TIMEOUT_MS`     | `judge.timeoutMs`             |
| `HARDNO_JUDGE_MAX_SKIP_CHAIN` | `judge.maxSkipChain`          |
| `HARDNO_LOG_DIR`              | `logging.dir`                 |
| `HARDNO_OUTPUT`               | `ndjson` or `json`            |
| `HARDNO_NO_PROGRESS`          | suppress progress when `true` |

`ContextSettings` fields (`maxFileSize`, `maxTotalContentSize`, `maxDiffSize`, and their fallback counterparts) intentionally have NO env var overrides — they're deep-tuning parameters most users will never touch, and adding six more `HARDNO_CONTEXT_*` env vars would bloat the surface area without a clear use case. Override via config file only. Adding env vars later is non-breaking.

Private subprocess env:

| Env var                     | Purpose                                                          |
| --------------------------- | ---------------------------------------------------------------- |
| `HARDNO_HARNESS_EVENT_FILE` | JSON metadata file written by `pi-lgtm`; not public CLI surface. |
| `HARDNO_RUN_ID`             | Optional run id for correlation.                                 |

### Harness event file

`pi-lgtm` writes this temp file before spawning hardno so hardno can preserve judge behavior and change summaries.

```ts
interface HardnoHarnessEventFile {
  schemaVersion: 1;
  harness: "pi-lgtm";
  harnessVersion: string;
  cwd: string;
  lastUserMessage: string | null;
  modifiedFiles: string[];
  pathHints: string[];
  detectedGitRoots: string[];
  toolCalls: Array<{ name: string; input: unknown; result?: string }>;
}
```

### Migration from `.lgtm/settings.json`

| Old key/file                          | New key/file                                             |
| ------------------------------------- | -------------------------------------------------------- |
| `maxReviewLoops`                      | `maxReviewLoops`                                         |
| `model`                               | `senior.model`                                           |
| `thinkingLevel`                       | `senior.thinkingLevel`                                   |
| `architectEnabled` / `roundupEnabled` | `architect.enabled`                                      |
| `reviewTimeoutMs`                     | `senior.timeoutMs`                                       |
| `judgeEnabled`                        | `judge.enabled`                                          |
| `judgeModel`                          | `judge.model`                                            |
| `judgeTimeoutMs`                      | `judge.timeoutMs`                                        |
| `.lgtm/auto-review.md`                | `.hardno/auto-review.md`                                 |
| `.lgtm/review-rules.md`               | `.hardno/review-rules.md`                                |
| `.lgtm/architect.md`                  | `.hardno/architect.md`                                   |
| `.lgtm/roundup.md`                    | `.hardno/architect.md`                                   |
| `.lgtm/ignore`                        | `.hardno/ignore`                                         |
| `toggleShortcut`, `cancelShortcut`    | pi-lgtm harness config if retained; not hardno settings. |

### Auth

V1 hardno uses `@mariozechner/pi-coding-agent` auth storage internally. The user must already have pi-sdk auth configured for the selected model. Missing auth/model maps to `BACKEND_AUTH_ERROR` or `BACKEND_NOT_AVAILABLE`.

**V1 limitation (prominent):** this hard dependency on pi-sdk auth means hardno v1 is NOT fully standalone in the "install and go" sense — users need pi-sdk's auth flow completed (e.g. `pi auth login <provider>`) even if they only plan to use hardno from codex or claude. This contradicts the long-term "decoupled from any specific harness" goal but is the pragmatic v1 shortcut per the user's answer to Q3. Document in the hardno README under a `## Prerequisites (v1)` section. v2 should introduce a native auth storage (or a pluggable auth provider) so hardno stands alone.

## 5. Module inventory

| File                               | Destination                                  | Action                                                                                           |
| ---------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `orchestrator.ts`                  | `hardno-cli/src/orchestrator.ts`             | Move; adapt input to hardno request and event output.                                            |
| `reviewer.ts`                      | `hardno-cli/src/backends/pi-sdk-reviewer.ts` | Move substantially unchanged; pi-sdk backend only.                                               |
| `context.ts`                       | `hardno-cli/src/context.ts`                  | Move; replace `ExtensionAPI.exec` with `CommandRunner`; support path hints and harness metadata. |
| `prompt.ts`                        | `hardno-cli/src/prompt.ts`                   | Move; update comments from `.lgtm` to `.hardno`.                                                 |
| `judge.ts`                         | `hardno-cli/src/judge.ts`                    | Move; keep fail-open classifier.                                                                 |
| `judge-skip-chain.ts`              | `hardno-cli/src/judge-skip-chain.ts`         | Move; hardno emits skip-chain state/results.                                                     |
| `architect.ts`                     | `hardno-cli/src/architect.ts`                | Move; read `.hardno/architect.md`; drop `roundup.md` fallback.                                   |
| `settings.ts`                      | `hardno-cli/src/settings.ts`                 | Move and rewrite to hardno schema; remove shortcuts.                                             |
| `helpers.ts`                       | `hardno-cli/src/helpers.ts`                  | Move; add `createRunId`.                                                                         |
| `git-roots.ts`                     | `hardno-cli/src/git-roots.ts`                | Move; use `CommandRunner`.                                                                       |
| `ignore.ts`                        | `hardno-cli/src/ignore.ts`                   | Move; update config comments.                                                                    |
| `logger.ts`                        | `hardno-cli/src/logger.ts`                   | Move; default log dir becomes hardno state dir.                                                  |
| `default-review-rules.md`          | `hardno-cli/default-review-rules.md`         | Move.                                                                                            |
| `changes.ts`                       | `pi-lgtm/changes.ts`                         | Stays; pi-specific tool-call classification.                                                     |
| `message-sender.ts`                | `pi-lgtm/message-sender.ts`                  | Stays; modify to accept hardno result shapes.                                                    |
| `review-display.ts`                | `pi-lgtm/review-display.ts`                  | Stays; feed from NDJSON events.                                                                  |
| `commands.ts`                      | `pi-lgtm/commands.ts`                        | Stays; shell out to hardno where applicable.                                                     |
| `session-kind.ts`                  | `pi-lgtm/session-kind.ts`                    | Stays; still protects pi extension instances.                                                    |
| `scaffold.ts`                      | `pi-lgtm/scaffold.ts`                        | Stays; scaffold `.hardno/` files.                                                                |
| `index.ts`                         | `pi-lgtm/index.ts`                           | Stays; replace in-process pipeline with subprocess orchestration.                                |
| `test/orchestrator.test.ts`        | hardno                                       | Move.                                                                                            |
| `test/reviewer.test.ts`            | hardno                                       | Move.                                                                                            |
| `test/context.test.ts`             | hardno                                       | Move and adapt mocks.                                                                            |
| `test/prompt.test.ts`              | hardno                                       | Move.                                                                                            |
| `test/judge.test.ts`               | hardno                                       | Move.                                                                                            |
| `test/judge-skip-chain.test.ts`    | hardno                                       | Move.                                                                                            |
| `test/architect.test.ts`           | hardno                                       | Move.                                                                                            |
| `test/settings.test.ts`            | split                                        | Hardno gets review config; pi-lgtm keeps harness config if any.                                  |
| `test/helpers.test.ts`             | hardno                                       | Move.                                                                                            |
| `test/git-roots.test.ts`           | hardno                                       | Move and adapt.                                                                                  |
| `test/ignore.test.ts`              | hardno                                       | Move.                                                                                            |
| `test/changes.test.ts`             | pi-lgtm                                      | Stays.                                                                                           |
| `test/message-sender.test.ts`      | pi-lgtm                                      | Stays and update.                                                                                |
| `test/review-display.test.ts`      | pi-lgtm                                      | Stays.                                                                                           |
| `test/session-kind.test.ts`        | pi-lgtm                                      | Stays.                                                                                           |
| `hardno-cli/src/bin/hardno.ts`     | new                                          | CLI entrypoint.                                                                                  |
| `hardno-cli/src/run-review.ts`     | new                                          | Runtime orchestration.                                                                           |
| `hardno-cli/src/events.ts`         | new                                          | Event schema and writer.                                                                         |
| `hardno-cli/src/command-runner.ts` | new                                          | Node command runner.                                                                             |
| `hardno-cli/src/harness-input.ts`  | new                                          | Validate optional harness metadata file.                                                         |
| `pi-lgtm/hardno-subprocess.ts`     | new                                          | Spawn hardno, parse NDJSON, cancel child.                                                        |

## 6. Module boundary design

### hardno-cli entrypoints

`src/bin/hardno.ts`:

- Parse argv.
- Handle `review`, help, version.
- Install `SIGINT`, `SIGTERM`, and stdin-close cancellation.
- Call `runReviewCli`.
- Emit NDJSON or final JSON.
- Exit with mapped code.

`src/index.ts`:

```ts
export type {
  HardnoSettings,
  HardnoEvent,
  HardnoCompleteEvent,
  HardnoReviewRequest,
} from "./public-types";
export { runReview } from "./run-review";
export { loadSettings, parseSettings } from "./settings";
```

Package exports exist for tests and future embedders. `pi-lgtm` must not use them.

### Backend interface

```ts
export interface ReviewBackend {
  id: string;
  run(prompt: string, opts: ReviewBackendOptions): Promise<ReviewResult>;
  classifyBashCommand?: (command: string, opts: JudgeOptions) => Promise<BashClassification>;
}

export interface ReviewBackendOptions {
  cwd: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  timeoutMs: number;
  /** Abort signal for cancellation; backends MUST honor it and call session.abort() equivalent. */
  signal: AbortSignal;
  /** Optional: fires for each tool call the backend makes during the review (for TUI widget updates). */
  onToolCall?: (toolName: string, targetPath: string | null) => void;
  /** Optional: fires for status-level activity ("reading foo.ts", "thinking", etc.). */
  onActivity?: (description: string) => void;
  /** Tools the backend is allowed to use during the review. Default: read-only set (`read`, `bash`, `grep`, `find`, `ls`). */
  allowedTools?: string[];
}

export interface ReviewResult {
  /** Full cleaned review text (verdict tag stripped). */
  text: string;
  /** Raw model output before cleanup (for debugging/logs). */
  rawText: string;
  /** True if the backend parsed `<verdict>LGTM</verdict>` or inferred LGTM. */
  isLgtm: boolean;
  /** Wall-clock review duration. */
  durationMs: number;
  /** Tool calls the backend made, in order. */
  toolCalls: Array<{ name: string; args?: unknown; timestamp: string }>;
  /** `"provider/model-id"` of the model that actually answered. */
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface JudgeOptions {
  cwd: string;
  model: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export type BashClassification = "inspection_vcs_noop" | "modifying" | "unsure";
```

The orchestrator depends on this interface, not pi-sdk. V1 ships only `PiSdkBackend`. The `signal` parameter is load-bearing for cancellation — backends MUST propagate it to their session/HTTP layer so `SIGTERM` at the CLI translates to an actual in-flight abort, not just a hung subprocess.

> Future-proofing note: v2 should make `@mariozechner/pi-coding-agent` a **peer dependency** so alternate backends (codex, claude, direct API) don't force users to install pi-sdk. In v1 it stays as a regular dep because `PiSdkBackend` is the only backend and needs it anyway.

## 7. Subprocess interface

### Spawn shape

```ts
spawn("hardno", ["review", ...pathHints], {
  cwd: ctx.cwd,
  env: {
    ...process.env,
    HARDNO_OUTPUT: "ndjson",
    HARDNO_RUN_ID: runId,
    HARDNO_HARNESS_EVENT_FILE: tempJsonPath,
  },
  stdio: ["pipe", "pipe", "pipe"],
});
```

Path hints are capped to avoid arg limits. The full path/tool-call set lives in the harness event file.

### stdout/stderr

stdout is NDJSON only. stderr is diagnostics only; pi-lgtm captures the last 16 KiB. Unknown event types are logged and ignored. If the child exits without a final `complete`, pi-lgtm renders a review failure with exit code and stderr tail.

### Progress mapping

| hardno event          | pi-lgtm behavior                                         |
| --------------------- | -------------------------------------------------------- |
| `started`             | Clear skip status; set reviewing status.                 |
| `status`              | Update widget activity when available.                   |
| `content_ready`       | Start `review-display.ts` widget with files and timeout. |
| `tool_call` senior    | `reviewDisplay.recordToolCall`.                          |
| `tool_call` architect | Switch/keep architect mode and record call.              |
| `step_complete`       | Log/status only.                                         |
| `complete`            | Stop widget and render chat/status.                      |

### Cancellation

1. pi-lgtm sends `SIGTERM`.
2. hardno aborts the active pi-sdk session and emits `outcome: "cancelled"` if possible.
3. If the child is still running after 5 seconds, pi-lgtm sends `SIGKILL`.
4. stdin close also cancels hardno to avoid orphaned reviewer sessions.

## 8. Phased migration plan

### Phase 0 - Prep

Step 0.1: Baseline pi-lgtm.

- Repo: `pi-lgtm`.
- Files: none.
- Run `npm run check`.
- Done when current checks are green and current test count is recorded.

Step 0.2: Add architecture note.

- Repo: `pi-lgtm`.
- Files: `ARCHITECTURE.md`, `CHANGELOG.md`.
- Add an unreleased `0.3.0` note for planned subprocess boundary.
- Done when docs change only and `npm run check` is green.

### Phase 1 - Scaffold hardno-cli

Step 1.1: Create repo skeleton.

- Repo: `hardno-cli`.
- Files: `package.json`, `tsconfig.json`, ESLint/Prettier config, `README.md`, `CHANGELOG.md`, `LICENSE`, `src/bin/hardno.ts`, `src/index.ts`, `test/smoke.test.ts`.
- Add `@mariozechner/pi-coding-agent`, TypeScript, Vitest, ESLint, Prettier.
- Done when `npm run check` passes.

Step 1.2: Add event foundation.

- Files: `src/events.ts`, `src/exit-codes.ts`, `src/public-types.ts`, tests.
- Done when fake NDJSON and final JSON output are tested.

### Phase 2 - Copy and adapt pipeline

Step 2.1: Move pure modules.

- Copy: `helpers.ts`, `prompt.ts`, `ignore.ts`, `default-review-rules.md`.
- Move tests: helpers, prompt, ignore.
- Update `.lgtm` comments to `.hardno`.
- Done when moved tests pass.

Step 2.2: Rewrite settings.

- Files: `src/settings.ts`, `test/settings.test.ts`, README config section.
- Cover local/global precedence, env overrides, unknown keys, and ignored `.lgtm`.
- Move ONLY the review-config portion of pi-lgtm's `test/settings.test.ts` (tests for `judgeEnabled`, `judgeModel`, `judgeTimeoutMs`, `maxReviewLoops`, `model`, `thinkingLevel`, `architectEnabled`, `reviewTimeoutMs`). Leave harness-config tests (shortcuts, anything pi-specific) in pi-lgtm for now — they'll be deleted in Step 4.4 if pi-lgtm ends up with no harness config.
- Done when hardno settings tests pass AND the pi-lgtm side still compiles (orphaned tests for deleted keys removed or gated).

Step 2.3: Add `CommandRunner`.

- Files: `src/command-runner.ts`, `src/git-roots.ts`, `src/context.ts`.
- Replace `pi.exec` with `CommandRunner.exec`.
- Done when context/git-root tests pass without pi extension API.

Step 2.4: Move logger.

- Files: `src/logger.ts`, optional `test/logger.test.ts`.
- Default logs to `$XDG_STATE_HOME/hardno` or `~/.local/state/hardno`.
- Include run id and review id in records.
- Done when no hardno code contains `.pi/.lgtm`.

Step 2.5: Move reviewer backend.

- Files: `src/backends/types.ts`, `src/backends/pi-sdk-reviewer.ts`, reviewer tests.
- Keep read-only tools, verdict retry, timeout, cancellation, and structured tool call callbacks.
- Done when reviewer tests pass.

Step 2.6: Move judge.

- Files: `src/judge.ts`, `src/judge-skip-chain.ts`, tests.
- Preserve fail-open behavior.
- Emit classification details in final events when available.
- Done when judge tests pass.

Step 2.7: Move architect.

- Files: `src/architect.ts`, tests.
- Use `.hardno/architect.md`; remove `roundup.md` fallback.
- Done when architect tests pass.

Step 2.8: Move orchestrator.

- Files: `src/orchestrator.ts`, `src/run-review.ts`, orchestrator tests.
- New request shape includes cwd, path hints, optional harness metadata, settings, rules, ignore patterns, and abort signal.
- Preserve skip reasons, retry with fallback limits, senior/architect sequencing, and judge gate.
- Done when orchestrator has no pi extension imports and tests pass.

### Phase 3 - Finish hardno CLI

Step 3.1: Implement runtime.

- Files: `src/run-review.ts`, `src/harness-input.ts`, `src/bin/hardno.ts`.
- Load config/rules/ignore, validate harness metadata, wire backend, emit events, map exit codes.
- Done when mocked `hardno review --json` tests pass.

Step 3.2: Add subprocess-level tests.

- Files: `test/cli.test.ts`, fixtures.
- Cover help, NDJSON, JSON, invalid config, cancellation, and issues exit code.
- Done when `npm run check` passes.

Step 3.3: Package hardno.

- Version `0.1.0`.
- Run `npm pack` or publish.
- Done when pi-lgtm can install the tarball/package.

### Phase 4 - Integrate pi-lgtm

Step 4.1: Add dependency and subprocess runner.

- Repo: `pi-lgtm`.
- Files: `package.json`, `hardno-subprocess.ts`, `test/hardno-subprocess.test.ts`.
- Tests cover NDJSON parsing, malformed lines, stderr tail, no final event, issues exit code, and cancellation.
- Done when checks pass with fake child process.

Step 4.2: Replace auto-review wiring.

- Files: `index.ts`, `message-sender.ts`, tests.
- Remove imports from moved modules.
- Write `HardnoHarnessEventFile` to temp file with `0600`.
- Spawn hardno, feed progress to widget, render final result.
- Done when auto-review tests pass with fake hardno output.

Step 4.3: Update commands and scaffold.

- Files: `commands.ts`, `scaffold.ts`, command tests if present.
- `/review` toggle stays.
- `/review-all` shells out to `hardno review`.
- `/scaffold-review-files` creates `.hardno/`.
- `/lgtm-rules` edits `.hardno/review-rules.md` or is renamed with alias.
- `/review-judge-toggle` becomes a session env override or is documented as removed.
- Decide `/review <N>`: retain as pi-only legacy or remove in `0.3.0`.
- Done when commands no longer import moved pipeline modules.

Step 4.4: Delete moved pi-lgtm files.

- Delete moved pipeline files and tests from pi-lgtm.
- Keep `changes.ts`, `message-sender.ts`, `review-display.ts`, `commands.ts`, `session-kind.ts`, `scaffold.ts`.
- Done when `rg` finds no deleted imports and `npm run check` passes.

### Phase 5 - Docs and release

Step 5.1: hardno docs.

- Files: `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`.
- Document install, config, CLI, NDJSON, auth, logs, and limitations.
- Done when docs match behavior.

Step 5.2: pi-lgtm docs.

- Files: `README.md`, `ARCHITECTURE.md`, `AGENTS.md`, `CHANGELOG.md`, `plan.md`, `judge-scenarios-manual-test.md`.
- Document `0.3.0` breaking migration and subprocess architecture.
- Done when docs no longer claim pi-lgtm owns the review pipeline.

Step 5.3: publish.

- Publish `@inceptionstack/hardno-cli@0.1.0`.
- Bump `@inceptionstack/pi-lgtm` to `0.3.0`.
- Run `npm run check` in both repos.
- Publish pi-lgtm.
- Done when both install cleanly from npm.

## 9. Testing strategy

### Move to hardno

- `architect.test.ts`
- `context.test.ts`
- `git-roots.test.ts`
- `helpers.test.ts`
- `ignore.test.ts`
- `judge.test.ts`
- `judge-skip-chain.test.ts`
- `orchestrator.test.ts`
- `prompt.test.ts`
- `reviewer.test.ts`
- review-config parts of `settings.test.ts`

### Stay in pi-lgtm

- `changes.test.ts`
- `message-sender.test.ts`
- `review-display.test.ts`
- `session-kind.test.ts`
- harness settings tests if shortcuts remain

### New hardno tests

- CLI argument parsing.
- NDJSON writer and final JSON output.
- Config precedence and env overrides.
- Harness event file validation.
- Path-hint scoping.
- Command timeout.
- Cancellation.
- Backend auth/model error mapping.

### New pi-lgtm tests

- `hardno-subprocess.ts` parses progress and final events.
- Malformed NDJSON is logged, not fatal.
- Child exit without final event renders failure.
- Cancellation sends `SIGTERM` then `SIGKILL`.
- Harness event file includes tool calls, modified files, git roots, and last user message.
- Widget receives `content_ready` and `tool_call`.
- Judge skip final event produces persistent chat behavior.
- Push guard blocks while hardno runs and after `issues_found`.

## 10. Risk register

| Risk                                                           | Mitigation                                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Users put config in `.lgtm/` and hardno ignores it.            | `started` event includes config source; docs and `0.3.0` changelog show migration table. |
| Streaming progress buffers until exit.                         | NDJSON writes flush per line; test with slow fake child.                                 |
| pi-sdk auth missing outside pi process.                        | Map to `BACKEND_AUTH_ERROR`; document pi-sdk auth as v1 hard dependency.                 |
| Judge loses pi bash context.                                   | Use `HARDNO_HARNESS_EVENT_FILE` with tool calls.                                         |
| Too many path args exceed OS limits.                           | Cap args; put full path list in harness event file.                                      |
| Temp harness file leaks sensitive data.                        | Create with `0600`; truncate tool results; delete in `finally`.                          |
| Child review survives cancel.                                  | SIGTERM, 5-second grace, SIGKILL, stdin-close abort.                                     |
| Logs collide across concurrent runs.                           | Include `runId` and `reviewId` in log lines and filenames.                               |
| Exit code `1` for issues is treated as failure.                | pi-lgtm trusts final JSON, not exit code alone.                                          |
| Context changes review wrong files.                            | Port context tests first; add path-hint and harness tests.                               |
| Sub-session recursion returns because pi-sdk loads extensions. | Keep `session-kind.ts`; rerun live stale-ctx scenario.                                   |
| `/review <N>` has no hardno equivalent.                        | Decide in Phase 4.3; either retain pi-only or document removal.                          |

## 11. Open questions

- Confirm package name: recommended `@inceptionstack/hardno-cli`.
- Confirm repo name: recommended `inceptionstack/hardno-cli`.
- Publish hardno public immediately or private-first?
- Keep tiny pi-lgtm harness config for shortcuts, or remove pi-lgtm config entirely?
- Retain `/review <N>` as pi-only legacy, or remove it in `0.3.0`?
- Should `/review-clean-logs` clean hardno logs, pi-lgtm logs, or both?
- Use `$XDG_STATE_HOME/hardno` for logs, or `$XDG_CONFIG_HOME/hardno/logs`?
- Should hardno exit `1` on issues? Recommendation: yes.
- Should hardno export `runReview` from package root? Recommendation: yes for tests/future use, but pi-lgtm must not import it.

## 12. Execution checklist

1. Create `inceptionstack/hardno-cli`; done when TypeScript, lint, format, tests, and `npm run check` pass.
2. Add hardno event types and NDJSON writer; done when tests prove valid progress/final events.
3. Copy pure modules; done when helpers, prompt, and ignore tests pass in hardno.
4. Rewrite settings for `.hardno/`; done when config precedence and env tests pass.
5. Add `CommandRunner`; done when context/git-root code has no pi extension imports.
6. Move and adapt `context.ts`; done when fallback paths and path hints are tested.
7. Move `logger.ts`; done when logs use hardno paths and no `.pi/.lgtm` remains.
8. Move `reviewer.ts` to `backends/pi-sdk-reviewer.ts`; done when verdict, retry, timeout, and cancel tests pass.
9. Move judge modules; done when fail-open and skip-chain tests pass.
10. Move architect module; done when trigger and prompt tests pass.
11. Move orchestrator; done when senior, retry, skip, judge, issues, LGTM, and architect tests pass.
12. Implement `run-review.ts` and `bin/hardno.ts`; done when mocked `hardno review --json` works.
13. Add hardno CLI tests; done when help, JSON, NDJSON, invalid config, cancellation, and issue exit code are covered.
14. Package hardno `0.1.0`; done when `npm pack` creates an installable tarball.
15. Add hardno dependency to pi-lgtm; done when install succeeds.
16. Add `hardno-subprocess.ts`; done when fake child tests cover parsing and cancellation.
17. Replace auto-review in `index.ts`; done when fake hardno auto-review tests pass.
18. Update `message-sender.ts`; done when it renders hardno result shapes.
19. Update `commands.ts` and `scaffold.ts`; done when they do not import moved modules and scaffold `.hardno/`.
20. Delete moved pi-lgtm files/tests; done when no deleted imports remain and checks pass.
21. Update hardno docs; done when install, config, CLI, NDJSON, auth, and limitations are documented.
22. Update pi-lgtm docs; done when `0.3.0` migration and subprocess architecture are documented.
23. Run hardno live smoke tests; done when `hardno review` and `hardno review <path>` complete.
24. Run pi-lgtm live smoke tests; done when auto-review, cancel, judge, architect, and push guard work.
25. Publish hardno `0.1.0`; done when npm install works in a clean project.
26. Publish pi-lgtm `0.3.0`; done when npm install loads pi-lgtm and it can spawn `hardno`.
