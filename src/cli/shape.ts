// Unified-diff → shape / color / length view. No model, no cache.
// Counts use analyzeDiff hunk lines so +++ / --- file headers are not add/delete.

import { at, arrayAt, decodeUTF8 } from "../meat/bytes.ts";
import { analyzeDiff, splitSourceLines } from "../meat/diff.ts";
import { ansiReset, colorizeDiffLine, type DiffPalette } from "./render.ts";

export type ShapeSlot = "add" | "delete" | "context";

export interface DiffShape {
  readonly adds: number;
  readonly deletes: number;
  readonly context: number;
  readonly slots: readonly ShapeSlot[];
}

/** Columns of add/remove/context marks per `shape   ` row (8-char prefix + 72 = 80). */
export const SHAPE_WRAP = 72;

const PLUS_BYTE = 0x2b;
const MINUS_BYTE = 0x2d;

/**
 * Spatial add/remove/context pattern and explicit counts for a unified diff.
 * Only `hunk_context` / `hunk_change` lines contribute; headers stay out of the shape.
 */
export function observeDiffShape(diff: Uint8Array): DiffShape {
  const lines = splitSourceLines(diff);
  const layout = analyzeDiff(lines);
  const slots: ShapeSlot[] = [];
  let adds = 0;
  let deletes = 0;
  let context = 0;

  for (let i = 0; i < lines.length; i++) {
    const kind = arrayAt(layout.kinds, i);
    if (kind === "hunk_context") {
      slots.push("context");
      context++;
      continue;
    }
    if (kind !== "hunk_change") continue;
    const text = arrayAt(lines, i).text;
    if (text.length === 0) continue;
    const first = at(text, 0);
    if (first === PLUS_BYTE) {
      slots.push("add");
      adds++;
    } else if (first === MINUS_BYTE) {
      slots.push("delete");
      deletes++;
    }
  }

  return { adds, deletes, context, slots };
}

function markFor(slot: ShapeSlot): string {
  if (slot === "add") return "+";
  if (slot === "delete") return "-";
  return ".";
}

function wrapMarks(marks: string, width: number): string[] {
  if (marks.length === 0) return [""];
  const rows: string[] = [];
  for (let i = 0; i < marks.length; i += width) {
    rows.push(marks.slice(i, i + width));
  }
  return rows;
}

/** Color add vs delete runs when the palette has slots; colorless `+`/`-`/`.` otherwise. */
export function colorizeShapeMarks(marks: string, p: DiffPalette): string {
  if (p.new === "" && p.old === "") return marks;
  let out = "";
  let i = 0;
  while (i < marks.length) {
    const ch = marks.charAt(i);
    let j = i + 1;
    while (j < marks.length && marks.charAt(j) === ch) j++;
    const run = marks.slice(i, j);
    const color = ch === "+" ? p.new : ch === "-" ? p.old : "";
    out += color !== "" ? color + run + ansiReset : run;
    i = j;
  }
  return out;
}

/**
 * Terminal view of one unified diff: explicit length, compact shape, then the
 * input's own unified-diff text (colorized with the same palette).
 */
export function formatDiffLook(diff: Uint8Array, p: DiffPalette): string {
  const shape = observeDiffShape(diff);
  const marks = shape.slots.map(markFor).join("");
  const lines: string[] = [`length  +${shape.adds} -${shape.deletes} ~${shape.context}`];
  for (const row of wrapMarks(marks, SHAPE_WRAP)) {
    lines.push(`shape   ${colorizeShapeMarks(row, p)}`);
  }
  lines.push("");
  for (const line of splitSourceLines(diff)) {
    lines.push(colorizeDiffLine(decodeUTF8(line.text), p));
  }
  return lines.join("\n") + "\n";
}
