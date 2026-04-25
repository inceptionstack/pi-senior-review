/**
 * settings.ts — Configuration loading and validation
 *
 * Loads config from .lgtm/ in two locations (local takes precedence):
 *   1. cwd/.lgtm/   (project-local)
 *   2. ~/.pi/.lgtm/ (global)
 *
 * Files: settings.json, review-rules.md
 */

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the .lgtm config directory paths.
 * Returns [local, global] where local = cwd/.lgtm, global = ~/.pi/.lgtm.
 * Local takes precedence over global.
 */
export function configDirs(cwd: string, home?: string): [string, string] {
  return [join(cwd, ".lgtm"), join(home ?? homedir(), ".pi", ".lgtm")];
}

/**
 * Read a config file, trying local (cwd/.lgtm/) first, then global (~/.pi/.lgtm/).
 * Returns the file content or null if not found in either location.
 */
export async function readConfigFile(
  cwd: string,
  filename: string,
  home?: string,
): Promise<string | null> {
  for (const dir of configDirs(cwd, home)) {
    try {
      return await readFile(join(dir, filename), "utf8");
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Synchronous version of readConfigFile for init-time use.
 */
function readConfigFileSync(cwd: string, filename: string): string | null {
  for (const dir of configDirs(cwd)) {
    try {
      return readFileSync(join(dir, filename), "utf8");
    } catch {
      /* try next */
    }
  }
  return null;
}

// ── Types ────────────────────────────────────────────

export interface AutoReviewSettings {
  maxReviewLoops: number;
  model: string; // "provider/model-id" e.g. "amazon-bedrock/us.anthropic.claude-opus-4-6-v1"
  thinkingLevel: string; // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  architectEnabled: boolean;
  reviewTimeoutMs: number; // Max wall-clock for a single review (default 120s)
  toggleShortcut: string; // Key id for toggling review on/off (default "alt+r")
  cancelShortcut: string; // Key id for cancelling in-progress review (default: none — use /cancel-review)
  /** Duplicate-review suppressor ("judge") — see judge.ts. Off by default so
   *  users opt in. When enabled and all bash commands in a turn classify as
   *  read-only, the auto-review is skipped entirely. */
  judgeEnabled: boolean;
  /** Model used by the judge. Chosen from `eval/RESULTS.md`. */
  judgeModel: string;
  /** Max wall-clock per judge classification call (default 10s). */
  judgeTimeoutMs: number;
}

/** Shortcut-only settings loaded synchronously at init (before session_start). */
export interface ShortcutSettings {
  toggleShortcut: string;
  cancelShortcut: string;
}

export const DEFAULT_TOGGLE_SHORTCUT = "alt+r";
export const DEFAULT_CANCEL_SHORTCUT = ""; // no default shortcut — use /cancel-review command

export const DEFAULT_SETTINGS: AutoReviewSettings = {
  maxReviewLoops: 100,
  model: "amazon-bedrock/us.anthropic.claude-opus-4-6-v1",
  thinkingLevel: "off",
  architectEnabled: true, // triggers when >1 file reviewed
  reviewTimeoutMs: 120_000,
  toggleShortcut: DEFAULT_TOGGLE_SHORTCUT,
  cancelShortcut: DEFAULT_CANCEL_SHORTCUT,
  judgeEnabled: false,
  judgeModel: "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0",
  judgeTimeoutMs: 10_000,
};

export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

// ── Parsing ──────────────────────────────────────────

/**
 * Parse and validate a raw settings object against the schema.
 * Pure function — no I/O. Returns validated settings + any errors.
 */
export function parseSettings(parsed: Record<string, unknown>): {
  settings: AutoReviewSettings;
  errors: string[];
} {
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
        `[lgtm] "maxReviewLoops" must be a positive integer (got ${JSON.stringify(parsed.maxReviewLoops)}). Using default: ${DEFAULT_SETTINGS.maxReviewLoops}.`,
      );
    }
  }

  if ("model" in parsed) {
    if (typeof parsed.model === "string" && parsed.model.includes("/")) {
      settings.model = parsed.model;
    } else {
      errors.push(
        `[lgtm] "model" must be "provider/model-id" (got ${JSON.stringify(parsed.model)}). Using default: ${DEFAULT_SETTINGS.model}.`,
      );
    }
  }

  if ("thinkingLevel" in parsed) {
    if (
      typeof parsed.thinkingLevel === "string" &&
      VALID_THINKING_LEVELS.includes(parsed.thinkingLevel)
    ) {
      settings.thinkingLevel = parsed.thinkingLevel;
    } else {
      errors.push(
        `[lgtm] "thinkingLevel" must be one of ${VALID_THINKING_LEVELS.join(", ")} (got ${JSON.stringify(parsed.thinkingLevel)}). Using default: ${DEFAULT_SETTINGS.thinkingLevel}.`,
      );
    }
  }

  if ("architectEnabled" in parsed) {
    if (typeof parsed.architectEnabled === "boolean") {
      settings.architectEnabled = parsed.architectEnabled;
    } else {
      errors.push(
        `[lgtm] "architectEnabled" must be a boolean (got ${JSON.stringify(parsed.architectEnabled)}). Using default: ${DEFAULT_SETTINGS.architectEnabled}.`,
      );
    }
  }

  // Backwards compat: accept old "roundupEnabled" if "architectEnabled" not set
  if (!("architectEnabled" in parsed) && "roundupEnabled" in parsed) {
    if (typeof parsed.roundupEnabled === "boolean") {
      settings.architectEnabled = parsed.roundupEnabled;
    } else {
      errors.push(
        `[lgtm] "roundupEnabled" must be a boolean (got ${JSON.stringify(parsed.roundupEnabled)}). Using default: ${DEFAULT_SETTINGS.architectEnabled}.`,
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
        `[lgtm] "reviewTimeoutMs" must be a positive integer (got ${JSON.stringify(parsed.reviewTimeoutMs)}). Using default: ${DEFAULT_SETTINGS.reviewTimeoutMs}.`,
      );
    }
  }

  if ("toggleShortcut" in parsed) {
    if (typeof parsed.toggleShortcut === "string" && parsed.toggleShortcut.trim()) {
      settings.toggleShortcut = parsed.toggleShortcut.trim();
    } else {
      errors.push(
        `[lgtm] "toggleShortcut" must be a non-empty string key id (got ${JSON.stringify(parsed.toggleShortcut)}). Using default: ${DEFAULT_SETTINGS.toggleShortcut}.`,
      );
    }
  }

  if ("cancelShortcut" in parsed) {
    if (typeof parsed.cancelShortcut === "string") {
      // Empty string is valid — means "no shortcut" (use /cancel-review command instead)
      settings.cancelShortcut = parsed.cancelShortcut.trim();
    } else {
      errors.push(
        `[lgtm] "cancelShortcut" must be a string key id (got ${JSON.stringify(parsed.cancelShortcut)}). Using default: ${DEFAULT_SETTINGS.cancelShortcut}.`,
      );
    }
  }

  if ("judgeEnabled" in parsed) {
    if (typeof parsed.judgeEnabled === "boolean") {
      settings.judgeEnabled = parsed.judgeEnabled;
    } else {
      errors.push(
        `[lgtm] "judgeEnabled" must be a boolean (got ${JSON.stringify(parsed.judgeEnabled)}). Using default: ${DEFAULT_SETTINGS.judgeEnabled}.`,
      );
    }
  }

  if ("judgeModel" in parsed) {
    if (typeof parsed.judgeModel === "string" && parsed.judgeModel.includes("/")) {
      settings.judgeModel = parsed.judgeModel;
    } else {
      errors.push(
        `[lgtm] "judgeModel" must be "provider/model-id" (got ${JSON.stringify(parsed.judgeModel)}). Using default: ${DEFAULT_SETTINGS.judgeModel}.`,
      );
    }
  }

  if ("judgeTimeoutMs" in parsed) {
    if (
      typeof parsed.judgeTimeoutMs === "number" &&
      Number.isInteger(parsed.judgeTimeoutMs) &&
      parsed.judgeTimeoutMs > 0
    ) {
      settings.judgeTimeoutMs = parsed.judgeTimeoutMs;
    } else {
      errors.push(
        `[lgtm] "judgeTimeoutMs" must be a positive integer (got ${JSON.stringify(parsed.judgeTimeoutMs)}). Using default: ${DEFAULT_SETTINGS.judgeTimeoutMs}.`,
      );
    }
  }

  const knownKeys = new Set(Object.keys(DEFAULT_SETTINGS));
  // Accept legacy "roundupEnabled" without warning
  knownKeys.add("roundupEnabled");
  for (const key of Object.keys(parsed)) {
    if (!knownKeys.has(key)) {
      errors.push(
        `[lgtm] Unknown setting "${key}" (ignored). Known: ${[...knownKeys].join(", ")}.`,
      );
    }
  }

  return { settings, errors };
}

// ── File loaders ─────────────────────────────────────

/**
 * Load and validate .lgtm/settings.json.
 * Tries cwd/.lgtm/ first, then ~/.pi/.lgtm/.
 */
export async function loadSettings(
  cwd: string,
): Promise<{ settings: AutoReviewSettings; errors: string[] }> {
  const errors: string[] = [];

  const raw = await readConfigFile(cwd, "settings.json");
  if (raw === null) return { settings: { ...DEFAULT_SETTINGS }, errors };

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    errors.push(`[lgtm] .lgtm/settings.json is not valid JSON: ${e.message}. Using defaults.`);
    return { settings: { ...DEFAULT_SETTINGS }, errors };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    errors.push(`[lgtm] .lgtm/settings.json must be a JSON object. Using defaults.`);
    return { settings: { ...DEFAULT_SETTINGS }, errors };
  }

  const result = parseSettings(parsed);
  return { settings: result.settings, errors: [...errors, ...result.errors] };
}

/**
 * Synchronously load shortcut settings from .lgtm/settings.json.
 * Tries cwd/.lgtm/ first, then ~/.pi/.lgtm/.
 * Used at extension init time (before session_start) for shortcut registration.
 * Falls back to defaults on any error — never throws.
 */
export function loadShortcutSettingsSync(cwd: string): ShortcutSettings {
  const defaults: ShortcutSettings = {
    toggleShortcut: DEFAULT_TOGGLE_SHORTCUT,
    cancelShortcut: DEFAULT_CANCEL_SHORTCUT,
  };
  try {
    const raw = readConfigFileSync(cwd, "settings.json");
    if (raw === null) return defaults;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return defaults;
    if (typeof parsed.toggleShortcut === "string" && parsed.toggleShortcut.trim()) {
      defaults.toggleShortcut = parsed.toggleShortcut.trim();
    }
    if (typeof parsed.cancelShortcut === "string" && parsed.cancelShortcut.trim()) {
      defaults.cancelShortcut = parsed.cancelShortcut.trim();
    }
  } catch {
    /* bad JSON — use defaults */
  }
  return defaults;
}

/**
 * Load .lgtm/review-rules.md custom review rules.
 * Tries cwd/.lgtm/ first, then ~/.pi/.lgtm/.
 */
export async function loadReviewRules(cwd: string): Promise<string | null> {
  const content = await readConfigFile(cwd, "review-rules.md");
  return content?.trim() || null;
}

/**
 * Load .lgtm/auto-review.md — overrides the "what to review / what not to report"
 * section of the review prompt. Returns null if not found (uses built-in defaults).
 * Tries cwd/.lgtm/ first, then ~/.pi/.lgtm/.
 */
export async function loadAutoReviewRules(cwd: string): Promise<string | null> {
  const content = await readConfigFile(cwd, "auto-review.md");
  return content?.trim() || null;
}
