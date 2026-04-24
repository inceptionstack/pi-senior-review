/**
 * reviewer.ts — Review session with full context
 *
 * The reviewer gets:
 * - Full git diff
 * - List of changed files
 * - Full contents of each changed file
 * - Project file tree
 * - Read-only tools to explore the codebase further
 * - Live status updates shown in the main pi status bar
 *
 * Uses the standardized file logger for all diagnostic output.
 */

import {
  type ExtensionAPI,
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";

import { log, logReview, type ReviewToolCall } from "./logger";

export interface ReviewResult {
  /** Cleaned review text shown to the user. */
  text: string;
  /** Raw LLM output before cleanup (for debugging / structured log). */
  rawText: string;
  isLgtm: boolean;
  durationMs: number;
  /** Every tool call the reviewer made during exploration. */
  toolCalls: ReviewToolCall[];
  /** Effective model used for the review. */
  model: string;
  /** Effective thinking level used. */
  thinkingLevel: string;
}

export interface ReviewOptions {
  signal: AbortSignal;
  cwd: string;
  /** "provider/model-id" to use for the reviewer */
  model?: string;
  /** Thinking level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" */
  thinkingLevel?: string;
  /** Max wall-clock for main prompt (ms). Default 120000. */
  timeoutMs?: number;
  /** Files being reviewed (used in the structured log record). */
  filesReviewed?: string[];
  /** Called when the reviewer uses tools — for status bar updates */
  onActivity?: (description: string) => void;
  /** Called with structured tool call info — for display widget */
  onToolCall?: (toolName: string, targetPath: string | null) => void;
}

/** Review text markers that indicate where the actual review findings start. */
const REVIEW_MARKERS = [
  /\n##\s*Review/i,
  /\n##\s*Issues/i,
  /\n##\s*Findings/i,
  /\nHere'?s my review/i,
  /\nHere are the issues/i,
  /\n-\s*\*\*(High|Medium|Low)/i,
  /\n-\s*\[(High|Medium|Low)/i,
  /\n\*\*Issues found/i,
  /No issues found\./i,
];

/**
 * Strip tool-call noise from raw review text.
 * Order: strip verdict tags → find review start marker → strip XML tags.
 */
export function cleanReviewText(raw: string): string {
  // Strip verdict tags FIRST so they don't interfere with marker detection
  let text = stripVerdict(raw);

  // Find where the actual review findings start
  for (const marker of REVIEW_MARKERS) {
    const match = text.match(marker);
    if (match?.index !== undefined && match.index > 0) {
      text = text.slice(match.index).trim();
      break;
    }
  }

  // Strip XML-style tool tags
  text = text.replace(/<(bash|read_file|grep|find|ls)[^>]*>[\s\S]*?<\/\1>/g, "");
  text = text.replace(/<(bash|read_file|grep|find|ls)[^>]*\/>/g, "");
  return text.trim();
}

/**
 * Severity markers that indicate the reviewer found issues.
 * If any of these appear in the review text, it is NOT LGTM.
 */
const ISSUE_MARKERS = [
  /\bHigh\s*(?:severity|—|-|:)/i,
  /\bMedium\s*(?:severity|—|-|:)/i,
  /\bLow\s*(?:severity|—|-|:)/i,
  /-\s*\*\*(High|Medium|Low)/i,
  /^###?\s*(High|Medium|Low)/im,
  /\*\*Issues found/i,
];

/**
 * Parse the verdict tag from the reviewer's response.
 * Returns "lgtm" if <verdict>LGTM</verdict>, "issues" if <verdict>ISSUES_FOUND</verdict>,
 * or null if no verdict tag is present (requires retry).
 */
export function parseVerdict(text: string): "lgtm" | "issues" | null {
  const match = text.match(/<verdict>\s*(LGTM|ISSUES_FOUND)\s*<\/verdict>/i);
  if (!match) return null;
  return match[1].toUpperCase() === "LGTM" ? "lgtm" : "issues";
}

/**
 * Strip the verdict tag from the cleaned review text.
 * The verdict is metadata; the user shouldn't see it in the rendered message.
 */
export function stripVerdict(text: string): string {
  return text.replace(/<verdict>\s*(LGTM|ISSUES_FOUND)\s*<\/verdict>/gi, "").trim();
}

/**
 * Check if cleaned review text indicates LGTM (no issues).
 * Prefer parseVerdict() for explicit verdict tags; this is a fallback heuristic.
 */
export function isLgtmResult(cleanedText: string): boolean {
  const text = cleanedText.trim();
  if (!text) return true;

  // Any severity marker = issues were found, regardless of LGTM mention
  for (const marker of ISSUE_MARKERS) {
    if (marker.test(text)) return false;
  }

  // Explicit LGTM at start of response (after optional "Review:" or "-" prefix)
  if (/^[-\s]*(?:Review:\s*)?LGTM\b/i.test(text)) return true;

  // No severity markers and no clear LGTM — default to NOT LGTM.
  // Safer to show the text than silently swallow it.
  return false;
}

/** Format a tool call event as a short activity string for the status bar. */
function formatActivity(name: string, args: any): string {
  if (name === "read") return `reading ${args?.path ?? "file"}`;
  if (name === "bash") return `$ ${(args?.command ?? "").slice(0, 50)}`;
  if (name === "find" || name === "grep" || name === "ls") {
    return `${name} ${(args?.path ?? args?.pattern ?? "").slice(0, 40)}`;
  }
  return `${name}…`;
}

/**
 * Spawn a fresh pi reviewer instance with tools, send a prompt,
 * collect the response. The reviewer can read files and explore
 * the codebase as needed.
 */
export async function runReviewSession(prompt: string, opts: ReviewOptions): Promise<ReviewResult> {
  const startTime = Date.now();
  const startedAt = new Date().toISOString();
  log(`reviewer: starting (prompt=${(prompt.length / 1000).toFixed(1)}k chars, cwd=${opts.cwd})`);

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    // Allowlist only read-only tools + bash; no write/edit for the reviewer
    tools: ["read", "bash", "grep", "find", "ls"],
  });
  log(`reviewer: session created, initial model=${session.model?.provider}/${session.model?.id}`);

  // Set the reviewer model if specified
  const sessionModelName = session.model
    ? `${session.model.provider}/${session.model.id}`
    : "unknown";
  let effectiveModel = opts.model ?? sessionModelName;
  if (opts.model) {
    const [provider, modelId] = opts.model.split("/", 2);
    if (provider && modelId) {
      const model = modelRegistry.find(provider, modelId);
      if (model) {
        try {
          await session.setModel(model);
          log(`reviewer: using model ${opts.model}`);
        } catch {
          const defaultName = session.model
            ? `${session.model.provider}/${session.model.id}`
            : "unknown";
          log(`reviewer: model ${opts.model} has no API key. Falling back to ${defaultName}`);
          effectiveModel = defaultName;
          opts.onActivity?.(`default model: ${defaultName}`);
        }
      } else {
        const defaultName = session.model
          ? `${session.model.provider}/${session.model.id}`
          : "unknown";
        log(`reviewer: model ${opts.model} not found. Falling back to ${defaultName}`);
        effectiveModel = defaultName;
        opts.onActivity?.(`default model: ${defaultName}`);
      }
    }
  }

  // Set thinking level (default: off for fast reviews)
  type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  const thinkingLevel = (opts.thinkingLevel ?? "off") as ThinkingLevel;
  session.setThinkingLevel(thinkingLevel);
  log(`reviewer: thinking level = ${thinkingLevel}`);

  let currentText = ""; // always holds the latest assistant message (reset on message_start)
  let reviewText = ""; // set once after main sendPrompt completes; preserved through retries
  const toolCalls: ReviewToolCall[] = [];

  const unsub = session.subscribe((ev: AgentSessionEvent) => {
    // Reset on each new assistant message so we only keep the latest response.
    // (Agent loop may emit multiple messages within one prompt: reasoning, tool calls, final answer.)
    if (ev.type === "message_start" && (ev.message as any)?.role === "assistant") {
      currentText = "";
    }
    if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
      currentText += ev.assistantMessageEvent.delta;
    }

    // Track + log every tool call the reviewer makes
    if (ev.type === "tool_execution_start") {
      const name = ev.toolName;
      const args = ev.args as any;
      const call: ReviewToolCall = {
        name,
        args,
        timestamp: new Date().toISOString(),
      };
      toolCalls.push(call);
      const activity = formatActivity(name, args);
      log(`reviewer tool: ${activity}`);
      opts.onActivity?.(activity);
      // Emit structured tool call for display widget
      const targetPath = name === "read" ? (args?.path ?? null)
        : (name === "bash") ? (args?.command ?? null)
        : (args?.path ?? args?.pattern ?? null);
      opts.onToolCall?.(name, targetPath);
    }
    if (ev.type === "tool_execution_end") {
      opts.onActivity?.("analyzing…");
    }
  });

  // Helper: send a prompt to the existing session, wait for completion.
  // Respects the outer abort signal and has its own timeout.
  async function sendPrompt(text: string, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const onAbort = () => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        session.abort();
        reject(new Error("Review cancelled"));
      };

      if (opts.signal.aborted) {
        onAbort();
        return;
      }

      opts.signal.addEventListener("abort", onAbort, { once: true });

      timeoutId = setTimeout(() => {
        if (settled) return;
        log(`reviewer: timed out after ${timeoutMs / 1000}s`);
        settled = true;
        session.abort();
        reject(new Error("Review timed out"));
      }, timeoutMs);

      session.prompt(text).then(
        () => {
          settled = true;
          clearTimeout(timeoutId);
          opts.signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (err) => {
          settled = true;
          clearTimeout(timeoutId);
          opts.signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }

  const MAIN_TIMEOUT_MS = opts.timeoutMs ?? 120 * 1000;
  const RETRY_TIMEOUT_MS = 20 * 1000;
  const MAX_VERDICT_RETRIES = 2;

  let verdict: "lgtm" | "issues" | null = null;
  try {
    log(`reviewer: session.prompt() starting`);
    try {
      await sendPrompt(prompt, MAIN_TIMEOUT_MS);
      log(`reviewer: session.prompt() resolved`);
    } catch (err) {
      // Preserve any partial text we streamed before the failure so the
      // structured log still captures it. Re-throw so caller sees the error.
      reviewText = currentText;
      throw err;
    }

    // Snapshot the main review (the final assistant message of the main prompt's agent loop).
    // Retry prompts will overwrite currentText but reviewText stays fixed on the real findings.
    reviewText = currentText;

    // Verdict lives in either the main response or a retry response
    verdict = parseVerdict(currentText);
    let retries = 0;
    while (!verdict && retries < MAX_VERDICT_RETRIES) {
      retries++;
      log(`reviewer: no verdict tag found, retry ${retries}/${MAX_VERDICT_RETRIES}`);
      opts.onActivity?.(`retry ${retries}: asking for verdict`);
      const followUp =
        `Your previous response did not include a verdict tag. ` +
        `Please respond with ONLY the final verdict on a single line:\n\n` +
        `<verdict>LGTM</verdict>\n\n` +
        `if no real bugs were found in your previous analysis, OR:\n\n` +
        `<verdict>ISSUES_FOUND</verdict>\n\n` +
        `if you found issues. Do not repeat the review, just output the verdict tag.`;
      try {
        await sendPrompt(followUp, RETRY_TIMEOUT_MS);
      } catch (err: any) {
        // Propagate cancellation — don't silently swallow user intent
        if (err?.message === "Review cancelled") throw err;
        // Other retry failures: keep reviewText (from main prompt) and fall back to default verdict
        log(`reviewer: retry ${retries} failed (${err?.message ?? err}), using current reviewText`);
        break;
      }
      verdict = parseVerdict(currentText);
    }

    if (!verdict) {
      // After all retries, default to ISSUES_FOUND (safer to show findings than swallow them)
      log(`reviewer: no verdict after ${MAX_VERDICT_RETRIES} retries, defaulting to ISSUES_FOUND`);
      verdict = "issues";
    }
  } finally {
    unsub();
    session.dispose();
  }

  const cleanedText = cleanReviewText(reviewText);
  const isLgtm = verdict === "lgtm";
  const durationMs = Date.now() - startTime;

  log(
    `reviewer: done in ${(durationMs / 1000).toFixed(1)}s | ` +
      `prompt=${(prompt.length / 1000).toFixed(1)}k | ` +
      `raw=${reviewText.length}c | ` +
      `cleaned=${cleanedText.length}c | ` +
      `tools=${toolCalls.length} | ` +
      `lgtm=${isLgtm}`,
  );
  log(`reviewer raw response:\n${reviewText}`);

  // Structured review record
  const reviewPath = logReview({
    timestamp: startedAt,
    durationMs,
    model: effectiveModel,
    thinkingLevel,
    isLgtm,
    promptLength: prompt.length,
    rawText: reviewText,
    cleanedText,
    filesReviewed: opts.filesReviewed ?? [],
    toolCalls,
  });
  if (reviewPath) log(`reviewer: wrote structured record ${reviewPath}`);

  return {
    text: cleanedText,
    rawText: reviewText,
    isLgtm,
    durationMs,
    toolCalls,
    model: effectiveModel,
    thinkingLevel,
  };
}

/**
 * Format file paths as a compact tree.
 */
function formatFileTree(files: string[]): string {
  if (files.length === 0) return "";
  const sorted = [...files].sort();
  return sorted.map((f) => `  ${f}`).join("\n");
}

/**
 * Send the appropriate review result message (LGTM or issues found).
 */
export function sendReviewResult(
  pi: ExtensionAPI,
  result: ReviewResult,
  label: string,
  opts?: { showLoopCount?: string; reviewedFiles?: string[] },
): void {
  // If no files were reviewed and it's LGTM, silently skip — nothing to report.
  // Always show issues even with zero files (tool-call-only reviews can find bugs).
  if (result.isLgtm && opts?.reviewedFiles && opts.reviewedFiles.length === 0) {
    log(`reviewer: skipping LGTM message — zero reviewed files`);
    return;
  }

  const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
  if (result.isLgtm) {
    log(`reviewer: LGTM (${duration}, tools=${result.toolCalls.length})`);
    const fileList =
      opts?.reviewedFiles && opts.reviewedFiles.length > 0
        ? `\n\n**Reviewed files:**\n\`\`\`\n${formatFileTree(opts.reviewedFiles)}\n\`\`\``
        : "";
    pi.sendMessage(
      {
        customType: "code-review",
        content: `✅ **Automated Code Review**${label ? ` (${label})` : ""} — ${duration}\n\nReview found no issues. Looks good!${fileList}\n\nIf you were waiting to push until after reviews were done — all reviews are done, no issues found. Safe to push.`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  } else {
    log(`reviewer: issues found (${duration}, tools=${result.toolCalls.length})`);
    const loopInfo = opts?.showLoopCount ? ` (${opts.showLoopCount})` : "";
    const fileList =
      opts?.reviewedFiles && opts.reviewedFiles.length > 0
        ? `\n\n**Reviewed files:**\n\`\`\`\n${formatFileTree(opts.reviewedFiles)}\n\`\`\``
        : "";
    pi.sendMessage(
      {
        customType: "code-review",
        content: `🔍 **Automated Code Review**${loopInfo || (label ? ` (${label})` : "")} — ${duration}\n\nA separate reviewer examined your recent changes and found potential issues:\n\n${result.text}${fileList}\n\nPlease review these findings. If any are valid, fix them. If they're false positives, briefly explain why and move on.\n\n⚠️ **Do NOT push to remote yet.** Fix any issues first. Do NOT push after fixing either — a new review cycle will check your fixes automatically.`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }
}
