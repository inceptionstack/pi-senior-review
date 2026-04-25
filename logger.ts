/**
 * logger.ts — File logger for pi-lgtm
 *
 * Two outputs under ~/.pi/.lgtm/:
 *   review.log       — free-text timestamped lines (rotates at 1MB)
 *   reviews/*.json   — one structured JSON file per completed review
 *
 * Uses sync writes to guarantee output even in complex async flows.
 */

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), ".pi", ".lgtm");
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
      try {
        renameSync(LOG_FILE, LOG_OLD);
      } catch {
        /* ok */
      }
    }
  } catch {
    // file doesn't exist yet
  }
}

function ts(): string {
  return new Date().toISOString();
}

function safeStringify(a: any): string {
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

export { safeStringify };

export function log(...args: any[]) {
  ensureDirs();
  const line = `[${ts()}] ${args.map(safeStringify).join(" ")}\n`;
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
  /** Unique id for this review cycle (e.g. "r-a3f71c08"). Matches the prefix used in review.log lines. */
  reviewId?: string;
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
 * Filename: <timestamp>_<lgtm|issues>[_<reviewId>].json
 * The reviewId suffix is appended when provided so logs from the same
 * review cycle can be correlated across review.log and reviews/*.json.
 */
export function logReview(entry: ReviewLogEntry): string | null {
  ensureDirs();
  const safeTs = entry.timestamp.replace(/[:.]/g, "-");
  const verdict = entry.isLgtm ? "lgtm" : "issues";
  const idSuffix = entry.reviewId ? `_${entry.reviewId}` : "";
  const filename = `${safeTs}_${verdict}${idSuffix}.json`;
  const fullPath = join(REVIEWS_DIR, filename);
  try {
    writeFileSync(fullPath, JSON.stringify(entry, null, 2));
    return fullPath;
  } catch {
    return null;
  }
}

/**
 * Remove all pi-lgtm log/review history files.
 * Wipes `review.log`, the rotated `review.log.old`, and every
 * `reviews/*.json` structured record. Does NOT touch user config
 * (settings.json, review-rules.md, etc.) — only the append-only
 * history pi-lgtm owns.
 *
 * Returns a summary of what was removed.
 */
export function cleanLogs(): { logsRemoved: number; reviewsRemoved: number } {
  let logsRemoved = 0;
  let reviewsRemoved = 0;
  for (const file of [LOG_FILE, LOG_OLD]) {
    try {
      rmSync(file, { force: true });
      logsRemoved++;
    } catch {
      /* already gone */
    }
  }
  try {
    const files = readdirSync(REVIEWS_DIR);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        rmSync(join(REVIEWS_DIR, f), { force: true });
        reviewsRemoved++;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* reviews dir might not exist yet */
  }
  return { logsRemoved, reviewsRemoved };
}

export { LOG_FILE, LOG_DIR, REVIEWS_DIR };
