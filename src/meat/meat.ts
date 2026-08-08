// meat.ts is the package's one entry point (meat/meat.go): `Abridge` drives
// a bounded loop of model round-trips (a "run"), dispatching tool calls,
// until the model submits a plan or the run's turn/time budget is
// exhausted. A run is either the whole diff or one chunk of a split diff.
//
// Also delivers `abridgeChunked` (moved here from chunk.ts, item 4k, when
// that item discovered it needs `abridgeOne`/`Model`/`Request`/`Result`/
// `RunOptions`, none of which exist before this item — `chunk.ts` itself
// gained `mapMovesToChunk`/`chunkError`/`firstLineText`/`pieceContainsLine`/
// `stripReplicatedMeta`, since those five are pure and have zero dependency
// on this file; see chunk.ts's own note on that split).
//
// H1: byte-based emptiness/oversize checks throughout (never `.length`/
// `.trim()` on a decoded string). H5: two independently observable abort
// signals — the caller's own, untouched `AbortSignal`, and a derived,
// budget-bound one composed via `AbortSignal.any` — are what let this file
// distinguish "our own per-run deadline expired" from "the caller cancelled
// us" (G11/G12). H6: `AbortSignal.timeout()`/`.any()` stand in for Go's
// `context.WithTimeout` composition.

import { trimSpace, encodeUTF8, decodeUTF8, concat, hasSuffix, arrayAt } from "./bytes.ts";
import { numberedDiff, validateSupportedDiff } from "./diff.ts";
import {
  maxTotalDiffBytes,
  fitsSingleRun,
  splitDiffForAbridging,
  mapMovesToChunk,
  chunkError,
  firstLineText,
  pieceContainsLine,
  stripReplicatedMeta,
  type DiffChunk,
} from "./chunk.ts";
import { type DetectedMove, detectedMovesInDiff, formatMovePairs, maxMoveHints } from "./moves.ts";
import { newToolbox, tools as toolboxTools, run as runTool, retentionPressure, clearSubmission } from "./tools.ts";
import { systemPrompt } from "./rubric.ts";
import { RoleUser, RoleAssistant, textBlock, type Model, type Message, type Block, type ToolUseBlock, type Response } from "./model.ts";

/** Go's `defaultMaxTurns` (`meat/meat.go:36`). */
export const defaultMaxTurns = 24;
/** Go's `defaultBudget` (`meat/meat.go:40`), in milliseconds. */
export const defaultBudgetMs = 4 * 60 * 1000;
/** Go's `maxDiffBytes` (`meat/meat.go:51`). */
export const maxDiffBytes = 400 << 10;

/**
 * H17 (`migration/HAZARDS.md`): Go's `var abridgeBudget`/`var
 * singleRunDiffBytes` (`meat/meat.go:44,55`) exist purely so same-package
 * tests can shrink them for the duration of one test — an ES module export
 * binding can't be reassigned from an importing module. Mutable fields on
 * one exported `const` object, not `export let`, matching `gateway.ts`'s
 * existing precedent (`gatewayConfig`).
 */
export const meatConfig = {
  abridgeBudgetMs: defaultBudgetMs,
  singleRunDiffBytes: maxDiffBytes,
};

/** Go's `Request` (`meat/meat.go:57-76`): a whole-diff abridgement request. `unifiedDiff` is bytes (H1), matching every diff-consuming engine function already ported. */
export interface Request {
  /** The directory the read-only tools are confined to. Empty (or absent) disables `read_file`/`grep`. */
  readonly repoRoot?: string;
  /** The raw unified diff to abridge. Required. */
  readonly unifiedDiff: Uint8Array;
  /** Overrides `defaultMaxTurns` when `> 0`. */
  readonly maxTurns?: number;
  /** Receives short human-readable status updates as the run proceeds. Must not block. */
  readonly progress?: (msg: string) => void;
}

/**
 * Go's `runOptions` (`meat/meat.go:78-90`): chunk-internal state kept out of
 * `Request` so embedders' object literals stay stable across the chunking
 * feature (G15's spirit — TS has no positional-struct-literal analogue, but
 * the same "chunk bookkeeping never grows the public `Request` shape"
 * property holds here by construction, verified in `meat.test.ts`). Exported
 * for `rubric.ts`'s `promptSurface()`, which renders `buildUserPrompt` over
 * a zero-value `RunOptions` (matching Go's `runOptions{}` struct literal).
 */
export interface RunOptions {
  readonly chunkRun?: boolean;
  readonly chunkMoves?: readonly DetectedMove[];
}

/** Go's `Result` (`meat/meat.go:92-105`). `smartDiff` is bytes (H1), matching `Toolbox.smartDiff`/`CompiledPlan.smartDiff` it's derived from. */
export interface Result {
  readonly smartDiff: Uint8Array;
  readonly summary: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Go's `noToolCallNudge` (`meat/meat.go:109`). */
export const noToolCallNudge =
  "Call preview_plan or submit with a complete remove/replace/fold plan against the numbered ORIGINAL diff. Prefer removals and fixed multiline folds; use replace only for a local single-line elision. If nothing meaningful changed, remove every original line.";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function signalReasonMessage(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Go's `context.WithTimeout(ctx, abridgeBudget)` (`meat/meat.go:145`), with
 * its paired `defer cancel()`. Deliberately NOT `AbortSignal.timeout()`:
 * that helper's internal timer is documented as unref'd (won't keep the
 * process alive) — correct for a "don't block process exit" fire-and-forget
 * timeout, but wrong here, where this timer can legitimately be the only
 * pending work (e.g. a fake/hung `Model` in a test with no real I/O), and
 * an unref'd timer racing an otherwise-idle event loop can fire *after* its
 * own awaiter has already been torn down. A plain, ref'd `setTimeout` plus
 * an explicit `cancel()` (called unconditionally via `finally` at every
 * `abridgeOne` return path, mirroring `defer cancel()`) avoids both the
 * race and the resource leak.
 */
function timeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`meat: run budget of ${ms}ms exceeded`)), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

/**
 * Go's `Abridge` (`meat/meat.go:115-132`): the package's one entry point.
 * Fixed gate order — every rejection precedes any model call (G1-G3).
 * Throws on failure, mirroring this codebase's throw-on-failure convention;
 * `model: null` is accepted (not just disallowed by the type) so the G1
 * runtime check has something real to guard for JS callers.
 */
export async function Abridge(signal: AbortSignal, model: Model | null, req: Request): Promise<Result> {
  if (model === null) {
    throw new Error("meat: nil model");
  }
  if (trimSpace(req.unifiedDiff).length === 0) {
    return { smartDiff: new Uint8Array(0), summary: "No changes.", inputTokens: 0, outputTokens: 0 };
  }
  if (req.unifiedDiff.length > maxTotalDiffBytes) {
    throw new Error(
      `meat: diff is ${req.unifiedDiff.length >> 20}MB, over the ${maxTotalDiffBytes >> 20}MB limit — try a narrower range (a single commit, or per-file with \`git diff -- <path> | meat\`)`,
    );
  }
  try {
    validateSupportedDiff(req.unifiedDiff);
  } catch (err) {
    throw new Error(`meat: ${errorMessage(err)}`, { cause: err });
  }
  if (!fitsSingleRun(req.unifiedDiff, meatConfig.singleRunDiffBytes)) {
    return abridgeChunked(signal, model, req);
  }
  return abridgeOne(signal, model, req, {});
}

/**
 * Go's `abridgeOne` (`meat/meat.go:134-236`): runs the agent loop on one
 * single-run-sized diff. `callerSignal` is captured and checked directly
 * (never derived from) at exactly the two sites that must distinguish
 * "caller cancelled" from "our own budget expired" (H5) — the model-call
 * error branch and the post-loop exhaustion branch.
 */
async function abridgeOne(callerSignal: AbortSignal, model: Model, req: Request, opts: RunOptions): Promise<Result> {
  const maxTurns = req.maxTurns !== undefined && req.maxTurns > 0 ? req.maxTurns : defaultMaxTurns;

  // H6: the run's own wall-clock budget, composed with (not replacing) the
  // caller's signal — either firing aborts the derived signal, matching
  // Go's context.WithTimeout(ctx, abridgeBudget). `cancel()` is guaranteed
  // via `finally` below, mirroring Go's `defer cancel()`.
  const { signal: budgetSignal, cancel: cancelBudget } = timeoutSignal(meatConfig.abridgeBudgetMs);
  const runSignal = AbortSignal.any([callerSignal, budgetSignal]);
  try {
    return await runTurnLoop(callerSignal, runSignal, model, req, opts, maxTurns);
  } finally {
    cancelBudget();
  }
}

async function runTurnLoop(
  callerSignal: AbortSignal,
  runSignal: AbortSignal,
  model: Model,
  req: Request,
  opts: RunOptions,
  maxTurns: number,
): Promise<Result> {
  const numbered = numberedDiff(req.unifiedDiff);

  const tb = newToolbox({
    root: req.repoRoot ?? "",
    rawDiff: req.unifiedDiff,
    noMoves: opts.chunkRun ?? false,
    ...(opts.chunkMoves !== undefined ? { moves: opts.chunkMoves } : {}),
  });
  const toolList = toolboxTools(tb);

  let messages: Message[] = [{ role: RoleUser, content: [textBlock(decodeUTF8(buildUserPrompt(req, opts, numbered)))] }];

  const progress = req.progress ?? ((): void => {});

  let inTok = 0;
  let outTok = 0;
  let retentionNudged = false;
  let fallback: Result | null = null;

  for (let turn = 0; turn < maxTurns; turn++) {
    progress(`thinking (turn ${turn + 1})`);
    let resp: Response;
    try {
      resp = await model.generate(runSignal, systemPrompt, messages, toolList);
    } catch (err) {
      if (fallback !== null && !callerSignal.aborted) {
        return { ...fallback, inputTokens: inTok, outputTokens: outTok };
      }
      throw new Error(`meat: model generate: ${errorMessage(err)}`, { cause: err });
    }
    inTok += resp.inputTokens;
    outTok += resp.outputTokens;

    messages = [...messages, { role: RoleAssistant, content: resp.content }];

    const results: Block[] = [];
    for (const b of resp.content) {
      if (b.type !== "tool_use") continue;
      progress(describeToolCall(b));
      const [out, isErr] = await runTool(tb, runSignal, b.toolName, b.toolInput);
      results.push({ type: "tool_result", toolUseId: b.id, toolResult: out, toolError: isErr });
    }

    if (tb.submitSeen) {
      const submitted = tb.submitted;
      if (submitted === null) {
        throw new Error("unreachable: submitSeen without submitted");
      }
      const candidate: Result = { smartDiff: tb.smartDiff, summary: submitted.summary, inputTokens: inTok, outputTokens: outTok };
      // H15: `tb.submittedPlan !== null` is always true whenever reached in
      // practice (submitSeen/submittedPlan are always set and cleared
      // together by tools.ts), but the guard stays explicit rather than
      // assumed unreachable.
      const submittedPlan = tb.submittedPlan;
      const canRefine = !retentionNudged && turn + 1 < maxTurns && submittedPlan !== null && retentionPressure(submittedPlan.stats);
      if (canRefine) {
        fallback = candidate;
        retentionNudged = true;
        clearSubmission(tb);
        messages = [...messages, { role: RoleUser, content: results }];
        continue;
      }
      return candidate;
    }

    if (results.length === 0) {
      // The model produced text but no tool call. Nudge it once toward
      // submitting; the loop bound prevents this from running away.
      messages = [...messages, { role: RoleUser, content: [textBlock(noToolCallNudge)] }];
      continue;
    }
    messages = [...messages, { role: RoleUser, content: results }];
  }

  if (fallback !== null) {
    if (callerSignal.aborted) {
      throw new Error(`meat: caller context: ${signalReasonMessage(callerSignal)}`, { cause: callerSignal.reason });
    }
    return { ...fallback, inputTokens: inTok, outputTokens: outTok };
  }
  throw new Error(`meat: agent did not submit within ${maxTurns} turns`);
}

// The static model-visible user-prompt fragments (`meat/meat.go:241-248`).
// Every string the model can see that is not derived from the input diff
// lives in a named const so the deferred `promptSurface()` can hash the
// complete frozen surface.
export const userPromptIntro =
  "Abridge the following unified diff into a reading diff by submitting a complete remove/replace/fold plan against the numbered original lines. Meat applies your plan to the original diff; you do not write the resulting diff yourself. Coordinates are 1-based and always refer to the original numbering. The `N|` gutter is display-only and is not part of a line's source text. Use preview_plan to inspect sizeable drafts before submit.\n";
export const userPromptImports =
  "Imports/includes/requires/use declarations are removed automatically, including multiline blocks and recognized imports inside embedded source strings. They may appear in the numbered input but never in a preview or result. Do not spend edit coordinates on them, never fold across them into behavioral rows, and do not mention them in the summary.\n";
export const userPromptMoves =
  "Meat detected exact source-evidenced moves across hunks/files: %s. Give both sides of each pair identical keep/remove/fold/replace treatment, including matching fold boundaries and equivalent local elisions; automatically removed rows need none. Asymmetric plans are rejected.\n";
export const userPromptTools =
  "Use read_file/grep on the surrounding source only when it changes your judgment about what is load-bearing (or whether a file is generated), then preview or submit.\n";
export const userPromptNoTools = "Judge from the diff text alone, then preview or submit.\n";
export const userPromptProtocol =
  "Prefer removing whole lines or ranges. Use fold to replace two or more contiguous same-polarity hunk lines with one machine-generated, indentation-preserving `...` row. Use replace only to elide part of one source line; `new` must match all of `old` with every omitted span visibly represented by `...` or `…`. Keep useful per-file and hunk structure unless the entire file or hunk is noise.\n\n```diff\n";

/**
 * Go's `buildUserPrompt` (`meat/meat.go:250-270`): only the very first user
 * message is built this way; nothing later in the loop re-derives it.
 * Returns bytes (H1) — `numbered` may contain arbitrary diff content.
 */
export function buildUserPrompt(req: Request, opts: RunOptions, numbered: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [encodeUTF8(userPromptIntro), encodeUTF8(userPromptImports)];
  const moves = opts.chunkRun ? (opts.chunkMoves ?? []) : detectedMovesInDiff(req.unifiedDiff);
  if (moves.length > 0) {
    parts.push(encodeUTF8(userPromptMoves.replace("%s", formatMovePairs(moves, maxMoveHints))));
  }
  parts.push(encodeUTF8(req.repoRoot !== undefined && req.repoRoot !== "" ? userPromptTools : userPromptNoTools));
  parts.push(encodeUTF8(userPromptProtocol));
  parts.push(numbered);
  parts.push(encodeUTF8("```\n"));
  return concat(parts);
}

/**
 * Go's `describeToolCall` (`meat/meat.go:274-295`): a pure, side-effect-free
 * rendering of one `tool_use` block into a short progress string,
 * independent of and prior to actual tool dispatch. A malformed
 * `toolInput` silently yields an empty path/pattern here (errors ignored,
 * matching Go's unchecked `json.Unmarshal`) — the actual dispatch performs
 * its own, error-checked decode independently.
 */
function describeToolCall(b: ToolUseBlock): string {
  switch (b.toolName) {
    case "read_file": {
      let path = "";
      try {
        const parsed: unknown = JSON.parse(decodeUTF8(b.toolInput));
        if (typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>)["path"] === "string") {
          path = (parsed as Record<string, unknown>)["path"] as string;
        }
      } catch {
        // Silently ignored, matching Go's unchecked json.Unmarshal.
      }
      return decodeUTF8(trimSpace(encodeUTF8(`read_file ${path}`)));
    }
    case "grep": {
      let pattern = "";
      try {
        const parsed: unknown = JSON.parse(decodeUTF8(b.toolInput));
        if (typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>)["pattern"] === "string") {
          pattern = (parsed as Record<string, unknown>)["pattern"] as string;
        }
      } catch {
        // Silently ignored, matching Go.
      }
      return decodeUTF8(trimSpace(encodeUTF8(`grep ${JSON.stringify(pattern)}`)));
    }
    case "preview_plan":
      return "previewing";
    case "submit":
      return "submitting";
    default:
      return b.toolName;
  }
}

/**
 * Go's `abridgeChunked` (`meat/chunk.go:915-1001`, moved here — see file
 * header comment). Splits an oversized diff, runs the normal agent loop on
 * each chunk, and merges the results: reading diffs are concatenated in
 * original order (dropping a continuation piece's replicated metadata once
 * its file has surfaced), summaries are deduplicated and joined, token
 * usage is summed. `callerSignal` — the same, un-derived signal this
 * function itself received — is passed through unchanged to every chunk's
 * own `abridgeOne` call; each chunk independently derives its own
 * budget-bound signal on top of it.
 */
async function abridgeChunked(callerSignal: AbortSignal, model: Model, req: Request): Promise<Result> {
  let chunks: DiffChunk[];
  try {
    chunks = splitDiffForAbridging(req.unifiedDiff, meatConfig.singleRunDiffBytes);
  } catch (err) {
    throw new Error(`meat: ${errorMessage(err)}`, { cause: err });
  }
  let modelChunks = 0;
  for (const c of chunks) if (!c.passthrough) modelChunks++;

  const wholeMoves = detectedMovesInDiff(req.unifiedDiff);
  const progress = req.progress ?? ((): void => {});
  if (modelChunks > 0) {
    progress(`large diff: abridging ${modelChunks} chunks`);
  }

  const parts: Uint8Array[] = [];
  const summaries: string[] = [];
  // Pieces join on line boundaries, but the final piece may keep a missing
  // final newline from the original (never appended after the last part).
  const appendPiece = (piece: Uint8Array): void => {
    if (parts.length > 0) {
      const last = arrayAt(parts, parts.length - 1);
      if (!hasSuffix(last, encodeUTF8("\n"))) {
        parts[parts.length - 1] = concat([last, encodeUTF8("\n")]);
      }
    }
    parts.push(piece);
  };
  const seenSummary = new Set<string>();
  const emittedMeta = new Set<number>();
  let inputTokens = 0;
  let outputTokens = 0;
  let run = 0;
  for (const chunk of chunks) {
    if (chunk.passthrough) {
      appendPiece(chunk.text);
      continue;
    }
    run++;
    const label = `chunk ${run}/${modelChunks}`;
    const sub: Request = { ...req, unifiedDiff: chunk.text, progress: (msg: string) => progress(`${label}: ${msg}`) };
    const chunkOpts: RunOptions = { chunkRun: true, chunkMoves: mapMovesToChunk(wholeMoves, chunk.origins) };
    let res: Result;
    try {
      res = await abridgeOne(callerSignal, model, sub, chunkOpts);
    } catch (err) {
      throw chunkError(label, err);
    }
    inputTokens += res.inputTokens;
    outputTokens += res.outputTokens;
    if (trimSpace(res.smartDiff).length > 0) {
      let piece = res.smartDiff;
      if (chunk.sectionId >= 0) {
        // Dedupe a split file's replicated metadata, but only once the file
        // header has actually surfaced in the output: a piece may legally
        // elide its whole file section while retaining non-file preamble,
        // and stripping the next piece's headers then would orphan its
        // hunks.
        if (emittedMeta.has(chunk.sectionId)) {
          piece = stripReplicatedMeta(piece, chunk.metaPrefix);
        } else if (pieceContainsLine(piece, firstLineText(chunk.metaPrefix))) {
          emittedMeta.add(chunk.sectionId);
        }
      }
      if (piece.length > 0) appendPiece(piece);
    }
    const summaryTrimmed = decodeUTF8(trimSpace(encodeUTF8(res.summary)));
    if (summaryTrimmed !== "" && !seenSummary.has(summaryTrimmed)) {
      seenSummary.add(summaryTrimmed);
      summaries.push(summaryTrimmed);
    }
  }
  if (modelChunks === 0) {
    // Every changed row was import scaffolding — nothing any edit plan
    // could retain. Passthrough envelope text is dropped along with the
    // change it framed.
    return { smartDiff: new Uint8Array(0), summary: "Only imports and unchanged context; nothing to read.", inputTokens: 0, outputTokens: 0 };
  }
  return { smartDiff: concat(parts), summary: summaries.join(" "), inputTokens, outputTokens };
}
