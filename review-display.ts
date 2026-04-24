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
}

export interface ReviewDisplayHandle {
  update(patch: Partial<ReviewDisplayState>): void;
  stop(): void;
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

  fileLines.push(
    theme.fg("accent", theme.bold(`${spinner} Reviewing…`)) +
      theme.fg("dim", ` [${state.loopCount}/${state.maxLoops}]`) +
      theme.fg("dim", ` ${modelShort}`) +
      theme.fg("dim", ` ${elapsed}s`),
  );
  fileLines.push("");

  if (state.files.length > 0) {
    fileLines.push(theme.fg("muted", "Files:"));
    for (const f of state.files) {
      const shortPath = f.split("/").slice(-3).join("/");
      if (f === state.activeFile) {
        fileLines.push(
          `  ${theme.fg("accent", "▸")} ${theme.fg("accent", shortPath)} ${theme.fg("warning", "← reviewing")}`,
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
  const state = { ...initialState };

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
      Object.assign(state, patch);
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
