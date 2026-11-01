import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { compactEventBounded } from "./parser";
import { object, preview } from "./values";
import type { EventInput, EventPreview } from "../../shared/contracts/storage";
export interface IndexRow {
  index?: number;
  seq: number;
  offset: number;
  length: number;
  summaryOffset: number;
  summaryLength: number;
  category: number;
  elapsedMs: number;
}
export interface ReadRow extends IndexRow {
  index: number;
}
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
const STATUSES = new Set(["recording", "paused", "stopped", "interrupted"]);
const ROW_BYTES = 48,
  IO_BYTES = 65536,
  MAX_FULL_DETAIL = 8 * 1024 * 1024;
const MAX_REPLAY_EVENT = 64 * 1024 * 1024;
const trim = (value: unknown, length = 280) =>
  String(value ?? "").slice(0, length);

function summarize(event: EventInput | EventPreview) {
  const p = object(event.payload);
  if (event.summary) return trim(event.summary);
  if (event.type === "dom.snapshot")
    return `DOM 快照 · ${trim(p.reason || "checkpoint")}`;
  if (event.type === "dom.mutation")
    return `${(Array.isArray(p.mutations) ? p.mutations.length : undefined) ?? (Array.isArray(p.records) ? p.records.length : undefined) ?? p.count ?? 0} 项 DOM 变化`;
  if (event.type?.startsWith("action.")) {
    const target = object(p.target);
    return [
      event.type.slice(7),
      target.selector || p.selector || target.tagName || target.tag,
      target.text || target.textContent,
    ]
      .filter(Boolean)
      .map((value) => trim(value))
      .join(" · ")
      .slice(0, 280);
  }
  return [event.type, p.reason || p.url || p.message || ""]
    .filter(Boolean)
    .map((value) => trim(value))
    .join(" · ")
    .slice(0, 280);
}
function compactEvent(event: EventInput | EventPreview) {
  return { ...compactEventBounded(event), summary: summarize(event) };
}
function category(type: string) {
  if (type.startsWith("action.")) return 1;
  if (type === "dom.mutation") return 2;
  if (type === "dom.snapshot") return 3;
  if (type.startsWith("page.")) return 4;
  if (type.startsWith("session.")) return 5;
  if (type.startsWith("recorder.")) return 6;
  return 0;
}
function categoryFilter(prefixes: string[]) {
  if (!prefixes.length) return null;
  const known: Record<string, number[]> = {
    action: [1],
    "dom.mutation": [2],
    "dom.snapshot": [3],
    dom: [2, 3],
    page: [4],
    session: [5],
    recorder: [6],
  };
  if (prefixes.some((prefix) => !Object.hasOwn(known, prefix)))
    return undefined;
  return new Set(prefixes.flatMap((prefix) => known[prefix]!));
}
function newIndex() {
  return {
    generation: randomUUID(),
    count: 0,
    bytes: 0,
    summaryBytes: 0,
    categories: Array(7).fill(0),
    lastSeq: 0,
    lastElapsedMs: 0,
    dirty: false,
  };
}
function encodeRow(row: IndexRow) {
  const value = Buffer.alloc(ROW_BYTES);
  value.writeDoubleLE(row.seq, 0);
  value.writeDoubleLE(row.offset, 8);
  value.writeDoubleLE(row.length, 16);
  value.writeDoubleLE(row.summaryOffset, 24);
  value.writeUInt32LE(row.summaryLength, 32);
  value.writeUInt32LE(row.category, 36);
  value.writeDoubleLE(row.elapsedMs || 0, 40);
  return value;
}
function decodeRow(value: Buffer, at: number, index: number): ReadRow {
  return {
    index,
    seq: value.readDoubleLE(at),
    offset: value.readDoubleLE(at + 8),
    length: value.readDoubleLE(at + 16),
    summaryOffset: value.readDoubleLE(at + 24),
    summaryLength: value.readUInt32LE(at + 32),
    category: value.readUInt32LE(at + 36),
    elapsedMs: value.readDoubleLE(at + 40),
  };
}
async function readExactly(
  handle: FileHandle,
  length: number,
  position: number,
) {
  const value = Buffer.alloc(length);
  let at = 0;
  while (at < length) {
    const { bytesRead } = await handle.read(
      value,
      at,
      length - at,
      position + at,
    );
    if (!bytesRead) throw new Error("时间线或索引读取不完整");
    at += bytesRead;
  }
  return value;
}
async function writeAll(handle: FileHandle, value: Buffer, position?: number) {
  let offset = 0;
  while (offset < value.length) {
    const { bytesWritten } = await handle.write(
      value,
      offset,
      value.length - offset,
      position === undefined ? null : position + offset,
    );
    if (!bytesWritten) throw new Error("索引写入不完整");
    offset += bytesWritten;
  }
}
async function* rows(
  handle: FileHandle,
  start: number,
  end: number,
  direction = 1,
) {
  if (direction > 0) {
    for (let at = start; at < end; ) {
      const count = Math.min(256, end - at),
        buffer = await readExactly(handle, count * ROW_BYTES, at * ROW_BYTES);
      for (let n = 0; n < count; n++)
        yield decodeRow(buffer, n * ROW_BYTES, at + n);
      at += count;
    }
  } else {
    for (let at = end; at > start; ) {
      const count = Math.min(256, at - start),
        first = at - count,
        buffer = await readExactly(
          handle,
          count * ROW_BYTES,
          first * ROW_BYTES,
        );
      for (let n = count - 1; n >= 0; n--)
        yield decodeRow(buffer, n * ROW_BYTES, first + n);
      at = first;
    }
  }
}
async function sequenceBound(
  handle: FileHandle,
  count: number,
  seq: number,
  inclusive: boolean,
) {
  let low = 0,
    high = count;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2),
      value = (await readExactly(handle, 8, mid * ROW_BYTES)).readDoubleLE(0);
    if (value < seq || (inclusive && value === seq)) low = mid + 1;
    else high = mid;
  }
  return low;
}
async function summary(
  handle: FileHandle,
  row: IndexRow,
): Promise<EventPreview> {
  if (row.summaryLength > 128 * 1024) throw new Error("摘要索引损坏");
  return preview(
    JSON.parse(
      (
        await readExactly(handle, row.summaryLength, row.summaryOffset)
      ).toString("utf8"),
    ) as unknown,
  );
}
async function includesRaw(handle: FileHandle, row: IndexRow, search: string) {
  const decoder = new StringDecoder("utf8");
  let tail = "",
    at = 0;
  while (at < row.length) {
    const chunk = await readExactly(
      handle,
      Math.min(IO_BYTES, row.length - at),
      row.offset + at,
    );
    at += chunk.length;
    const text = tail + decoder.write(chunk).toLocaleLowerCase();
    if (text.includes(search)) return true;
    tail = search.length > 1 ? text.slice(-(search.length - 1)) : "";
  }
  return (tail + decoder.end().toLocaleLowerCase()).includes(search);
}
async function hasFollowingLine(filename: string, start: number, size: number) {
  const handle = await fs.open(filename, "r");
  let skippedBadLine = false;
  try {
    for (let at = start; at < size; ) {
      const chunk = await readExactly(
        handle,
        Math.min(IO_BYTES, size - at),
        at,
      );
      at += chunk.length;
      for (const byte of chunk) {
        if (!skippedBadLine) {
          if (byte === 10) skippedBadLine = true;
          continue;
        }
        if (![9, 10, 13, 32].includes(byte)) return true;
      }
    }
    return false;
  } finally {
    await handle.close();
  }
}

export {
  ID_PATTERN,
  STATUSES,
  ROW_BYTES,
  MAX_FULL_DETAIL,
  MAX_REPLAY_EVENT,
  summarize,
  compactEvent,
  category,
  categoryFilter,
  newIndex,
  encodeRow,
  decodeRow,
  readExactly,
  writeAll,
  rows,
  sequenceBound,
  summary,
  includesRaw,
  hasFollowingLine,
};
