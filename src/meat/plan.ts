// plan.ts — the plan-compilation vocabulary shared by moves.ts, imports.ts,
// python.ts, and editplan.ts. Extracted from editplan.go's type-definition
// layer (meat/editplan.go:20-122); this file has no single corresponding Go
// source — editplan.go's own compileEditPlan orchestrator calls into
// moves.go/imports.go/python.go, while those three need editplan.go's
// planState/lineRange types. That is a genuine circular dependency at the
// Go-file level: Go's single-package compilation doesn't care about file
// order, but a TypeScript module graph does. This file breaks the cycle the
// same way bytes.ts already breaks one for the byte-slice layer — a
// deliberate, documented exception to migration/TARGET.md's "Go packages
// map one-to-one" layout rule. `editplan.ts` (built later) owns everything
// else editplan.go has: compileEditPlan/compileEditPlanMoves itself,
// prepareFold, validateSummary, the elision-projection compiler, and so on.

import { at, slice, concat } from "./bytes.ts";

/** Go's `lineRange` (`meat/editplan.go:25-30`): an inclusive, 1-based physical-line range. */
export interface LineRange {
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Go's `lineReplacement` (`meat/editplan.go:32-40`). `old`/`new` are matched
 * and spliced as bytes (H1) — never decoded to a JS string mid-pipeline.
 */
export interface LineReplacement {
  readonly line: number;
  readonly old: Uint8Array;
  readonly new: Uint8Array;
}

/** Go's `lineFold` (`meat/editplan.go:42-47`). */
export interface LineFold {
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Go's `plannedReplacement` (`meat/editplan.go:69-74`): a validated
 * `LineReplacement` plus its resolved byte span (within the line body, after
 * the diff marker) and originating plan index.
 */
export interface PlannedReplacement extends LineReplacement {
  readonly planIndex: number;
  readonly start: number;
  readonly end: number;
}

/**
 * Go's `plannedFold` (`meat/editplan.go:76-82`). `marker` uses Go's zero
 * byte (`0`) as an explicit "unset" sentinel (H15) — ported as `null` on an
 * explicit `'+' | '-' | ' ' | null` union, never a falsy check.
 */
export interface PlannedFold extends LineFold {
  readonly planIndex: number;
  readonly marker: "+" | "-" | " " | null;
  readonly indent: Uint8Array;
  readonly eol: Uint8Array;
}

/** Go's `planState` (`meat/editplan.go:84-89`). Mutated in place by `editplan.ts`'s orchestrator, exactly as Go's slices are. */
export interface PlanState {
  hidden: boolean[];
  folded: number[]; // fold index for every folded source line; -1 otherwise
  foldAt: number[]; // fold index emitted at its first source line; -1 otherwise
  folds: PlannedFold[];
}

/** Go's `newPlanState` (`meat/editplan.go:91-102`). */
export function newPlanState(lines: number): PlanState {
  return {
    hidden: new Array<boolean>(lines).fill(false),
    folded: new Array<number>(lines).fill(-1),
    foldAt: new Array<number>(lines).fill(-1),
    folds: [],
  };
}

/** Go's `planState.represented` (`meat/editplan.go:104-106`). */
export function planStateRepresented(state: PlanState, line: number): boolean {
  const hidden = state.hidden[line];
  const folded = state.folded[line];
  if (hidden === undefined || folded === undefined) {
    throw new RangeError(`index out of range [${line}] with length ${state.hidden.length}`);
  }
  return !hidden || folded >= 0;
}

/**
 * Go's `applyPlannedReplacements` (`meat/editplan.go:413-419`): splices
 * `edits` into `body` right-to-left so earlier offsets stay valid regardless
 * of length changes from later edits. `edits` must already be sorted
 * ascending by `.start` — this is the caller's responsibility (Go's own
 * caller sorts before calling, `meat/editplan.go:354`); this function does
 * not sort.
 */
export function applyPlannedReplacements(body: Uint8Array, edits: readonly PlannedReplacement[]): Uint8Array {
  let result = body;
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    if (edit === undefined) {
      throw new RangeError(`index out of range [${i}] with length ${edits.length}`);
    }
    result = concat([slice(result, 0, edit.start), edit.new, slice(result, edit.end, result.length)]);
  }
  return result;
}

/**
 * Go's `leadingWhitespace` (`meat/editplan.go:480-487`): the maximal leading
 * run of literal space/tab bytes — no width interpretation of its own (H16:
 * callers choose raw-byte-count vs. tab-expanded-column width on top of
 * this shared primitive; the two conventions are not interchangeable, see
 * `migration/HAZARDS.md` H16).
 */
export function leadingWhitespace(s: Uint8Array): Uint8Array {
  let i = 0;
  for (; i < s.length; i++) {
    const c = at(s, i);
    if (c !== 0x20 && c !== 0x09) break;
  }
  return slice(s, 0, i);
}

/** Go's `isIdentifierStart` (`meat/editplan.go:472-474`): ASCII letter or underscore. */
export function isIdentifierStart(b: number): boolean {
  return b === 0x5f || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
}

/** Go's `isIdentifierContinue` (`meat/editplan.go:476-478`): identifier-start byte or ASCII digit. */
export function isIdentifierContinue(b: number): boolean {
  return isIdentifierStart(b) || (b >= 0x30 && b <= 0x39);
}
