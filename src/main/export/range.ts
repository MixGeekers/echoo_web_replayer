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
  // Keep a position and prefix counts per page, never the DOM itself. If a requested
  // slice visits several pages, it needs the preceding baseline of each of them.
  type Anchor = { row: Row; before: ReturnType<typeof zero> };
  const baselines = new Map<string, Anchor>(), visited = new Set<string>(), totals = zero();
  let head: Anchor | undefined,
    tail: Row | null = null,
    requestedStart: number | null = null;
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
    const key = event.pageId ?? "";
    let anchor = baselines.get(key);
    if (!anchor || row.type === "dom.snapshot") {
      anchor = { row, before: { ...totals } };
      baselines.set(key, anchor);
    }
    if (inRange) {
      requestedStart ??= row.seq;
      if (!visited.has(key)) {
        visited.add(key);
        if (!head || anchor.row.seq < head.row.seq) head = anchor;
      }
      tail = row;
    }
    add(totals, row.type);
  }
  if (requestedStart === null || !head || !tail)
    throw new Error("导出范围内没有已保存的事件");
  return {
    requestedStartSeq: requestedStart,
    requestedEndSeq: tail.seq,
    startSeq: head.row.seq,
    endSeq: tail.seq,
    baselineSnapshotSeq: head.row.type === "dom.snapshot" ? head.row.seq : null,
    startByte: head.row.offset,
    endByte: tail.offset + tail.length,
    startElapsedMs: head.row.elapsedMs,
    endElapsedMs: tail.elapsedMs,
    sourceEventCount,
    sourceLastSeq,
    sourceTimelineBytes: byteLength,
    eventCount: totals.eventCount - head.before.eventCount,
    actionCount: totals.actionCount - head.before.actionCount,
    mutationCount: totals.mutationCount - head.before.mutationCount,
    snapshotCount: totals.snapshotCount - head.before.snapshotCount,
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
