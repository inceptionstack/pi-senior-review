/**
 * Tests for judge-skip-chain.ts — the loop safeguard that caps consecutive
 * `judge_read_only` outcomes so the agent doesn't spin forever.
 *
 * Covers:
 *   - formatJudgeSkipMessage: pure copy rendering, model-name truncation,
 *     cap warning, footer format
 *   - JudgeSkipChain: counter semantics, cap behavior, reset, custom maxChain
 *
 * No SDK imports, no I/O — pure unit tests.
 */

import { describe, it, expect } from "vitest";

import {
  DEFAULT_MAX_JUDGE_SKIP_CHAIN,
  formatJudgeSkipMessage,
  JudgeSkipChain,
} from "../judge-skip-chain";

describe("DEFAULT_MAX_JUDGE_SKIP_CHAIN", () => {
  it("is 3 (small cap — chained read-only skips usually mean agent is stuck)", () => {
    expect(DEFAULT_MAX_JUDGE_SKIP_CHAIN).toBe(3);
  });
});

describe("formatJudgeSkipMessage", () => {
  const MODEL = "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0";
  const MODEL_SHORT = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

  describe("shouldTrigger = true (under the cap)", () => {
    it("includes base 'Review skipped by judge' copy", () => {
      const out = formatJudgeSkipMessage(1, 3, MODEL, true);
      expect(out).toContain("⚖️ **Review skipped by judge**");
      expect(out).toContain("no file mutation");
      expect(out).toContain("Skipping the main review");
    });

    it("appends model footer with short model name", () => {
      const out = formatJudgeSkipMessage(1, 3, MODEL, true);
      expect(out).toContain(`_Model: \`${MODEL_SHORT}\` — toggle with \`/review-judge-toggle\`_`);
    });

    it("does NOT include the chain-reached warning", () => {
      const out = formatJudgeSkipMessage(2, 3, MODEL, true);
      expect(out).not.toContain("Chain of");
      expect(out).not.toContain("not triggering another turn");
    });

    it("renders footer separated from body by blank line", () => {
      const out = formatJudgeSkipMessage(1, 3, MODEL, true);
      expect(out).toMatch(/Skipping the main review\.\n\n_Model:/);
    });
  });

  describe("shouldTrigger = false (cap exceeded)", () => {
    it("still includes the base message", () => {
      const out = formatJudgeSkipMessage(4, 3, MODEL, false);
      expect(out).toContain("⚖️ **Review skipped by judge**");
    });

    it("includes the chain-reached warning with the current count", () => {
      const out = formatJudgeSkipMessage(4, 3, MODEL, false);
      expect(out).toContain("⚠️ Chain of 4 consecutive judge-skips reached");
      expect(out).toContain("not triggering another turn to avoid a loop");
      expect(out).toContain("Reply to me or `/review-judge-toggle` off");
    });

    it("still renders the model footer at the end", () => {
      const out = formatJudgeSkipMessage(4, 3, MODEL, false);
      expect(
        out.endsWith(`_Model: \`${MODEL_SHORT}\` — toggle with \`/review-judge-toggle\`_`),
      ).toBe(true);
    });

    it("reports the exact count passed in (not derived from maxChain)", () => {
      const out = formatJudgeSkipMessage(99, 3, MODEL, false);
      expect(out).toContain("Chain of 99 consecutive judge-skips reached");
    });
  });

  describe("model name handling", () => {
    it("truncates 'provider/model' to just 'model'", () => {
      const out = formatJudgeSkipMessage(1, 3, "openai/gpt-5", true);
      expect(out).toContain("_Model: `gpt-5`");
    });

    it("falls back to full string when no slash is present", () => {
      // Pathological case — settings.ts validates `judgeModel` must contain
      // "/", but callers from other code paths might pass something raw.
      const out = formatJudgeSkipMessage(1, 3, "bareid", true);
      expect(out).toContain("_Model: `bareid`");
    });

    it("uses only the last path segment when multiple slashes exist", () => {
      const out = formatJudgeSkipMessage(1, 3, "a/b/c/model-x", true);
      expect(out).toContain("_Model: `model-x`");
    });
  });
});

describe("JudgeSkipChain", () => {
  const MODEL = "openai/gpt-5";

  describe("constructor", () => {
    it("defaults to DEFAULT_MAX_JUDGE_SKIP_CHAIN when no arg passed", () => {
      const chain = new JudgeSkipChain();
      expect(chain.maxChain).toBe(DEFAULT_MAX_JUDGE_SKIP_CHAIN);
    });

    it("accepts a custom maxChain", () => {
      const chain = new JudgeSkipChain(5);
      expect(chain.maxChain).toBe(5);
    });

    it("rejects zero and falls back to the default (misconfiguration guard)", () => {
      const chain = new JudgeSkipChain(0);
      expect(chain.maxChain).toBe(DEFAULT_MAX_JUDGE_SKIP_CHAIN);
    });

    it("rejects negative values and falls back to the default", () => {
      const chain = new JudgeSkipChain(-1);
      expect(chain.maxChain).toBe(DEFAULT_MAX_JUDGE_SKIP_CHAIN);
    });

    it("starts with count = 0", () => {
      const chain = new JudgeSkipChain();
      expect(chain.getCount()).toBe(0);
    });
  });

  describe("handleJudgeSkip — under the cap", () => {
    it("first call: count=1, triggerTurn=true, capReached=false", () => {
      const chain = new JudgeSkipChain(3);
      const out = chain.handleJudgeSkip(MODEL);
      expect(out.count).toBe(1);
      expect(out.triggerTurn).toBe(true);
      expect(out.capReached).toBe(false);
      expect(chain.getCount()).toBe(1);
    });

    it("second call: count=2, still triggering", () => {
      const chain = new JudgeSkipChain(3);
      chain.handleJudgeSkip(MODEL);
      const out = chain.handleJudgeSkip(MODEL);
      expect(out.count).toBe(2);
      expect(out.triggerTurn).toBe(true);
      expect(out.capReached).toBe(false);
    });

    it("third call at the cap boundary: count=3 (== max), still triggers", () => {
      const chain = new JudgeSkipChain(3);
      chain.handleJudgeSkip(MODEL);
      chain.handleJudgeSkip(MODEL);
      const out = chain.handleJudgeSkip(MODEL);
      expect(out.count).toBe(3);
      expect(out.triggerTurn).toBe(true);
      expect(out.capReached).toBe(false);
      expect(out.content).not.toContain("Chain of");
    });
  });

  describe("handleJudgeSkip — at / past the cap", () => {
    it("fourth call (count=4 > max=3): triggerTurn=false, capReached=true", () => {
      const chain = new JudgeSkipChain(3);
      chain.handleJudgeSkip(MODEL);
      chain.handleJudgeSkip(MODEL);
      chain.handleJudgeSkip(MODEL);
      const out = chain.handleJudgeSkip(MODEL);
      expect(out.count).toBe(4);
      expect(out.triggerTurn).toBe(false);
      expect(out.capReached).toBe(true);
      expect(out.content).toContain("Chain of 4 consecutive judge-skips reached");
    });

    it("keeps incrementing past the cap (does not saturate)", () => {
      const chain = new JudgeSkipChain(2);
      const counts: number[] = [];
      for (let i = 0; i < 5; i++) counts.push(chain.handleJudgeSkip(MODEL).count);
      expect(counts).toEqual([1, 2, 3, 4, 5]);
      expect(chain.getCount()).toBe(5);
    });

    it("every call past the cap keeps triggerTurn=false", () => {
      const chain = new JudgeSkipChain(1);
      chain.handleJudgeSkip(MODEL); // count=1 (== cap, still triggers)
      const a = chain.handleJudgeSkip(MODEL);
      const b = chain.handleJudgeSkip(MODEL);
      const c = chain.handleJudgeSkip(MODEL);
      expect([a.triggerTurn, b.triggerTurn, c.triggerTurn]).toEqual([false, false, false]);
      expect([a.capReached, b.capReached, c.capReached]).toEqual([true, true, true]);
    });
  });

  describe("reset", () => {
    it("zeroes the counter", () => {
      const chain = new JudgeSkipChain(3);
      chain.handleJudgeSkip(MODEL);
      chain.handleJudgeSkip(MODEL);
      expect(chain.getCount()).toBe(2);
      chain.reset();
      expect(chain.getCount()).toBe(0);
    });

    it("after reset, a new handleJudgeSkip starts fresh at count=1", () => {
      const chain = new JudgeSkipChain(3);
      chain.handleJudgeSkip(MODEL);
      chain.handleJudgeSkip(MODEL);
      chain.handleJudgeSkip(MODEL);
      chain.handleJudgeSkip(MODEL); // counted above the cap
      expect(chain.getCount()).toBe(4);

      chain.reset();
      const out = chain.handleJudgeSkip(MODEL);
      expect(out.count).toBe(1);
      expect(out.triggerTurn).toBe(true);
      expect(out.capReached).toBe(false);
    });

    it("is idempotent on an already-zero counter", () => {
      const chain = new JudgeSkipChain(3);
      chain.reset();
      chain.reset();
      expect(chain.getCount()).toBe(0);
    });
  });

  describe("content rendering matches formatter", () => {
    it("handleJudgeSkip below cap produces the same content as formatJudgeSkipMessage", () => {
      const chain = new JudgeSkipChain(3);
      const out = chain.handleJudgeSkip(MODEL);
      expect(out.content).toBe(formatJudgeSkipMessage(1, 3, MODEL, true));
    });

    it("handleJudgeSkip past cap produces the capped formatter output", () => {
      const chain = new JudgeSkipChain(2);
      chain.handleJudgeSkip(MODEL);
      chain.handleJudgeSkip(MODEL);
      const out = chain.handleJudgeSkip(MODEL); // count=3 > cap
      expect(out.content).toBe(formatJudgeSkipMessage(3, 2, MODEL, false));
    });
  });

  describe("realistic scenarios", () => {
    it("judge-skip → reset (review ran, completed) → judge-skip: second skip counts from 1", () => {
      const chain = new JudgeSkipChain();
      chain.handleJudgeSkip(MODEL); // turn 1 — skipped
      chain.handleJudgeSkip(MODEL); // turn 2 — skipped
      chain.reset(); // turn 3 — review actually ran (completed)
      const after = chain.handleJudgeSkip(MODEL); // turn 4 — skipped again
      expect(after.count).toBe(1);
      expect(after.triggerTurn).toBe(true);
    });

    it("four consecutive judge-skips with default cap: last one suppresses triggerTurn", () => {
      const chain = new JudgeSkipChain();
      const results = [
        chain.handleJudgeSkip(MODEL),
        chain.handleJudgeSkip(MODEL),
        chain.handleJudgeSkip(MODEL),
        chain.handleJudgeSkip(MODEL),
      ];
      expect(results.map((r) => r.triggerTurn)).toEqual([true, true, true, false]);
      expect(results.map((r) => r.capReached)).toEqual([false, false, false, true]);
    });
  });
});
