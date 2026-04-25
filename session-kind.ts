/**
 * session-kind.ts — detect whether pi-lgtm is loaded into the *main* agent
 * session or into a spawned *sub-session* (e.g. the reviewer session created
 * by `runReviewSession` in reviewer.ts).
 *
 * WHY THIS EXISTS
 * ───────────────
 * pi's extension loader calls our factory fresh for every session it creates.
 * `reviewer.ts` calls `createAgentSession({...})` to spawn a separate reviewer
 * pi instance; that triggers `DefaultResourceLoader.reload()` which calls
 * `loadExtensions()` which calls our factory again with a new `pi`. So
 * pi-lgtm is loaded twice per review: once in the main session, once inside
 * each reviewer session.
 *
 * Without a guard, the reviewer-instance's `agent_end` handler fires when
 * the reviewer's one-shot prompt finishes, tries to recursively review that
 * session, then crashes with "ctx is stale after session replacement or
 * reload" when `reviewer.ts:391 finally { session.dispose() }` invalidates
 * the reviewer's runtime. Beyond the error, that recursion would double-review
 * every turn — a real functional bug, not just noise.
 *
 * DETECTION
 * ─────────
 * `reviewer.ts` creates the reviewer session with a restricted tool set
 * (`["read", "bash", "grep", "find", "ls"]`, no `write` / `edit`). pi's SDK
 * passes this through as `allowedToolNames` which filters
 * `AgentSession._toolDefinitions`, so `pi.getAllTools()` on the reviewer
 * session returns those 5 tools and nothing else. The main interactive
 * session always has `write` and `edit` available.
 *
 * "No write AND no edit" → definitely not a session we want to auto-review
 * for. This is a stable invariant: a session without write/edit cannot be
 * producing file changes that warrant review. Safe to no-op there.
 *
 * TIMING
 * ──────
 * `runtime.getAllTools` is bound during the `AgentSession` constructor,
 * which runs AFTER the extension factory. So we cannot detect at activation
 * time — we detect lazily on the first call and cache the result per-`pi`.
 *
 * FAIL-SAFE
 * ─────────
 * If the probe itself throws (runtime not yet bound, or ctx already stale
 * at the instant we check), we default to `false` (main session) so the
 * normal path still runs. Worst case is one extra stale-ctx log line — no
 * worse than pre-fix behavior, and much rarer.
 *
 * TESTING
 * ───────
 * Pure TS. `pi` is passed as a parameter so tests can inject mocks without
 * spinning up a real session. Cache is per-`pi` via `WeakMap` so tests
 * using distinct mock objects stay isolated without an explicit reset.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { log } from "./logger";

/**
 * Per-`pi` cache. The first successful probe is remembered for the life of
 * that extension instance. WeakMap so GC'd pi instances (e.g. disposed
 * reviewer sessions) don't leak.
 */
const cache = new WeakMap<object, boolean>();

/**
 * Tool names whose presence marks a session as "main" (capable of producing
 * file changes we want to auto-review). If ALL of these are missing, the
 * session is treated as a spawned sub-session and pi-lgtm no-ops.
 */
const MAIN_SESSION_WRITE_TOOLS = ["write", "edit"] as const;

/**
 * Returns `true` if the current pi-lgtm instance is running inside a
 * spawned sub-session (e.g. a reviewer session) rather than the main agent
 * session.
 *
 * Callers should short-circuit work (e.g. skip triggering reviews, skip
 * updating status bar) when this returns `true`.
 *
 * Idempotent and cheap after the first call.
 */
export function isSpawnedSubSession(pi: ExtensionAPI): boolean {
  const cached = cache.get(pi);
  if (cached !== undefined) return cached;

  const result = probeIsSpawned(pi);
  cache.set(pi, result);
  return result;
}

/**
 * One-shot probe — separated so the cache-management wrapper above stays
 * trivially readable. Never throws; failures collapse to `false`.
 */
function probeIsSpawned(pi: ExtensionAPI): boolean {
  try {
    // Explicit fail-safe: if `pi.getAllTools` isn't a function, the runtime
    // isn't bound yet (shouldn't happen in practice once events fire) or the
    // mock/environment is malformed. Defaulting to "main session" keeps the
    // main path alive; treating this as "empty tool list = spawned" would
    // wrongly no-op the real main session on an early call.
    if (typeof pi.getAllTools !== "function") {
      log(
        `session-kind: pi.getAllTools unavailable — defaulting to main session (no-op guard disabled for this instance)`,
      );
      return false;
    }
    const raw = pi.getAllTools();
    if (!Array.isArray(raw)) {
      log(
        `session-kind: pi.getAllTools() returned non-array (${typeof raw}) — defaulting to main session (no-op guard disabled for this instance)`,
      );
      return false;
    }
    const tools = raw;
    const names = new Set(
      tools
        .map((t) => (t as { name?: unknown })?.name)
        .filter((n): n is string => typeof n === "string"),
    );
    const hasAnyWriteTool = MAIN_SESSION_WRITE_TOOLS.some((t) => names.has(t));
    const isSpawned = !hasAnyWriteTool;
    if (isSpawned) {
      log(
        `session-kind: spawned sub-session detected (tools=[${[...names].join(",")}]) — pi-lgtm hooks will no-op for this instance`,
      );
    }
    return isSpawned;
  } catch (err: any) {
    // Probe failing means runtime/ctx isn't healthy right now. Defaulting
    // to "main session" keeps the normal path alive; the worst that can
    // happen is one stale-ctx log line later, which is the pre-fix baseline.
    log(
      `session-kind: probe failed (${err?.message ?? err}) — defaulting to main session (no-op guard disabled for this instance)`,
    );
    return false;
  }
}
