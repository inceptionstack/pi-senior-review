/**
 * Tests for session-kind.ts — the main-vs-spawned-session detector.
 *
 * Pure unit tests: no pi SDK needed, we inject mock ExtensionAPI shapes
 * exposing just what the probe reads (`getAllTools`).
 *
 * Coverage:
 *   - main session (write + edit available) → not spawned
 *   - reviewer session (read/bash/grep/find/ls) → spawned
 *   - edge cases: write-only, edit-only, empty tools, missing getAllTools
 *   - fail-safe: probe throws → defaults to main session (false)
 *   - caching: second call on same pi doesn't re-probe
 *   - isolation: distinct pi objects have independent cache entries
 */

import { describe, it, expect, vi } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { isSpawnedSubSession } from "../session-kind";

function mockPi(tools: Array<{ name: string }> | (() => Array<{ name: string }>)) {
  const getAllTools = typeof tools === "function" ? tools : () => tools;
  return { getAllTools } as unknown as ExtensionAPI;
}

function mockPiThrows(message: string) {
  return {
    getAllTools: () => {
      throw new Error(message);
    },
  } as unknown as ExtensionAPI;
}

describe("isSpawnedSubSession", () => {
  describe("main session (has write/edit tools)", () => {
    it("returns false when both write and edit are present", () => {
      const pi = mockPi([{ name: "read" }, { name: "bash" }, { name: "write" }, { name: "edit" }]);
      expect(isSpawnedSubSession(pi)).toBe(false);
    });

    it("returns false when only write is present", () => {
      const pi = mockPi([{ name: "read" }, { name: "bash" }, { name: "write" }]);
      expect(isSpawnedSubSession(pi)).toBe(false);
    });

    it("returns false when only edit is present", () => {
      const pi = mockPi([{ name: "read" }, { name: "bash" }, { name: "edit" }]);
      expect(isSpawnedSubSession(pi)).toBe(false);
    });

    it("returns false for a realistic full main-session tool set", () => {
      const pi = mockPi([
        { name: "read" },
        { name: "write" },
        { name: "edit" },
        { name: "bash" },
        { name: "grep" },
        { name: "find" },
        { name: "ls" },
      ]);
      expect(isSpawnedSubSession(pi)).toBe(false);
    });
  });

  describe("spawned session (no write/edit)", () => {
    it("returns true for the exact reviewer.ts tool set", () => {
      const pi = mockPi([
        { name: "read" },
        { name: "bash" },
        { name: "grep" },
        { name: "find" },
        { name: "ls" },
      ]);
      expect(isSpawnedSubSession(pi)).toBe(true);
    });

    it("returns true when tool list contains no write/edit at all", () => {
      const pi = mockPi([{ name: "read" }, { name: "bash" }]);
      expect(isSpawnedSubSession(pi)).toBe(true);
    });

    it("returns true for an empty tool list", () => {
      // Degenerate edge case — no tools at all. Nothing can modify files.
      const pi = mockPi([]);
      expect(isSpawnedSubSession(pi)).toBe(true);
    });

    it("ignores tools with non-matching names (e.g. custom 'editor' tool)", () => {
      // Similar-looking but not the canonical names: still classify as spawned.
      const pi = mockPi([{ name: "read" }, { name: "editor" }, { name: "writer" }]);
      expect(isSpawnedSubSession(pi)).toBe(true);
    });
  });

  describe("fail-safe (probe errors default to main session)", () => {
    it("returns false when getAllTools throws the stale-ctx error", () => {
      const pi = mockPiThrows("This extension ctx is stale after session replacement or reload.");
      expect(isSpawnedSubSession(pi)).toBe(false);
    });

    it("returns false when getAllTools throws a generic error", () => {
      const pi = mockPiThrows("something exploded");
      expect(isSpawnedSubSession(pi)).toBe(false);
    });

    it("returns false when getAllTools is missing from pi entirely", () => {
      // Simulates a very-early-activation call or a malformed mock.
      const pi = {} as unknown as ExtensionAPI;
      expect(isSpawnedSubSession(pi)).toBe(false);
    });

    it("returns false when getAllTools returns a non-array", () => {
      const pi = { getAllTools: () => "nope" as unknown as [] } as unknown as ExtensionAPI;
      expect(isSpawnedSubSession(pi)).toBe(false);
    });

    it("tolerates tool entries with missing/non-string name fields", () => {
      // `name` absent or wrong type is filtered out before the write/edit
      // lookup, so only valid names count. With no valid write/edit names,
      // the result is "spawned".
      const pi = mockPi([
        { name: undefined as unknown as string },
        { name: 42 as unknown as string },
        { name: "read" },
      ]);
      expect(isSpawnedSubSession(pi)).toBe(true);
    });
  });

  describe("caching", () => {
    it("does not re-invoke getAllTools on repeated calls with the same pi", () => {
      const spy = vi.fn(() => [{ name: "read" }, { name: "write" }]);
      const pi = mockPi(spy);
      expect(isSpawnedSubSession(pi)).toBe(false);
      expect(isSpawnedSubSession(pi)).toBe(false);
      expect(isSpawnedSubSession(pi)).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("caches the spawned-session verdict too", () => {
      const spy = vi.fn(() => [{ name: "read" }, { name: "bash" }]);
      const pi = mockPi(spy);
      expect(isSpawnedSubSession(pi)).toBe(true);
      expect(isSpawnedSubSession(pi)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("distinct pi objects do not share cache entries", () => {
      // Classic scenario: main pi (with write/edit) + reviewer pi (without).
      // Both should be classified independently and correctly.
      const mainPi = mockPi([{ name: "read" }, { name: "write" }, { name: "edit" }]);
      const reviewerPi = mockPi([{ name: "read" }, { name: "bash" }]);
      expect(isSpawnedSubSession(mainPi)).toBe(false);
      expect(isSpawnedSubSession(reviewerPi)).toBe(true);
      // Re-query to confirm no cross-pollution.
      expect(isSpawnedSubSession(mainPi)).toBe(false);
      expect(isSpawnedSubSession(reviewerPi)).toBe(true);
    });

    it("caches a fail-safe (false) result so a probe that started failing keeps returning false", () => {
      const spy = vi.fn(() => {
        throw new Error("stale");
      });
      const pi = { getAllTools: spy } as unknown as ExtensionAPI;
      expect(isSpawnedSubSession(pi)).toBe(false);
      expect(isSpawnedSubSession(pi)).toBe(false);
      // Cache holds even for the fail-safe branch — we don't keep retrying.
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});
