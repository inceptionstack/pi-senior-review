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
 */

import {
  type ExtensionAPI,
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  createReadOnlyTools,
  createBashTool,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";

export interface ReviewResult {
  text: string;
  isLgtm: boolean;
  durationMs: number;
}

export interface ReviewOptions {
  signal: AbortSignal;
  cwd: string;
  /** "provider/model-id" to use for the reviewer */
  model?: string;
  /** Called when the reviewer uses tools — for status bar updates */
  onActivity?: (description: string) => void;
}

/**
 * Spawn a fresh pi reviewer instance with tools, send a prompt,
 * collect the response. The reviewer can read files and explore
 * the codebase as needed.
 */
export async function runReviewSession(prompt: string, opts: ReviewOptions): Promise<ReviewResult> {
  const startTime = Date.now();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    // Read-only tools + bash for full exploration capability
    tools: [...createReadOnlyTools(opts.cwd), createBashTool(opts.cwd)],
  });

  // Set the reviewer model if specified
  if (opts.model) {
    const [provider, modelId] = opts.model.split("/", 2);
    if (provider && modelId) {
      const model = modelRegistry.find(provider, modelId);
      if (model) {
        const success = await session.setModel(model);
        if (success) {
          console.log(`[auto-review] Using reviewer model: ${opts.model}`);
        } else {
          console.log(`[auto-review] ⚠️ Model ${opts.model} found but no API key. Using default.`);
          opts.onActivity?.("⚠️ model key missing, using default");
        }
      } else {
        console.log(`[auto-review] ⚠️ Model ${opts.model} not found. Using default.`);
        opts.onActivity?.("⚠️ model not found, using default");
      }
    }
  }

  let reviewText = "";
  const unsub = session.subscribe((ev: AgentSessionEvent) => {
    // Only capture text from assistant messages.
    // Reset on each new assistant message so we only keep the final one —
    // intermediate messages contain tool-call reasoning noise.
    if (ev.type === "message_start" && (ev.message as any)?.role === "assistant") {
      reviewText = "";
    }
    if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
      reviewText += ev.assistantMessageEvent.delta;
    }

    // Report tool activity for status bar
    if (opts.onActivity) {
      if (ev.type === "tool_execution_start") {
        const name = ev.toolName;
        const args = ev.args as any;
        if (name === "read") {
          opts.onActivity(`reading ${args?.path ?? "file"}`);
        } else if (name === "bash") {
          opts.onActivity(`$ ${(args?.command ?? "").slice(0, 50)}`);
        } else if (name === "find" || name === "grep" || name === "ls") {
          opts.onActivity(`${name} ${(args?.path ?? args?.pattern ?? "").slice(0, 40)}`);
        } else {
          opts.onActivity(`${name}…`);
        }
      }
      if (ev.type === "tool_execution_end") {
        opts.onActivity("analyzing…");
      }
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        session.abort();
        reject(new Error("Review cancelled"));
      };

      if (opts.signal.aborted) {
        onAbort();
        return;
      }

      opts.signal.addEventListener("abort", onAbort, { once: true });

      session.prompt(prompt).then(
        () => {
          settled = true;
          opts.signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (err) => {
          settled = true;
          opts.signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  } finally {
    unsub();
    session.dispose();
  }

  const isLgtm = !reviewText.trim() || reviewText.includes("LGTM");
  const durationMs = Date.now() - startTime;
  console.log(
    `[auto-review] Review completed in ${(durationMs / 1000).toFixed(1)}s | ` +
      `prompt: ${(prompt.length / 1000).toFixed(1)}k chars | ` +
      `response: ${reviewText.length} chars | ` +
      `lgtm: ${isLgtm}`,
  );
  return { text: reviewText, isLgtm, durationMs };
}

/**
 * Send the appropriate review result message (LGTM or issues found).
 */
/**
 * Format file paths as a compact tree.
 */
function formatFileTree(files: string[]): string {
  if (files.length === 0) return "";
  const sorted = [...files].sort();
  return sorted.map((f) => `  ${f}`).join("\n");
}

export function sendReviewResult(
  pi: ExtensionAPI,
  result: ReviewResult,
  label: string,
  opts?: { showLoopCount?: string; reviewedFiles?: string[] },
): void {
  const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
  if (result.isLgtm) {
    console.log(`[auto-review] Reviewer says: LGTM (${duration})`);
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
    console.log(`[auto-review] Reviewer found issues (${duration}), feeding back...`);
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
