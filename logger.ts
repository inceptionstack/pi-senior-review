/**
 * logger.ts — File logger for pi-autoreview
 *
 * Two outputs under ~/.pi/.autoreview/:
 *   review.log       — free-text timestamped lines (rotates at 1MB)
 *   reviews/*.json   — one structured JSON file per completed review
 *
 * Uses sync writes to guarantee output even in complex async flows.
 */

import { appendFileSync, mkdirSync, statSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), ".pi", ".autoreview");
const LOG_FILE = join(LOG_DIR, "review.log");
const LOG_OLD = join(LOG_DIR, "review.log.old");
const REVIEWS_DIR = join(LOG_DIR, "reviews");
const MAX_LOG_SIZE = 1_000_000; // 1MB

let initialized = false;

function ensureDirs() {
  if (initialized) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    mkdirSync(REVIEWS_DIR, { recursive: true });
    initialized = true;
  } catch {
    // best effort
  }
}

function maybeRotate() {
  try {
    const s = statSync(LOG_FILE);
    if (s.size > MAX_LOG_SIZE) {
      try { renameSync(LOG_FILE, LOG_OLD); } catch { /* ok */ }
    }
  } catch {
    // file doesn't exist yet
  }
}

function ts(): string {
  return new Date().toISOString();
}

export function log(...args: any[]) {
  ensureDirs();
  const line = `[${ts()}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // best effort
  }
}

/** Log and also rotate if needed (call once per review cycle) */
export function logRotate(...args: any[]) {
  maybeRotate();
  log(...args);
}

// ── Structured review history ──────────────────────

export interface ReviewToolCall {
  name: string;
  args?: any;
  timestamp: string;
}

export interface ReviewLogEntry {
  timestamp: string;
  durationMs: number;
  model: string;
  thinkingLevel: string;
  isLgtm: boolean;
  promptLength: number;
  rawText: string;
  cleanedText: string;
  filesReviewed: string[];
  toolCalls: ReviewToolCall[];
  label?: string;
}

/**
 * Write a structured JSON record for a single review.
 * Filename: <timestamp>_<lgtm|issues>.json
 */
export function logReview(entry: ReviewLogEntry): string | null {
  ensureDirs();
  const safeTs = entry.timestamp.replace(/[:.]/g, "-");
  const verdict = entry.isLgtm ? "lgtm" : "issues";
  const filename = `${safeTs}_${verdict}.json`;
  const fullPath = join(REVIEWS_DIR, filename);
  try {
    writeFileSync(fullPath, JSON.stringify(entry, null, 2));
    return fullPath;
  } catch {
    return null;
  }
}

export { LOG_FILE, LOG_DIR, REVIEWS_DIR };
