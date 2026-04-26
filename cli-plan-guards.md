# hardno Guards Design

## 1. Problem & scope

Hardno v1.0 extracts review from `pi-hard-no`. Guards are the v1.1+ addition that
makes hardno a cross-harness project-policy engine for bash commands. A harness
asks hardno before a command runs; hardno returns `allow`, `warn`, or `block`.

Motivating policies:

- Block `git push` while review is pending, running, or last found issues.
- Block `git commit --amend` when project policy forbids rewriting commits.

Guards do:

- Evaluate one bash command before execution.
- Parse compound commands such as `git add . && git commit --amend && git push`.
- Read project/global policy and compute review/git/worktree state.
- Return deterministic JSON, stable exit codes, and audit records.
- Tell the agent why a command was blocked and what to do instead.

Guards do not:

- Execute commands.
- Replace `hardno review`.
- Depend on an LLM for v1 decisions.
- Provide OS sandboxing.
- Fully interpret every shell feature. Unsupported syntax uses per-rule
  `onError`.

The harness plugins should each be thin and native. All policy, parsing, state,
audit, override, and failure logic lives in `hardno`.

## 2. CLI surface

Recommended v1.1:

```bash
hardno guard "<cmd>"
hardno guard --json "<cmd>"
hardno guard --stdin --json
hardno guard status --json
```

Deferred: `hardno guard audit --last 20 --json`,
`hardno guard explain "<cmd>"`, and
`hardno guard test --policy .hardno/guards.json "<cmd>"`.

Flags:

```text
--json              Emit one JSON object.
--stdin             Read command from stdin.
--cwd <path>        Evaluate from this cwd. Default: process cwd.
--harness <name>    pi-hard-no | claude-code | codex | standalone | unknown.
--session-id <id>   Optional audit/session correlation.
--tool-call-id <id> Optional audit/tool correlation.
--source <source>   agent_tool | user_bash | user_input | extension | unknown.
--state-file <path> Override state path, mostly tests.
--policy <path>     Add/override policy file, mostly tests.
--no-cache          Bypass caches.
--explain           Include parser/rule diagnostics.
```

Exit codes:

```text
0 allow
10 warn
11 block
12 override_applied
2 config error
3 policy parse/validation error
4 state resolution error
5 parse error with fail-closed effective policy
6 unexpected internal error
```

Harnesses parse JSON first and use exit code as secondary.

JSON output:

```ts
type GuardDecision = "allow" | "warn" | "block";
type GuardSource = "agent_tool" | "user_bash" | "user_input" | "extension" | "unknown";
interface GuardResult {
  schemaVersion: 1;
  command: "guard";
  runId: string;
  timestamp: string;
  cwd: string;
  harness: "pi-hard-no" | "claude-code" | "codex" | "standalone" | "unknown";
  source: GuardSource;
  input: { command: string; argv?: string[] };
  decision: GuardDecision;
  exitCode: number;
  reason: string;
  suggestion: string | null;
  override: {
    allowed: boolean;
    applied: boolean;
    env: string | null;
    value: string | null;
    reasonRequired: boolean;
  };
  matchedRules: MatchedRule[];
  effectiveRule: MatchedRule | null;
  state: GuardStateSummary;
  audit: { written: boolean; path: string | null; id: string | null };
  diagnostics?: GuardDiagnostics;
  error?: GuardError;
}
interface MatchedRule {
  id: string;
  source: "builtin" | "global" | "project" | "cli";
  action: GuardDecision;
  priority: number;
  severity: "info" | "warning" | "error";
  reason: string;
  suggestion: string | null;
  overrideEnv: string | null;
  matchedPart: { index: number; text: string; normalized: string } | null;
}
interface GuardStateSummary {
  review: {
    enabled: boolean;
    pending: boolean;
    reviewing: boolean;
    lastOutcome: "lgtm" | "issues_found" | "skipped" | "error" | "unknown";
    lastHadIssues: boolean;
    pendingFiles: string[];
    stateSource: string | null;
    ageMs: number | null;
  };
  git: {
    isRepo: boolean;
    root: string | null;
    branch: string | null;
    protectedBranch: boolean;
    hasStagedChanges: boolean | null;
    hasUnstagedChanges: boolean | null;
    ahead: number | null;
    behind: number | null;
  };
  policy: {
    projectPath: string | null;
    globalPath: string | null;
    presets: string[];
    ruleCount: number;
  };
}
```

Core block message:

```text
Hardno blocked this bash command.
Rule: <id>
Reason: <reason>
Suggestion: <suggestion>
The command was not executed. Choose a compliant next step.
Override for the human operator, if appropriate: <ENV>=<VALUE>
```

For compound commands, append:

```text
The blocked command was part <n>: <part>.
Re-run any safe earlier parts separately if still needed.
```

## 3. Policy file schema

Files:

```text
.hardno/guards.json
$XDG_CONFIG_HOME/hardno/guards.json
~/.config/hardno/guards.json
```

Schema:

```ts
interface GuardsPolicyFile {
  schemaVersion: 1;
  enabled?: boolean;
  extends?: string[];
  disableGlobal?: boolean;
  presets?: PresetConfig[];
  rules?: GuardRule[];
  protectedBranches?: string[];
  defaults?: {
    onError?: "allow" | "block";
    cacheTtlMs?: number;
    audit?: { enabled?: boolean; logCommands?: "full" | "redacted" | "hash" };
  };
}
type PresetConfig =
  | string
  | {
      id: string;
      enabled?: boolean;
      action?: "warn" | "block";
      priority?: number;
      overrideEnv?: string | null;
      onError?: "allow" | "block";
    };
interface GuardRule {
  id: string;
  enabled?: boolean;
  description?: string;
  action: "allow" | "warn" | "block";
  priority?: number;
  severity?: "info" | "warning" | "error";
  match: GuardMatcher;
  when?: GuardCondition;
  reason: string;
  suggestion?: string;
  override?: { env?: string; value?: string; requireReasonEnv?: string; expiresAt?: string };
  onError?: "allow" | "block";
}
type GuardMatcher =
  | { type: "regex"; pattern: string; flags?: string }
  | { type: "git"; subcommand: string; argsAny?: string[]; argsAll?: string[] }
  | { type: "command"; executable: string; argsAny?: string[]; argsAll?: string[] };
interface GuardCondition {
  // Leaf predicates (evaluated against current state from §4):
  reviewPending?: boolean;
  reviewInProgress?: boolean;
  reviewLastHadIssues?: boolean;
  branch?: string[];
  protectedBranch?: boolean;
  stagedChanges?: boolean;
  unstagedChanges?: boolean;
  env?: Record<string, string>;
  // Combinators (for OR/AND of sub-conditions):
  anyOf?: GuardCondition[];
  allOf?: GuardCondition[];
  not?: GuardCondition;
}
```

Minimal project policy example: `{"schemaVersion":1,"enabled":true,"presets":["review-gate-push","no-amend","no-force-push","block-rm-rf-root"],"protectedBranches":["main","master"]}`.

## 4. State sources

Review state is written by `hardno review` and read by `hardno guard`:

```text
$XDG_STATE_HOME/hardno/state.json
~/.local/state/hardno/state.json
```

```ts
interface HardnoStateFile {
  schemaVersion: 1;
  projects: Record<string, ProjectReviewState>;
}
interface ProjectReviewState {
  cwd: string;
  gitRoot: string | null;
  updatedAt: string;
  reviewEnabled: boolean;
  reviewing: boolean;
  lastOutcome: "lgtm" | "issues_found" | "skipped" | "error" | "unknown";
  lastHadIssues: boolean;
  pendingFiles: string[];
  lastRunId: string | null;
  lastReviewId: string | null;
}
```

`hardno review` sets `reviewing: true` at start, clears it on finish/error,
sets `lastHadIssues`, and clears `pendingFiles` after LGTM.

Git state uses bounded shell-outs:

```bash
git rev-parse --show-toplevel
git branch --show-current
git status --porcelain=v1
git rev-list --left-right --count @{upstream}...HEAD
```

Default guard-mode git budget: `1500ms` total. Missing upstream gives
`ahead: null`, `behind: null`. Harness hints can arrive through
`HARDNO_HARNESS_INPUT_FILE`, but hardno remains authoritative.

## 5. Compound command parsing

Reuse and upgrade the deterministic bash parsing currently implied by
`changes.ts`: split chains, treat any unsafe part as unsafe, and keep the
LLM-backed judge separate.

```ts
interface ParsedCommand {
  parser: "hardno-shell-v1";
  original: string;
  parts: CommandPart[];
  unsupportedSyntax: string[];
  confidence: "high" | "medium" | "low";
}
interface CommandPart {
  index: number;
  text: string;
  normalized: string;
  connectorBefore: "start" | "&&" | "||" | ";" | "|" | "&";
  argv: string[];
  executable: string | null;
  kind: "simple" | "pipeline" | "subshell" | "assignment" | "unknown";
}
```

Requirements:

- Respect quotes, escapes, and simple env assignments.
- Split top-level `&&`, `||`, `;`, `|`, and `&`.
- Normalize `git -C <dir>` and `git -c key=value` before subcommand.
- Distinguish `git stash push` from remote `git push`.
- Mark complex substitutions, heredocs, and unsupported subshells low
  confidence.

Evaluation:

- Evaluate every part against every rule.
- Any matching block rule blocks the whole command.
- Else any matching warn rule warns.
- Parser failure plus applicable `onError: "block"` blocks.

Example `git add . && git commit --amend && git push` yields parts for
`git add .`, `git commit --amend`, and `git push`; the amend part blocks the
whole command.

## 6. Rule-match resolution

Deterministic order (applied for each compound-command part independently; see §5 for how the parts list is built):

1. **Collect candidates.** Gather every enabled rule whose `match` fires on this part, across all rule sources (builtin presets, global policy, project policy, CLI policy).
2. **Evaluate `when`.** Drop candidates whose `when` condition is false. `when` evaluation happens BEFORE override application — a rule that wouldn't have matched at all has nothing to override.
3. **Apply rule-scoped overrides.** For each surviving candidate whose `override.env` is set in the current environment (and matches `override.value` if specified), mark it as `overrideApplied` and DROP it from the active match set for decision purposes (it still appears in `matchedRules` with `decision: "override_applied"` for audit).
4. **If all blocking candidates were dropped via override**, continue with the remaining (non-overridden) candidates — these may be `warn` or `allow` rules that should still surface. Overriding blocks does NOT suppress unrelated warns.
5. **Pick strictest action:** `block > warn > allow`.
6. **Within action, highest `priority` wins.**
7. **Ties:** `cli > project > global > builtin`.
8. **Final tie:** lexicographically smallest `id`.
9. **Repeat for each compound part.** If ANY part resolves to `block` and was not fully override-suppressed, the overall decision is `block`. Otherwise, if any part resolves to `warn`, decision is `warn`. Otherwise `allow`.

Default priorities:

```text
100 block presets and project block rules
80  project warn rules
60  global block rules
40  global warn rules
20  builtin warning rules
0   explicit allow rules
```

In v1.1, `allow` rules do not bypass block rules.

## 7. Override mechanism

Overrides are rule-scoped:

```json
{
  "override": {
    "env": "HARDNO_ALLOW_AMEND",
    "value": "1",
    "requireReasonEnv": "HARDNO_OVERRIDE_REASON",
    "expiresAt": "2026-05-01T00:00:00.000Z"
  }
}
```

Semantics:

- No `override.env` means no override.
- If `value` is set, env var must equal it.
- If `requireReasonEnv` is set, it must be non-empty.
- Expired overrides are ignored.
- Audit includes rule id, env name, and reason when present.

Built-in override env vars:

```text
HARDNO_ALLOW_PUSH=1
HARDNO_ALLOW_AMEND=1
HARDNO_ALLOW_FORCE_PUSH=1
HARDNO_ALLOW_RM_RF_ROOT=1
HARDNO_ALLOW_PROTECTED_BRANCH=1
```

Warn decisions do not require overrides.

## 8. Failure mode

CLI failures:

- Config error: exit `2`.
- Policy error: exit `3`.
- State error: exit `4` only when needed by matching fail-closed rule.
- Parser error: exit `5` only when needed by matching fail-closed rule.
- Unexpected error: exit `6`.
- Audit write failure does not alter allow/warn/block unless future policy adds
  `audit.required`.

Default `onError`:

```text
review-gate-push: block
no-amend: block
no-force-push: block
block-rm-rf-root: block
advisory warn rules: allow
```

If a harness cannot spawn hardno, times out, or cannot parse JSON, it runs a
tiny emergency regex set. Emergency match blocks; otherwise allow and warn if
possible.

**Emergency regexes run against INDIVIDUAL command parts, not the raw compound string.** The harness splits the command string on `&&`, `||`, `;`, and `|` (reusing the existing `changes.ts` split logic from §5, duplicated into the emergency fallback so the harness doesn't depend on hardno being available), then tests each part independently. This avoids false positives like `git commit -m "don't --amend" && echo ok` matching the `--amend` regex across segment boundaries.

```ts
// Harness-side emergency fallback. Minimal dep footprint; duplicates a subset
// of changes.ts splitting logic so it works even when hardno is unreachable.
function emergencyBlock(rawCommand: string): boolean {
  const parts = rawCommand
    .split(/&&|\|\||;|\|/)
    .map((p) => p.trim())
    .filter(Boolean);
  const EMERGENCY_BLOCK = [
    /\bgit\s+(?:-\S+\s+|-[Cc]\s+\S+\s+|-c\s+\S+\s+)*commit\b.*\B--amend\b/,
    /\bgit\s+(?:-\S+\s+|-[Cc]\s+\S+\s+|-c\s+\S+\s+)*push\b.*(?:--force|-f|--force-with-lease)\b/,
    /\brm\s+.*(?:-rf|-fr|-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(?:\/|~|\$HOME)(?:\s|$)/,
  ];
  return parts.some((part) => EMERGENCY_BLOCK.some((re) => re.test(part)));
}
```

Key change from earlier draft: the regexes use `.` (which doesn't match newlines) instead of `[\s\S]*` (which does). Combined with per-part evaluation, this eliminates the cross-segment false-positive class. Heredoc-containing parts still pass through as single strings — if a heredoc body legitimately contains `--amend` as prose, the emergency fallback may false-positive there. That's considered acceptable for a last-resort fallback; policy evaluation via the main hardno CLI uses the argv-based matcher (§5) which doesn't have this limitation.

These are adapter last resorts, not policy logic.

## 9. Caching

Optional first implementation, but keep the contract open.

```text
policy stat cache:   1000ms
git state cache:     1000ms
review state cache:   500ms
guard result cache:   500ms
```

Invalidate on policy mtime, hardno state mtime, `.git/index` mtime, or
`--no-cache`. Harnesses may cache identical `(cwd, command, stateVersion)` for
500ms but do not own policy.

## 10. Harness integration - pi-hard-no

Verified useful pi hooks from `extensions.md`:

- `tool_call`: can block and mutate tool input.
- `user_bash`: can intercept `!` and `!!`.
- `input`: can handle/transform raw user input.
- `before_agent_start`: can inject message or modify system prompt.
- `context`: can modify messages before each LLM call.
- `agent_end`: fires once per prompt.
- `tool_execution_start` / `tool_execution_end`: tracking/status.
- `tool_result`: can modify result, optional for warnings.
- `session_start`, `session_shutdown`, `session_before_compact`,
  `session_compact`: status/history.

`session_start`: run `hardno guard status --json` and set status:

```text
hardno guards on · push blocked · no-amend · 2 pending files
hardno guards on · clean
hardno guards warn · protected branch
hardno guards off
```

`input`: narrow pre-steering only. If the prompt contains obvious inline bash
like `git commit --amend`, call guard with `--source user_input`; on block,
transform the prompt by appending `formatAgentInstruction(result)`. Do not block
questions about dangerous commands.

`before_agent_start`: inject concise guard state so the agent avoids blocked
commands before trying them.

```ts
pi.on("before_agent_start", async (event, ctx) => {
  const status = await runHardnoGuardStatus(ctx.cwd);
  const guardPrompt = [
    "Hardno guard policy for this project:",
    `- guards enabled: ${status.enabled}`,
    `- active presets: ${status.presets.join(", ") || "none"}`,
    `- review pending: ${status.review.pending}`,
    `- last review had issues: ${status.review.lastHadIssues}`,
    `- protected branch: ${status.git.protectedBranch}`,
    "Before running bash commands, avoid commands that hardno would block.",
  ].join("\n");
  return { systemPrompt: event.systemPrompt + "\n\n" + guardPrompt };
});
```

`context`: append the last 3 guard blocks/warnings as a short synthetic context
message. Verify exact pi message type before implementation.

`tool_call`: enforcement for agent bash. This replaces the current in-process
`pushBlocked` regex.

```ts
pi.on("tool_call", async (event, ctx) => {
  if (!isToolCallEventType("bash", event)) return;
  const result = await guard(event.input.command, ctx, {
    source: "agent_tool",
    toolCallId: event.toolCallId,
  });
  recordGuardResult(result);
  renderGuardStatus(ctx);
  if (result.decision === "block") return { block: true, reason: formatPiBlockMessage(result) };
  if (result.decision === "warn" && ctx.hasUI) ctx.ui.notify(formatShortWarning(result), "warning");
});
```

`user_bash`: guard human `!` and `!!` commands. On block, return a direct bash
result with exit code `11`; on warn, notify when UI exists and otherwise allow.

```ts
pi.on("user_bash", async (event, ctx) => {
  const result = await guard(event.command, ctx, { source: "user_bash" });
  recordGuardResult(result);
  renderGuardStatus(ctx);
  if (result.decision === "block") {
    return {
      result: {
        output: formatUserBashBlock(result),
        exitCode: 11,
        cancelled: false,
        truncated: false,
      },
    };
  }
  if (result.decision === "warn" && ctx.hasUI) {
    ctx.ui.notify(formatShortWarning(result), "warning");
  }
  // allow + no-UI warn: fall through silently, command proceeds.
});
```

Other pi hooks:

- `tool_execution_start`: show "checking guard..." and keep review tracking.
- `tool_execution_end`: refresh status after `hardno review`, `git commit`,
  `git reset`, `git checkout`, and similar state-changing commands.
- `tool_result`: optional v1.2 place to append warning text; prefer UI in v1.1.
- `agent_end`: refresh guard status after review state changes.
- `session_before_compact` / `session_compact`: preserve or trim guard history.
- `session_shutdown`: flush telemetry and clear status.

Subprocess helper:

```ts
// Accepts any object with `cwd` and optional `signal` — pi's `ExtensionContext`
// satisfies this via structural typing, so handlers can pass `ctx` directly
// without destructuring.
type GuardCtx = { cwd: string; signal?: AbortSignal };

async function guard(
  command: string,
  ctx: GuardCtx,
  opts: { source: string; toolCallId?: string },
): Promise<GuardResult> {
  const args = [
    "guard",
    "--json",
    "--cwd",
    ctx.cwd,
    "--harness",
    "pi-hard-no",
    "--source",
    opts.source,
  ];
  if (opts.toolCallId) args.push("--tool-call-id", opts.toolCallId);
  args.push(command);
  return runHardnoJson(args, { signal: ctx.signal });
}
```

## 11. Harness integration - Claude Code

Claude Code should call the same CLI from its Bash pre-execution hook.

⚠️ verify: exact Claude Code hook configuration and response protocol. Intended
contract:

- Hook Bash before execution.
- Call `hardno guard --json --harness claude-code --source agent_tool`.
- Block on `decision: "block"`.
- Show non-blocking warnings if Claude supports them.
- Return `formatAgentInstruction(result)` to the model on block.

Illustrative config only:
`{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"hardno-claude-guard-hook"}]}]}}`.

Illustrative wrapper:

```ts
const input = JSON.parse(await readStdin());
const command = input.tool_input?.command ?? input.command;
const result = await execJson("hardno", [
  "guard",
  "--json",
  "--harness",
  "claude-code",
  "--source",
  "agent_tool",
  "--cwd",
  input.cwd ?? process.cwd(),
  command,
]);
// ⚠️ verify exact response fields.
process.stdout.write(
  JSON.stringify(
    result.decision === "block"
      ? { decision: "block", reason: formatAgentInstruction(result) }
      : { decision: "allow" },
  ),
);
```

Use Claude's hook denial channel, not a fake shell failure, when available. Do
not ask the model to set override env vars; overrides are for humans.

## 12. Harness integration - codex CLI

⚠️ verify: whether codex CLI exposes a real pre-shell tool hook or plugin API.

Desired native adapter:

```ts
// ⚠️ verify: illustrative only.
export default {
  async beforeToolUse(event) {
    if (event.tool !== "shell" && event.tool !== "bash") return;
    const result = await hardnoGuard(event.input.command, {
      harness: "codex",
      source: "agent_tool",
      cwd: event.cwd,
    });
    if (result.decision === "block")
      return { block: true, message: formatAgentInstruction(result) };
    if (result.decision === "warn") return { warning: formatShortWarning(result) };
  },
};
```

Fallbacks if no true hook exists:

- Project rule telling the agent to run `hardno guard --json "<cmd>"` before
  dangerous commands. This is weaker and not full guard support.
- Shell wrapper for human shell commands only.

The codex adapter should be policy-free and feed the same block message to the
model as pi and Claude.

## 13. Cross-harness contract

Identical:

- Policy schema, merge rules, built-in presets, parser behavior, rule-match
  resolution, review state schema, guard JSON output, exit codes, overrides,
  audit schema, and core block/warn message fields.

May vary:

- UI richness, status bar display, warning presentation, context injection,
  guarding human shell commands, plugin failure rendering, and session/tool id
  sourcing.

## 14. Audit log

Location:

```text
$XDG_STATE_HOME/hardno/guard.log
~/.local/state/hardno/guard.log
```

NDJSON schema:

```ts
interface GuardAuditRecord {
  schemaVersion: 1;
  id: string;
  timestamp: string;
  runId: string;
  cwd: string;
  gitRoot: string | null;
  harness: string;
  source: GuardSource;
  sessionId: string | null;
  toolCallId: string | null;
  decision: GuardDecision | "override_applied" | "error";
  exitCode: number;
  command: { text: string; hash: string; redacted: boolean };
  effectiveRule: { id: string; source: string; action: GuardDecision; priority: number } | null;
  matchedRuleIds: string[];
  override: { applied: boolean; env: string | null; reason: string | null };
  state: {
    reviewPending: boolean;
    reviewInProgress: boolean;
    lastHadIssues: boolean;
    branch: string | null;
    protectedBranch: boolean;
  };
  error?: GuardError;
}
```

Rotate at `5_000_000` bytes, keep `guard.log.1` through `guard.log.5`. Redaction
modes: `full` default, `redacted`, and `hash`.

## 15. Built-in preset catalog

Default project presets: `["review-gate-push","no-amend","no-force-push","block-rm-rf-root"]`.

Each preset expands to a fully-formed `GuardRule` (§3). The `match` object uses the `GuardMatcher` discriminated union, `when` is a structured `GuardCondition`, and `override` is the `{ env, value?, requireReasonEnv? }` object — NOT the shorthand strings used in earlier drafts.

Exact v1 presets:

```ts
{
  id: "review-gate-push",
  action: "block",
  priority: 100,
  match: {
    type: "regex",
    pattern: "\\bgit\\s+(?:(?:-C\\s+\\S+|-c\\s+\\S+|--no-pager)\\s+)*push\\b",
  },
  when: {
    anyOf: [
      { reviewPending: true },
      { reviewInProgress: true },
      { reviewLastHadIssues: true },
    ],
  },
  reason: "Push blocked because files have not passed hardno review.",
  suggestion: "Run or wait for hardno review, fix any issues, then push.",
  override: { env: "HARDNO_ALLOW_PUSH", value: "1" },
  onError: "block",
}
{
  id: "no-amend",
  action: "block",
  priority: 100,
  match: {
    type: "git",
    subcommand: "commit",
    argsAny: ["--amend"],
  },
  reason: "Project policy forbids git commit --amend.",
  suggestion: "Create a new commit instead of rewriting the previous one.",
  override: { env: "HARDNO_ALLOW_AMEND", value: "1" },
  onError: "block",
}
{
  id: "no-force-push",
  action: "block",
  priority: 100,
  match: {
    type: "git",
    subcommand: "push",
    argsAny: ["--force", "-f", "--force-with-lease"],
  },
  reason: "Project policy forbids force-push.",
  suggestion: "Push normally or ask the human operator for an explicit override.",
  override: { env: "HARDNO_ALLOW_FORCE_PUSH", value: "1" },
  onError: "block",
}
{
  id: "block-rm-rf-root",
  action: "block",
  priority: 100,
  match: {
    type: "command",
    executable: "rm",
    argsAll: ["-r", "-f"],
  },
  reason: "Refusing to recursively delete a root or home directory.",
  suggestion: "Target the specific generated directory or file instead.",
  override: { env: "HARDNO_ALLOW_RM_RF_ROOT", value: "1" },
  onError: "block",
}
```

Implementation notes:

- `no-amend` and `no-force-push` use the `GuardMatcher.type = "git"` variant (requires argv parser — see §5) so that `git stash push` is NOT caught by `no-force-push`'s `push` subcommand match, and so that flag detection is authoritative (no regex confusion between `-f` and `-fr`). The argv parser also correctly separates `rm -r -f /` (which `block-rm-rf-root`'s `command` matcher with `argsAll: ["-r", "-f"]` catches) from regex-only approaches that would miss separated flags.
- `review-gate-push` uses `type: "regex"` because the `git push` match is on the subcommand before considering args; the substantive gate is in `when`, evaluated by the condition engine against live state.
- `block-rm-rf-root` checks `argsAll: ["-r", "-f"]` after argv parsing; the matcher implementation MUST expand bundled flags (`-rf`, `-fr`, `-Rf`, etc.) into `["-r", "-f"]` before comparing. The parser also matches destinations starting with `/`, `~`, or `$HOME`. See §5 for the argv parser contract.
- `no-amend` is motivated by this repo's `AGENTS.md` rule “Never amend commits. Always append new commits.”
- Optional warning presets (ship disabled by default): `warn-protected-branch-commit`, `warn-large-add`. Schema identical but `action: "warn"`, `onError: "allow"`.

## 16. Project-vs-global policy

Resolution order:

1. CLI `--policy` files.
2. Nearest ancestor `.hardno/guards.json`.
3. `$XDG_CONFIG_HOME/hardno/guards.json`.
4. `~/.config/hardno/guards.json`.
5. Built-in presets when referenced.

Merge rules:

- Global loads first, then project, then CLI.
- `disableGlobal: true` ignores global policy.
- `enabled: false` disables that scope.
- Same preset id: later source overrides configurable fields.
- Same custom rule id: later source replaces the rule.
- `protectedBranches` merge and dedupe; explicit empty project array clears
  inherited branches.

`hardno init guards` creates `.hardno/guards.json` with the default preset set
and `["main", "master"]` protected branches.

## 17. Interaction with the judge

Judge:

- LLM-backed.
- Runs after command execution as review-suppression logic.
- Fails open to `unsure`.
- Can only skip a review when confidently read-only.

Guards:

- Deterministic and rule-based.
- Run before command execution.
- Can fail closed per rule.
- Must not call an LLM in v1.

Shared internals: `src/bash-parser.ts`, git command normalization, compound
part model, and read-only/modifying taxonomy constants where useful. Keep
entrypoints separate:

```bash
hardno guard "<cmd>"
hardno review
hardno judge "<cmd>"   # optional future public surface
```

Move deterministic parsing out of `changes.ts`; have `changes.ts` and
`guard.ts` consume it; keep `judge.ts` fail-open.

## 18. Phased roadmap

v1.1 basic guards:

- Add `hardno guard --json`, `.hardno/guards.json`, four block presets,
  deterministic shell parser for git/rm policy, hardno review state file, guard
  audit log, pi `tool_call`/`user_bash` guards, and
  `hardno guard status --json`.

v1.2 richer pi integration:

- Inject guard state in `before_agent_start`, add recent guard decisions through
  `context`, add narrow `input` pre-steering, preserve guard history during
  compaction, add `hardno guard audit`, cache invalidation, and scaffold command.

v1.3 Claude/codex adapters:

- Verify both hook APIs, ship thin adapters, add cross-harness conformance
  fixtures, and publish identical block/warn message docs.

v1.4 policy expansion:

- Add richer conditions, path-aware protected-file rules, `hardno guard test`,
  and consider a daemon only if subprocess latency is proven problematic.

## 19. Open questions

- Should guards be enabled by default after `hardno init`, or opt-in only?
- Should `review-gate-push` block when the last review errored?
- Should user `!` commands be hard-blocked by default or prompt in pi UI?
- Should project overrides require `HARDNO_OVERRIDE_REASON` by default?
- Should audit logs default to full commands or redacted commands?
- Should project state keys use cwd, git root, or both?
- Can project policy weaken global policy, or only with `disableGlobal: true`?
- Can Claude Code show non-blocking pre-tool warnings?
- Does codex CLI expose a real pre-shell hook?
- Should `hardno guard status --json` include full active rules or summaries, and should `git push --dry-run` bypass `review-gate-push`?
- Should Gerrit-style pushes to `refs/for/*` be exempt?
- Should `--force-with-lease` be warn rather than block in some projects?
- Does guard logic stay inside `pi-hard-no`, or move to a future `hardno-pi` plugin?
