import * as fs from "node:fs";
import { pipeline } from "node:stream/promises";
import type {
  ExportRange,
  ResolvedExportRange,
} from "../../shared/contracts/annotations";
import { scanTimeline } from "../storage/parser";
import { checkAbort } from "./delta-codec";

/**
 * Resolve a requested seq/time slice to a contiguous byte range of the original
 * timeline. The slice starts at the nearest dom.snapshot at or before the
 * requested start, so the exported events can be read and replayed from a baseline.
 */
export async function resolveRange({
  timelinePath,
  byteLength,
  range,
  sourceEventCount,
  sourceLastSeq,
  signal,
}: {
  timelinePath: string;
  byteLength: number;
  range: ExportRange;
  sourceEventCount: number;
  sourceLastSeq: number;
  signal?: AbortSignal | undefined;
}): Promise<ResolvedExportRange> {
  const bySeq = range.startSeq !== undefined || range.endSeq !== undefined;
  if (!bySeq && range.startMs === undefined && range.endMs === undefined)
    throw new Error("导出范围为空");
  interface Row { seq: number; offset: number; length: number; elapsedMs: number; type: string }
  const zero = () => ({ eventCount: 0, actionCount: 0, mutationCount: 0, snapshotCount: 0 });
  const add = (counts: ReturnType<typeof zero>, type: string) => {
    counts.eventCount++;
    counts.actionCount += Number(type.startsWith("action."));
    counts.mutationCount += Number(type === "dom.mutation");
    counts.snapshotCount += Number(type === "dom.snapshot");
  };
  // Streaming: before the start keep only the latest baseline row and the counts since it.
  let head: Row | null = null,
    tail: Row | null = null,
    requestedStart: number | null = null,
    counts = zero();
  for await (const { offset, length, event } of scanTimeline(timelinePath, { byteLength, signal })) {
    checkAbort(signal);
    const row: Row = { seq: event.seq, offset, length, elapsedMs: Number(event.elapsedMs) || 0, type: String(event.type || "") };
    if (!Number.isSafeInteger(row.seq)) throw new Error("时间线事件序号无效");
    const afterEnd = bySeq
      ? range.endSeq !== undefined && row.seq > range.endSeq
      : range.endMs !== undefined && row.elapsedMs > range.endMs;
    if (afterEnd) break;
    const inRange = bySeq
      ? range.startSeq === undefined || row.seq >= range.startSeq
      : range.startMs === undefined || row.elapsedMs >= range.startMs;
    if (requestedStart === null) {
      // A snapshot at or before the start becomes the new baseline.
      if (!head || row.type === "dom.snapshot") {
        head = row;
        counts = zero();
      }
      if (inRange) requestedStart = row.seq;
    }
    add(counts, row.type);
    if (requestedStart !== null) tail = row;
  }
  if (requestedStart === null || !head || !tail)
    throw new Error("导出范围内没有已保存的事件");
  return {
    requestedStartSeq: requestedStart,
    requestedEndSeq: tail.seq,
    startSeq: head.seq,
    endSeq: tail.seq,
    baselineSnapshotSeq: head.type === "dom.snapshot" ? head.seq : null,
    startByte: head.offset,
    endByte: tail.offset + tail.length,
    startElapsedMs: head.elapsedMs,
    endElapsedMs: tail.elapsedMs,
    sourceEventCount,
    sourceLastSeq,
    sourceTimelineBytes: byteLength,
    ...counts,
  };
}

/** Copy the resolved byte slice unchanged; every line stays byte-identical to the source. */
export async function copySlice(
  source: string,
  destination: string,
  range: Pick<ResolvedExportRange, "startByte" | "endByte">,
  signal?: AbortSignal,
) {
  if (range.endByte <= range.startByte) throw new Error("导出范围为空");
  await pipeline(
    fs.createReadStream(source, { start: range.startByte, end: range.endByte - 1 }),
    fs.createWriteStream(destination, { flags: "wx" }),
    { signal },
  );
}
