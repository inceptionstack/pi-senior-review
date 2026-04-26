// eval/run-eval.mjs — one-shot eval harness, run from pi-hard-no root via
//   node --experimental-strip-types --no-warnings eval/run-eval.mjs
// Writes JSONL to eval/results/ and prints a markdown summary.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { aggregate, renderSummary, CLASSES } from "./lib.mjs";

const MODELS = [
  "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "amazon-bedrock/amazon.nova-micro-v1:0",
  "amazon-bedrock/amazon.nova-lite-v1:0",
];
const REPEATS = 3;
const TIMEOUT_MS = 15000;
const PROMPT_VERSION = "v1";

const PROMPT = `You classify ONE bash command into exactly one of three classes for an automated code review system.

CLASSES:
- inspection_vcs_noop: reads/reports state only, no file/git/dep/process/network/env mutation
- modifying: may change files, git index/commits/branches/remotes, deps, artifacts, processes, services, permissions, caches, or env
- unsure: ambiguous, truncated, unknown executable/script, or not confidently classifiable

TAXONOMY (authoritative):
- ls, pwd, cat, head, tail, wc, rg, grep, find (no -delete/-exec), sed -n, test, echo, printf, true, false → inspection_vcs_noop (only if not redirecting output)
- git status/diff/log/show/rev-parse/branch --show-current → inspection_vcs_noop
- git add/commit/push/pull/merge/rebase/reset/checkout/switch/stash/clean/tag → modifying
- touch/cp/mv/rm/mkdir/rmdir/chmod/chown, redirections >, >>, tee, truncate → modifying
- npm/pnpm/yarn/pip/cargo install, make, cargo build, npm run format, codegen scripts → modifying
- kill/pkill/systemctl, docker run, docker compose up → modifying
- sed -i, perl -pi → modifying (in-place edit)
- ./script.sh or npm run <unknown> → unsure unless clearly read-only
- truncated command (e.g. "git commi") → unsure
- Compound commands with &&, ;, ||, pipes, subshells: ANY modifying part → modifying; ANY unknown/truncated → unsure; otherwise the class of the safest-subset.

OUTPUT: return ONLY this JSON, no prose, no markdown fences:
{"classification":"inspection_vcs_noop"|"modifying"|"unsure"}

Command to classify:
`;

function parseClassification(raw) {
  // strip ```json fences if present
  let s = raw.trim();
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) s = m[1].trim();
  try {
    const obj = JSON.parse(s);
    const c = obj?.classification;
    if (CLASSES.includes(c)) {
      return { classification: c, json_valid: true };
    }
    return { classification: "unsure", json_valid: false, reason: "bad_enum" };
  } catch {
    // regex fallback to extract classification from any text.
    // Builds the alternation from CLASSES so adding a class in one place
    // propagates to the parser automatically.
    const altern = CLASSES.join("|");
    const m2 = s.match(new RegExp(`\\b(${altern})\\b`));
    if (m2) return { classification: m2[1], json_valid: false, reason: "regex_fallback" };
    return { classification: "unsure", json_valid: false, reason: "unparseable" };
  }
}

async function callModel(modelId, command, authStorage, modelRegistry) {
  const [provider, id] = modelId.split("/", 2);
  const model = modelRegistry.find(provider, id);
  if (!model) throw new Error(`model not found: ${modelId}`);

  const { session } = await createAgentSession({
    cwd: process.cwd(),
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    tools: [],
  });

  // Holders so the cleanup path can clean regardless of where we fail.
  let unsub = () => {};
  let timer;
  let text = "";

  try {
    await session.setModel(model);
    session.setThinkingLevel("off");

    unsub = session.subscribe((ev) => {
      if (ev.type === "message_start" && ev.message?.role === "assistant") text = "";
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
        text += ev.assistantMessageEvent.delta;
      }
    });
    const start = Date.now();
    // Track the timer so we can clear it on success (prevents leaked timers +
    // unhandled rejections in some runtimes) and abort the session on timeout
    // so it stops streaming instead of mutating `text` after we've moved on.
    let timedOut = false;
    const timeoutPromise = new Promise((_, rej) => {
      timer = setTimeout(() => {
        timedOut = true;
        rej(new Error("timeout"));
      }, TIMEOUT_MS);
    });
    try {
      await Promise.race([session.prompt(PROMPT + command), timeoutPromise]);
    } finally {
      clearTimeout(timer);
      if (timedOut) {
        try {
          await session.abort();
        } catch {}
      }
    }
    const latency = Date.now() - start;
    // Freeze the response text BEFORE unsubscribing/parsing so any late-arriving
    // stream delta (subscribe callback still registered until outer finally)
    // can't mutate the value we classify. Defensive: the outer try/catch would
    // re-map a mid-parse mutation to `unsure` anyway, but this removes the race.
    const frozenText = text;
    const parsed = parseClassification(frozenText);
    return { raw: frozenText, latency, ...parsed };
  } finally {
    // Unsubscribe on every path (happy or error), then dispose the session.
    try {
      unsub();
    } catch {}
    try {
      session.dispose();
    } catch {}
  }
}

async function main(startTime) {
  const fixturesPath = new URL("./fixtures.json", import.meta.url).pathname;
  const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));
  const all = [
    ...fixtures.dev.map((f) => ({ ...f, split: "dev" })),
    ...fixtures.held_out.map((f) => ({ ...f, split: "held_out" })),
  ];

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  mkdirSync(new URL("./results", import.meta.url).pathname, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const results = [];
  const total = MODELS.length * all.length * REPEATS;
  let done = 0;

  console.log(
    `Running ${total} calls (${MODELS.length} models × ${all.length} fixtures × ${REPEATS} repeats)`,
  );

  for (const model of MODELS) {
    // Run fixtures for this model in sequence to keep rate-limit noise low.
    // Concurrency=3 would be nice but Bedrock is inconsistent; stick with serial.
    // NOTE: we still create a fresh session per call. Session pooling (one per
    // model, reused across fixtures) would cut ~30% of overhead but adds
    // complexity we haven't needed — 315 serial calls complete in ~4 minutes.
    // Revisit if the harness grows beyond smoke-test scale.
    for (const fx of all) {
      for (let r = 0; r < REPEATS; r++) {
        const row = {
          ts: new Date().toISOString(),
          model,
          prompt_version: PROMPT_VERSION,
          fixture_id: fx.id,
          split: fx.split,
          command: fx.command,
          expected: fx.expected,
          repeat: r,
        };
        try {
          const res = await callModel(model, fx.command, authStorage, modelRegistry);
          Object.assign(row, res, { ok: true });
        } catch (err) {
          Object.assign(row, {
            ok: false,
            error: String(err?.message ?? err),
            classification: "unsure",
            json_valid: false,
            latency: null,
          });
        }
        results.push(row);
        done++;
        if (done % 10 === 0 || done === total) {
          const elapsed = (Date.now() - startTime) / 1000;
          const rate = done / elapsed;
          const eta = (total - done) / rate;
          console.log(
            `  ${done}/${total}  (${((done * 100) / total).toFixed(0)}%)  elapsed=${elapsed.toFixed(0)}s  eta=${eta.toFixed(0)}s`,
          );
        }
      }
    }
  }

  const outPath = new URL(`./results/run-${ts}.jsonl`, import.meta.url).pathname;
  writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join("\n"));
  console.log(`\nWrote ${results.length} rows → ${outPath}`);
  return results;
}

// ── entry ────────────────────────────────────────────
// Declare startTime before main() is invoked so main() doesn't depend on a
// module-level const declared later. The previous layout relied on the fact
// that the const initializer at the bottom ran before main() was called,
// which is fragile if the file is reorganized.
const startTime = Date.now();
const results = await main(startTime);
renderSummary(aggregate(results));
console.log(`\nTotal wall clock: ${((Date.now() - startTime) / 1000).toFixed(0)}s`);
