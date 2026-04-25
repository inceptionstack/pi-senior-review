/**
 * judge-skip-chain.ts — loop safeguard for consecutive judge-skip outcomes.
 *
 * CONTEXT: when the orchestrator's judge gate classifies a turn as read-only
 * it emits a `{ type: "skipped", reason: "judge_read_only" }` outcome. The
 * extension surfaces that in chat with `triggerTurn: true` so the agent keeps
 * working (e.g. "ran `git status`, now ready to push"). Without a cap, an
 * unlucky agent + judge combo could loop forever:
 *
 *   agent reads → judge skips → triggerTurn → agent reads → judge skips → …
 *
 * SHAPE: a small state machine owned by `index.ts`. Each `judge_read_only`
 * outcome increments the counter; any other outcome resets it. Once the
 * counter exceeds `maxChain`, we still post the skip message to chat (the
 * user paid for the judge call — show them it ran) but set `triggerTurn=false`
 * so the agent halts and waits for input.
 *
 * The message text is split into a pure `formatJudgeSkipMessage` helper so
 * we can unit-test the copy without instantiating the tracker.
 *
 * TESTING: pure TS, no SDK imports, no I/O. Drop-in replaceable in `index.ts`.
 */

/**
 * Default cap for `triggerTurn: true` judge-skip replies. Chosen small on
 * purpose — three chained "read-only" turns is already a strong signal the
 * agent is stuck exploring and the user should step in. Overridable via the
 * `JudgeSkipChain` constructor for tests and future tuning.
 */
export const DEFAULT_MAX_JUDGE_SKIP_CHAIN = 3;

/** Payload returned from `JudgeSkipChain.handleJudgeSkip`. */
export interface JudgeSkipMessage {
  /** Markdown message body to post to chat. */
  content: string;
  /** Whether to request another agent turn. `false` once the cap is exceeded. */
  triggerTurn: boolean;
  /** Consecutive-skip count after this invocation. Useful for logging/tests. */
  count: number;
  /** True when this call crossed the cap (message includes the "chain reached" warning). */
  capReached: boolean;
}

/**
 * Format the chat-message body for a judge-skip outcome.
 *
 * Pure: same inputs → same output. No state, no side effects.
 *
 * @param count        consecutive-skip counter value *after* this skip was recorded
 * @param maxChain     cap above which `triggerTurn` is suppressed
 * @param judgeModel   full "provider/model-id" string — only the tail is shown
 * @param shouldTrigger whether the caller will still request another turn
 */
export function formatJudgeSkipMessage(
  count: number,
  maxChain: number,
  judgeModel: string,
  shouldTrigger: boolean,
): string {
  const baseMsg = `⚖️ **Review skipped by judge** — all bash commands this turn classified as read-only (no file mutation). Skipping the main review.`;
  const modelShort = judgeModel.split("/").pop() || judgeModel;
  const footer = `_Model: \`${modelShort}\` — toggle with \`/review-judge-toggle\`_`;

  if (shouldTrigger) {
    return `${baseMsg}\n\n${footer}`;
  }
  return `${baseMsg}\n\n⚠️ Chain of ${count} consecutive judge-skips reached — not triggering another turn to avoid a loop. Reply to me or \`/review-judge-toggle\` off if you want to proceed.\n\n${footer}`;
}

/**
 * Tracks consecutive `judge_read_only` skips across an extension session.
 *
 * Call `handleJudgeSkip(model)` for each such outcome; call `reset()` for
 * every other outcome type (completed / error / cancelled / max_loops / non-
 * judge skip reasons) and at session boundaries.
 */
export class JudgeSkipChain {
  private count = 0;
  readonly maxChain: number;

  constructor(maxChain: number = DEFAULT_MAX_JUDGE_SKIP_CHAIN) {
    // Guard: a zero or negative cap would suppress triggerTurn immediately,
    // which contradicts the feature's "allow some agent progress" intent.
    // Treat it as a configuration error and fall back to the default rather
    // than silently producing a confusing UX.
    this.maxChain = maxChain > 0 ? maxChain : DEFAULT_MAX_JUDGE_SKIP_CHAIN;
  }

  /**
   * Record a judge-skip outcome and compute the chat payload to emit.
   * Increments the internal counter; does NOT mutate anything else.
   */
  handleJudgeSkip(judgeModel: string): JudgeSkipMessage {
    this.count += 1;
    const shouldTrigger = this.count <= this.maxChain;
    return {
      content: formatJudgeSkipMessage(this.count, this.maxChain, judgeModel, shouldTrigger),
      triggerTurn: shouldTrigger,
      count: this.count,
      capReached: !shouldTrigger,
    };
  }

  /** Reset the consecutive-skip counter. Called on any non-judge-skip outcome. */
  reset(): void {
    this.count = 0;
  }

  /** Current consecutive-skip count. Exposed for logging/diagnostics. */
  getCount(): number {
    return this.count;
  }
}
