/**
 * judge.ts — LLM-backed bash-command classifier (the "judge").
 *
 * ROLE: narrow duplicate-review suppressor. The orchestrator calls this ONLY
 * for bash commands that the deterministic classifier in `changes.ts` flagged
 * as potentially file-modifying but aren't definitively so (e.g. commands
 * containing unknown shell builtins like `echo` that the static allowlist
 * doesn't cover). The judge returns one of:
 *
 *   - inspection_vcs_noop: reads/reports state only, no mutation
 *   - modifying:           changes files / git / deps / env
 *   - unsure:              ambiguous, truncated, or unknown
 *
 * FAIL-OPEN: any failure (timeout, parse error, transport, missing model,
 * missing API key) maps to `unsure`. Callers treat `unsure` and `modifying`
 * identically (both → run the main review), so the judge can only ever
 * suppress a review when it's confidently sure the turn was read-only.
 *
 * DESIGN: runner is injected so tests can mock without spinning up real
 * pi sessions, mirroring the pattern used by `reviewer.ts` + `orchestrator.ts`.
 */

import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";

import { log } from "./logger";

/** The three output classes the judge can return. */
export const JUDGE_CLASSES = ["inspection_vcs_noop", "modifying", "unsure"] as const;
export type BashClassification = (typeof JUDGE_CLASSES)[number];

export interface JudgeOptions {
  signal: AbortSignal;
  cwd: string;
  /** Model to invoke. Defaults handled by callers; keep explicit here for testability. */
  model: string;
  /** Max wall-clock for the classifier call. Defaults to 10s. */
  timeoutMs?: number;
}

/**
 * Low-level judge runner contract: given a single bash command, return the
 * raw model text plus whether the outer timeout fired. Separated so tests
 * can mock without going through createAgentSession.
 */
export type JudgeRunner = (command: string, opts: JudgeOptions) => Promise<{ text: string }>;

/** Same prompt text we validated in `eval/run-eval.mjs` (prompt v1). */
const PROMPT = `You classify ONE bash command into exactly one of three classes for an automated code review system.

CLASSES:
- inspection_vcs_noop: reads/reports state only, no file/git/dep/process/network/env mutation
- modifying: may change files, git index/commits/branches/remotes, deps, artifacts, processes, services, permissions, caches, or env
- unsure: ambiguous, truncated, unknown executable/script, or not confidently classifiable

TAXONOMY (authoritative):
- ls, pwd, cat, head, tail, wc, rg, grep, find (no -delete/-exec), sed -n, test, echo, printf, true, false → inspection_vcs_noop (only if not redirecting output)
- git status/diff/log/show/rev-parse/branch --show-current → inspection_vcs_noop
- git add/commit/push/pull/merge/rebase/reset/checkout/switch/stash/clean/tag → modifying
- touch/cp/mv/rm/mkdir/rmdir/chmod/chown, redirections >, >>, tee, truncate → modifying
- npm/pnpm/yarn/pip/cargo install, make, cargo build, npm run format, codegen scripts → modifying
- kill/pkill/systemctl, docker run, docker compose up → modifying
- sed -i, perl -pi → modifying (in-place edit)
- ./script.sh or npm run <unknown> → unsure unless clearly read-only
- truncated command (e.g. "git commi") → unsure
- Compound commands with &&, ;, ||, pipes, subshells: ANY modifying part → modifying; ANY unknown/truncated → unsure; otherwise the class of the safest-subset.

OUTPUT: return ONLY this JSON, no prose, no markdown fences:
{"classification":"inspection_vcs_noop"|"modifying"|"unsure"}

Command to classify:
`;

/**
 * Parse the judge's raw response into a classification.
 * Strips optional ```json``` fences, tolerates minor whitespace, falls back
 * to regex extraction if JSON parse fails, and ultimately returns `unsure`
 * on any ambiguity.
 */
export function parseJudgeResponse(raw: string): BashClassification {
  let s = raw.trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) s = fenced[1].trim();

  try {
    const obj = JSON.parse(s);
    const c = obj?.classification;
    if ((JUDGE_CLASSES as readonly string[]).includes(c)) return c as BashClassification;
  } catch {
    /* fall through to regex fallback */
  }

  const alt = JUDGE_CLASSES.join("|");
  const m = s.match(new RegExp(`\\b(${alt})\\b`));
  if (m) return m[1] as BashClassification;
  return "unsure";
}

/**
 * Run the judge on a single bash command. Always resolves (never rejects);
 * any failure collapses to `unsure` so the caller's skip logic stays safe.
 */
export async function classifyBashCommand(
  runner: JudgeRunner,
  command: string,
  opts: JudgeOptions,
): Promise<BashClassification> {
  if (!command || typeof command !== "string") return "unsure";
  try {
    const { text } = await runner(command, opts);
    return parseJudgeResponse(text);
  } catch (err: any) {
    log(`judge: classify failed (${err?.message ?? err}) → unsure`);
    return "unsure";
  }
}

/**
 * Production judge runner: spawns a fresh in-memory pi session, sends the
 * classifier prompt, captures the assistant response, and cleans up.
 *
 * Mirrors the session lifecycle from `reviewer.ts` but without any tools
 * (the judge is pure text-in-text-out — no file reading, no exploration).
 */
export const defaultJudgeRunner: JudgeRunner = async (command, opts) => {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const [provider, modelId] = opts.model.split("/", 2);
  if (!provider || !modelId) throw new Error(`bad judge model id: ${opts.model}`);
  const model = modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`judge model not found: ${opts.model}`);

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    tools: [],
  });

  let text = "";
  let unsub = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await session.setModel(model);
    session.setThinkingLevel("off");

    unsub = session.subscribe((ev: AgentSessionEvent) => {
      if (ev.type === "message_start" && (ev.message as any)?.role === "assistant") text = "";
      if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
        text += ev.assistantMessageEvent.delta;
      }
    });

    // Race: signal-abort | timeout | prompt-resolves.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const abortH = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        session.abort().finally(() => reject(new Error("aborted")));
      };
      if (opts.signal.aborted) return abortH();
      opts.signal.addEventListener("abort", abortH, { once: true });

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        opts.signal.removeEventListener("abort", abortH);
        session.abort().finally(() => reject(new Error("judge timeout")));
      }, timeoutMs);

      session.prompt(PROMPT + command).then(
        () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          opts.signal.removeEventListener("abort", abortH);
          resolve();
        },
        (err) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          opts.signal.removeEventListener("abort", abortH);
          reject(err);
        },
      );
    });

    return { text };
  } finally {
    try {
      unsub();
    } catch {
      /* ignore */
    }
    try {
      session.dispose();
    } catch {
      /* ignore */
    }
  }
};
