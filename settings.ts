/**
 * settings.ts — Configuration loading and validation
 *
 * Loads .autoreview/settings.json and .autoreview/review-rules.md
 * from the project root.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────

export interface AutoReviewSettings {
  maxReviewLoops: number;
  model: string; // "provider/model-id" e.g. "amazon-bedrock/us.anthropic.claude-opus-4-6-v1"
  thinkingLevel: string; // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  roundupEnabled: boolean;
  reviewTimeoutMs: number; // Max wall-clock for a single review (default 120s)
}

export const DEFAULT_SETTINGS: AutoReviewSettings = {
  maxReviewLoops: 100,
  model: "amazon-bedrock/us.anthropic.claude-opus-4-6-v1",
  thinkingLevel: "off",
  roundupEnabled: false,
  reviewTimeoutMs: 120_000,
};

export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

// ── Parsing ──────────────────────────────────────────

/**
 * Parse and validate a raw settings object against the schema.
 * Pure function — no I/O. Returns validated settings + any errors.
 */
export function parseSettings(
  parsed: Record<string, unknown>,
): { settings: AutoReviewSettings; errors: string[] } {
  const errors: string[] = [];
  const settings = { ...DEFAULT_SETTINGS };

  if ("maxReviewLoops" in parsed) {
    if (
      typeof parsed.maxReviewLoops === "number" &&
      Number.isInteger(parsed.maxReviewLoops) &&
      parsed.maxReviewLoops > 0
    ) {
      settings.maxReviewLoops = parsed.maxReviewLoops;
    } else {
      errors.push(
        `[auto-review] "maxReviewLoops" must be a positive integer (got ${JSON.stringify(parsed.maxReviewLoops)}). Using default: ${DEFAULT_SETTINGS.maxReviewLoops}.`,
      );
    }
  }

  if ("model" in parsed) {
    if (typeof parsed.model === "string" && parsed.model.includes("/")) {
      settings.model = parsed.model;
    } else {
      errors.push(
        `[auto-review] "model" must be "provider/model-id" (got ${JSON.stringify(parsed.model)}). Using default: ${DEFAULT_SETTINGS.model}.`,
      );
    }
  }

  if ("thinkingLevel" in parsed) {
    if (typeof parsed.thinkingLevel === "string" && VALID_THINKING_LEVELS.includes(parsed.thinkingLevel)) {
      settings.thinkingLevel = parsed.thinkingLevel;
    } else {
      errors.push(
        `[auto-review] "thinkingLevel" must be one of ${VALID_THINKING_LEVELS.join(", ")} (got ${JSON.stringify(parsed.thinkingLevel)}). Using default: ${DEFAULT_SETTINGS.thinkingLevel}.`,
      );
    }
  }

  if ("roundupEnabled" in parsed) {
    if (typeof parsed.roundupEnabled === "boolean") {
      settings.roundupEnabled = parsed.roundupEnabled;
    } else {
      errors.push(
        `[auto-review] "roundupEnabled" must be a boolean (got ${JSON.stringify(parsed.roundupEnabled)}). Using default: ${DEFAULT_SETTINGS.roundupEnabled}.`,
      );
    }
  }

  if ("reviewTimeoutMs" in parsed) {
    if (
      typeof parsed.reviewTimeoutMs === "number" &&
      Number.isInteger(parsed.reviewTimeoutMs) &&
      parsed.reviewTimeoutMs > 0
    ) {
      settings.reviewTimeoutMs = parsed.reviewTimeoutMs;
    } else {
      errors.push(
        `[auto-review] "reviewTimeoutMs" must be a positive integer (got ${JSON.stringify(parsed.reviewTimeoutMs)}). Using default: ${DEFAULT_SETTINGS.reviewTimeoutMs}.`,
      );
    }
  }

  const knownKeys = new Set(Object.keys(DEFAULT_SETTINGS));
  for (const key of Object.keys(parsed)) {
    if (!knownKeys.has(key)) {
      errors.push(
        `[auto-review] Unknown setting "${key}" (ignored). Known: ${[...knownKeys].join(", ")}.`,
      );
    }
  }

  return { settings, errors };
}

// ── File loaders ─────────────────────────────────────

/**
 * Load and validate .autoreview/settings.json.
 */
export async function loadSettings(
  cwd: string,
): Promise<{ settings: AutoReviewSettings; errors: string[] }> {
  const errors: string[] = [];

  try {
    const raw = await readFile(join(cwd, ".autoreview", "settings.json"), "utf8");

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (e: any) {
      errors.push(
        `[auto-review] .autoreview/settings.json is not valid JSON: ${e.message}. Using defaults.`,
      );
      return { settings: { ...DEFAULT_SETTINGS }, errors };
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      errors.push(`[auto-review] .autoreview/settings.json must be a JSON object. Using defaults.`);
      return { settings: { ...DEFAULT_SETTINGS }, errors };
    }

    const result = parseSettings(parsed);
    return { settings: result.settings, errors: [...errors, ...result.errors] };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, errors };
  }
}

/**
 * Load .autoreview/review-rules.md custom review rules.
 */
export async function loadReviewRules(cwd: string): Promise<string | null> {
  try {
    const content = await readFile(join(cwd, ".autoreview", "review-rules.md"), "utf8");
    return content.trim() || null;
  } catch {
    return null;
  }
}
