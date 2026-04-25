/**
 * Tests for judge.ts — the duplicate-review suppressor classifier.
 *
 * Focus on the pieces that can be tested without touching the SDK:
 *   - parseJudgeResponse: parsing fidelity across strict/lenient outputs
 *   - classifyBashCommand: fail-open behavior when the runner throws
 *
 * The `defaultJudgeRunner` (which spawns a real pi session) is not unit-tested
 * here; it's exercised end-to-end by the eval harness under `eval/`.
 */

import { describe, it, expect } from "vitest";

import { classifyBashCommand, JUDGE_CLASSES, parseJudgeResponse, type JudgeRunner } from "../judge";

describe("JUDGE_CLASSES", () => {
  it("exposes exactly three known classes in a fixed order", () => {
    expect([...JUDGE_CLASSES]).toEqual(["inspection_vcs_noop", "modifying", "unsure"]);
  });
});

describe("parseJudgeResponse", () => {
  describe("strict JSON", () => {
    it("returns inspection_vcs_noop for clean JSON", () => {
      expect(parseJudgeResponse('{"classification":"inspection_vcs_noop"}')).toBe(
        "inspection_vcs_noop",
      );
    });

    it("returns modifying for clean JSON", () => {
      expect(parseJudgeResponse('{"classification":"modifying"}')).toBe("modifying");
    });

    it("returns unsure for clean JSON", () => {
      expect(parseJudgeResponse('{"classification":"unsure"}')).toBe("unsure");
    });

    it("tolerates surrounding whitespace", () => {
      expect(parseJudgeResponse('\n  {"classification": "modifying"}  \n')).toBe("modifying");
    });

    it("tolerates pretty-printed JSON with whitespace between fields", () => {
      expect(parseJudgeResponse('{\n  "classification": "inspection_vcs_noop"\n}')).toBe(
        "inspection_vcs_noop",
      );
    });
  });

  describe("fenced output", () => {
    it("strips ```json fences", () => {
      expect(parseJudgeResponse('```json\n{"classification":"modifying"}\n```')).toBe("modifying");
    });

    it("strips plain ``` fences", () => {
      expect(parseJudgeResponse('```\n{"classification":"unsure"}\n```')).toBe("unsure");
    });

    it("handles fences on a single line", () => {
      expect(parseJudgeResponse('```json {"classification":"inspection_vcs_noop"} ```')).toBe(
        "inspection_vcs_noop",
      );
    });
  });

  describe("regex fallback", () => {
    it("extracts classification from prose", () => {
      expect(parseJudgeResponse("The answer is modifying because git add mutates the index.")).toBe(
        "modifying",
      );
    });

    it("extracts classification when enum appears without JSON structure", () => {
      expect(parseJudgeResponse("inspection_vcs_noop")).toBe("inspection_vcs_noop");
    });

    it("returns unsure when no known class string appears", () => {
      expect(parseJudgeResponse("I cannot answer this question.")).toBe("unsure");
    });

    it("returns unsure for empty input", () => {
      expect(parseJudgeResponse("")).toBe("unsure");
    });
  });

  describe("rejects unknown classifications", () => {
    it("returns unsure when JSON has an unknown enum value", () => {
      // Bare string with no fuzzy match — "dangerous" isn't a known class.
      expect(parseJudgeResponse('{"classification":"dangerous"}')).toBe("unsure");
    });

    it("returns unsure when JSON is well-formed but missing `classification`", () => {
      expect(parseJudgeResponse('{"foo":"bar"}')).toBe("unsure");
    });

    it("returns unsure when `classification` is null", () => {
      expect(parseJudgeResponse('{"classification":null}')).toBe("unsure");
    });
  });
});

describe("classifyBashCommand", () => {
  const fakeOpts = {
    signal: new AbortController().signal,
    cwd: "/tmp",
    model: "mock/model",
    timeoutMs: 10_000,
  };

  it("returns the parsed classification when the runner succeeds", async () => {
    const runner: JudgeRunner = async () => ({ text: '{"classification":"inspection_vcs_noop"}' });
    expect(await classifyBashCommand(runner, "ls", fakeOpts)).toBe("inspection_vcs_noop");
  });

  it("fails open to `unsure` when the runner throws", async () => {
    const runner: JudgeRunner = async () => {
      throw new Error("transport failed");
    };
    expect(await classifyBashCommand(runner, "git status", fakeOpts)).toBe("unsure");
  });

  it("fails open to `unsure` when the runner rejects via timeout", async () => {
    const runner: JudgeRunner = async () => {
      throw new Error("judge timeout");
    };
    expect(await classifyBashCommand(runner, "git log", fakeOpts)).toBe("unsure");
  });

  it("returns `unsure` for an empty command without calling the runner", async () => {
    let called = 0;
    const runner: JudgeRunner = async () => {
      called++;
      return { text: '{"classification":"modifying"}' };
    };
    expect(await classifyBashCommand(runner, "", fakeOpts)).toBe("unsure");
    expect(called).toBe(0);
  });

  it("returns `unsure` for a non-string command without calling the runner", async () => {
    let called = 0;
    const runner: JudgeRunner = async () => {
      called++;
      return { text: '{"classification":"modifying"}' };
    };
    // Forced type-through to simulate a malformed caller.
    expect(await classifyBashCommand(runner, null as unknown as string, fakeOpts)).toBe("unsure");
    expect(called).toBe(0);
  });

  it("parses fenced JSON responses through classifyBashCommand end-to-end", async () => {
    const runner: JudgeRunner = async () => ({
      text: '```json\n{"classification":"modifying"}\n```',
    });
    expect(await classifyBashCommand(runner, "git push", fakeOpts)).toBe("modifying");
  });

  it("fails open on malformed responses", async () => {
    const runner: JudgeRunner = async () => ({ text: "idk maybe ok?" });
    expect(await classifyBashCommand(runner, "something", fakeOpts)).toBe("unsure");
  });
});
