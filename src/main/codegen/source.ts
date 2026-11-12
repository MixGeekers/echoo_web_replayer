import * as fs from "node:fs";
import type { CodegenEvent } from "./generator";

/** Legacy actions can need DOM evidence, but new recordings carry their own locators. */
const DOM_HISTORY = /^(?:dom\.(?:snapshot|mutation)|frame\.(?:snapshot|mutation|detach))$/;
const SKIPPED = /^(?:dom\.|page\.(?:resource|image|lifecycle|resize)$)/;
const HEAD_BYTES = 256;
const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024;

function aborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error("脚本生成已取消");
  error.name = "AbortError";
  throw error;
}
/** Persisted lines start with `{"type":"…"`; anything else is parsed to stay correct. */
export function leadingType(head: string): string | null {
  const match = /^\s*\{\s*"type"\s*:\s*"([^"\\]{1,200})"/.exec(head);
  return match ? match[1]! : null;
}

export interface CodegenReadStats {
  skippedLines: number;
  oversizedLines: number;
  invalidLines: number;
}

/**
 * Stream a timeline up to a captured byte boundary and yield only events that the
 * generator can use. Large DOM lines are skipped unless a legacy action needs them.
 */
export async function* readCodegenEvents(
  timelinePath: string,
  byteLength: number,
  {
    signal,
    maxLineBytes = DEFAULT_MAX_LINE_BYTES,
    stats,
    includeFrameHistory = false,
  }: { signal?: AbortSignal | undefined; maxLineBytes?: number; stats?: CodegenReadStats; includeFrameHistory?: boolean } = {},
): AsyncGenerator<CodegenEvent> {
  aborted(signal);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error("无效时间线读取范围");
  if (!byteLength) return;
  const counters = stats ?? { skippedLines: 0, oversizedLines: 0, invalidLines: 0 };
  const input = fs.createReadStream(timelinePath, { start: 0, end: byteLength - 1, highWaterMark: 1024 * 1024 });
  type Mode = "head" | "keep" | "skip";
  let mode: Mode = "head" as Mode;
  let gap = false;
  let parts: Buffer[] = [];
  let size = 0;
  let position = 0;
  const decide = () => {
    const type = leadingType(Buffer.concat(parts).toString("utf8"));
    if (type !== null && (DOM_HISTORY.test(type) ? !includeFrameHistory : SKIPPED.test(type))) {
      mode = "skip";
      parts = [];
      counters.skippedLines++;
    } else mode = "keep";
  };
  const finishLine = (): CodegenEvent | null => {
    if (mode === "head" && size) decide();
    let event: CodegenEvent | null = null;
    if (mode === "keep" && size) {
      const text = Buffer.concat(parts).toString("utf8");
      if (text.trim()) {
        try {
          const value: unknown = JSON.parse(text);
          if (value && typeof value === "object" && !Array.isArray(value)) event = value as CodegenEvent;
          else counters.invalidLines++;
        } catch {
          counters.invalidLines++;
        }
      }
    }
    if (includeFrameHistory && (gap || (!event && mode === "keep" && size))) event = {type: "frame.historyGap"};
    gap = false;
    mode = "head";
    parts = [];
    size = 0;
    return event;
  };
  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      aborted(signal);
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf(10, cursor);
        const end = newline < 0 ? chunk.length : newline;
        const piece = chunk.subarray(cursor, end);
        if (mode !== "skip" && piece.length) {
          parts.push(piece);
          size += piece.length;
          if (mode === "head" && size >= HEAD_BYTES) decide();
          if (mode === "keep" && size > maxLineBytes) {
            mode = "skip";
            parts = [];
            counters.oversizedLines++;
            gap = true;
          }
        } else if (mode === "skip") size += piece.length;
        position += end - cursor;
        cursor = end;
        if (newline >= 0) {
          cursor++;
          position++;
          const event = finishLine();
          if (event) yield event;
        }
      }
    }
    if (position !== byteLength) throw new Error("时间线读取不完整");
    const event = finishLine();
    if (event) yield event;
  } finally {
    input.destroy();
  }
}
