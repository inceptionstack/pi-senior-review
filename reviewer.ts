/**
 * reviewer.ts — Shared review session logic
 *
 * Extracts the duplicated reviewer session creation, abort handling,
 * and result message sending into reusable functions.
 */

import {
  type ExtensionAPI,
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";

export interface ReviewResult {
  text: string;
  isLgtm: boolean;
}

export interface ReviewOptions {
  signal: AbortSignal;
  cwd: string;
}

/**
 * Spawn a fresh pi reviewer instance, send a prompt, collect the response.
 * Handles abort via signal. Returns the review text and whether it's LGTM.
 */
export async function runReviewSession(prompt: string, opts: ReviewOptions): Promise<ReviewResult> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
  });

  let reviewText = "";
  const unsub = session.subscribe((ev) => {
    if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
      reviewText += ev.assistantMessageEvent.delta;
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
  return { text: reviewText, isLgtm };
}

/**
 * Send the appropriate review result message (LGTM or issues found).
 */
export function sendReviewResult(
  pi: ExtensionAPI,
  result: ReviewResult,
  label: string,
  opts?: { showLoopCount?: string },
): void {
  if (result.isLgtm) {
    console.log("[auto-review] Reviewer says: LGTM");
    pi.sendMessage(
      {
        customType: "code-review",
        content: `✅ **Automated Code Review**${label ? ` (${label})` : ""}\n\nReview found no issues. Looks good!`,
        display: true,
      },
      { triggerTurn: false, deliverAs: "followUp" },
    );
  } else {
    console.log("[auto-review] Reviewer found issues, feeding back...");
    const loopInfo = opts?.showLoopCount ? ` (${opts.showLoopCount})` : "";
    pi.sendMessage(
      {
        customType: "code-review",
        content: `🔍 **Automated Code Review**${loopInfo || (label ? ` (${label})` : "")}\n\nA separate reviewer examined your recent changes and found potential issues:\n\n${result.text}\n\nPlease review these findings. If any are valid, fix them. If they're false positives, briefly explain why and move on.\n\n⚠️ **Do NOT push to remote yet.** Fix any issues first. Do NOT push after fixing either — a new review cycle will check your fixes automatically.`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }
}
