/**
 * review-display.ts — Visual review progress widget
 *
 * Shows an animated ASCII art senior dev with a live file list
 * above the editor while a review is in progress.
 *
 * All mutable state (animation frames, timer) is per-instance inside
 * startReviewDisplay's closure — no module-level singletons.
 */

// ── ASCII art frames ─────────────────────────────────
// A senior dev peering at code through reading glasses.
// Two frames for a subtle animation (alternating the eyes/glasses).

const SENIOR_FRAMES = [
  [
    `    ┌─────────┐ `,
    `    │  ◉   ◉  │ `,
    `    │ ═══════ │ `,
    `    │    ▽    │ `,
    `    │  ╰───╯  │ `,
    `    └────┬────┘ `,
    `    ╭────┴────╮ `,
    `   ╱│ SENIOR  │╲`,
    `  ╱ │ REVIEW  │ ╲`,
    `    ╰─────────╯ `,
  ],
  [
    `    ┌─────────┐ `,
    `    │  ◎   ◎  │ `,
    `    │ ═══════ │ `,
    `    │    ▽    │ `,
    `    │  ╰───╯  │ `,
    `    └────┬────┘ `,
    `    ╭────┴────╮ `,
    `   ╱│ SENIOR  │╲`,
    `  ╱ │ REVIEW  │ ╲`,
    `    ╰─────────╯ `,
  ],
];

const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

// ── Types ────────────────────────────────────────────

export interface ReviewDisplayState {
  files: string[];
  activeFile: string | null;
  activity: string;
  loopCount: number;
  maxLoops: number;
  model: string;
  startTime: number;
  /** Tool usage count per file (keyed by file path from files[]) */
  toolCounts: Map<string, number>;
  /** Total tool calls across all files */
  totalToolCalls: number;
}

export interface ReviewDisplayHandle {
  update(patch: Partial<ReviewDisplayState>): void;
  /** Record a tool call, associating it with the best-matching file. */
  recordToolCall(toolName: string, targetPath: string | null): void;
  stop(): void;
}

// ── Helpers ──────────────────────────────────────────

/**
 * Find the best matching file in the file list for a given path.
 * Matches by suffix (e.g. "/foo/bar/index.ts" matches "index.ts" in the list).
 * Returns the matched file path or null.
 */
function findMatchingFile(files: string[], path: string): string | null {
  if (!path) return null;
  // Exact match first
  const exact = files.find((f) => f === path);
  if (exact) return exact;
  // Suffix match: path ends with the file, or file ends with path
  for (const f of files) {
    if (f.endsWith(path) || path.endsWith(f)) return f;
  }
  return null;
}

// ── Rendering ────────────────────────────────────────

/**
 * Build the widget lines for the review progress display.
 * Pure function — receives animation frame indices from caller.
 */
export function buildReviewWidget(
  state: ReviewDisplayState,
  animFrame: number,
  spinnerFrame: number,
  theme: {
    fg: (color: string, text: string) => string;
    bold: (text: string) => string;
  },
): string[] {
  const lines: string[] = [];
  const senior = SENIOR_FRAMES[animFrame % SENIOR_FRAMES.length];
  const spinner = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];

  // Top separator
  lines.push(theme.fg("dim", "─".repeat(60)));

  // Build file list (right side)
  const fileLines: string[] = [];
  const elapsed = ((Date.now() - state.startTime) / 1000).toFixed(0);
  const modelShort = (state.model || "").split("/").pop() ?? "";
  const toolInfo = state.totalToolCalls > 0
    ? theme.fg("dim", ` tools: ${state.totalToolCalls}`)
    : "";

  fileLines.push(
    theme.fg("accent", theme.bold(`${spinner} Reviewing…`)) +
      theme.fg("dim", ` [${state.loopCount}/${state.maxLoops}]`) +
      theme.fg("dim", ` ${modelShort}`) +
      theme.fg("dim", ` ${elapsed}s`) +
      toolInfo,
  );
  fileLines.push("");

  if (state.files.length > 0) {
    fileLines.push(theme.fg("muted", "Files:"));
    for (const f of state.files) {
      const shortPath = f.split("/").slice(-3).join("/");
      const count = state.toolCounts.get(f) ?? 0;
      const toolTag = count > 0 ? theme.fg("dim", ` [${count} tool${count > 1 ? "s" : ""}]`) : "";

      if (f === state.activeFile) {
        fileLines.push(
          `  ${theme.fg("accent", "▸")} ${theme.fg("warning", shortPath)}${toolTag} ${theme.fg("warning", "← reviewing")}`,
        );
      } else if (count > 0) {
        fileLines.push(
          `  ${theme.fg("success", "✓")} ${theme.fg("muted", shortPath)}${toolTag}`,
        );
      } else {
        fileLines.push(`  ${theme.fg("dim", "·")} ${theme.fg("muted", shortPath)}`);
      }
    }
  }

  if (state.activity) {
    fileLines.push("");
    fileLines.push(theme.fg("dim", `  ${state.activity}`));
  }

  // Merge ASCII art (left) with file list (right)
  const maxRows = Math.max(senior.length, fileLines.length);
  for (let i = 0; i < maxRows; i++) {
    const artPart = i < senior.length ? theme.fg("accent", senior[i]) : " ".repeat(18);
    const infoPart = i < fileLines.length ? fileLines[i] : "";
    lines.push(`${artPart}  ${infoPart}`);
  }

  // Bottom separator
  lines.push(theme.fg("dim", "─".repeat(60)));

  return lines;
}

// ── Widget lifecycle ─────────────────────────────────

/**
 * Start the review display widget.
 * Returns a handle to update state and stop the widget.
 * All animation state is per-instance (closure-scoped).
 */
export function startReviewDisplay(
  ui: {
    setWidget: (id: string, content: any, opts?: any) => void;
    theme: {
      fg: (color: string, text: string) => string;
      bold: (text: string) => string;
    };
  },
  initialState: ReviewDisplayState,
): ReviewDisplayHandle {
  const state: ReviewDisplayState = {
    ...initialState,
    toolCounts: new Map(initialState.toolCounts),
  };

  // Per-instance animation state
  let animFrame = 0;
  let spinnerFrame = 0;
  let tickCount = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  function redraw() {
    const lines = buildReviewWidget(state, animFrame, spinnerFrame, ui.theme);
    ui.setWidget("senior-review-progress", lines, { placement: "belowEditor" });
  }

  // Animate: tick every 150ms for spinner, toggle senior art every ~600ms
  timer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    tickCount++;
    if (tickCount % 4 === 0) {
      animFrame = (animFrame + 1) % SENIOR_FRAMES.length;
    }
    redraw();
  }, 150);

  redraw();

  return {
    update(patch: Partial<ReviewDisplayState>) {
      if (patch.toolCounts) {
        state.toolCounts = new Map(patch.toolCounts);
        delete (patch as any).toolCounts;
      }
      Object.assign(state, patch);
      redraw();
    },
    recordToolCall(toolName: string, targetPath: string | null) {
      state.totalToolCalls++;

      // Try to associate this tool call with a file
      const match = targetPath ? findMatchingFile(state.files, targetPath) : null;
      if (match) {
        state.toolCounts.set(match, (state.toolCounts.get(match) ?? 0) + 1);
        state.activeFile = match;
      }

      // Set activity based on tool type
      if (toolName === "read" && targetPath) {
        const short = targetPath.split("/").slice(-3).join("/");
        state.activity = `reading ${short}`;
      } else if (toolName === "bash") {
        state.activity = `$ ${(targetPath ?? "").slice(0, 50)}`;
      } else if (toolName === "grep" || toolName === "find" || toolName === "ls") {
        state.activity = `${toolName} ${(targetPath ?? "").slice(0, 40)}`;
      } else {
        state.activity = `${toolName}…`;
      }

      redraw();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      ui.setWidget("senior-review-progress", undefined);
    },
  };
}
