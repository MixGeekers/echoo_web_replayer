import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type {
  StoredEvent,
  EventPreview,
  SessionCapture,
  TimelineQuery,
  TimelinePage,
  DetailOptions,
  DetailPreview,
  ReplayQuery,
  ChunkQuery,
  ReplaySeekResult,
  ReplayChunkResult,
} from "../../shared/contracts/storage";
import { storedEvent } from "./values";
import {
  categoryFilter,
  ROW_BYTES,
  MAX_FULL_DETAIL,
  MAX_REPLAY_EVENT,
  readExactly,
  decodeRow,
  rows,
  sequenceBound,
  summary,
  includesRaw,
  writeAll,
} from "./index";
import type { ReadRow } from "./index";
interface SearchCache {
  path: string;
  count: number;
  scanned: number;
}
interface ReadHost {
  capture(id: string): Promise<SessionCapture>;
  getSessionDirectory(id: string): string;
  _paths(id: string): {
    directory: string;
    timeline: string;
    index: string;
    summaries: string;
  };
}
export class TimelineReader {
  private searches = new Map<string, SearchCache>();
  private searchQueue: Promise<unknown> = Promise.resolve();
  constructor(private host: ReadHost) {}
  async invalidate(id: string) {
    await this.searchQueue;
    for (const [key, cache] of this.searches) {
      if ((JSON.parse(key) as unknown[])[0] !== id) continue;
      await fs.rm(cache.path, { force: true });
      this.searches.delete(key);
    }
  }
  private capture(id: string) {
    return this.host.capture(id);
  }
  private getSessionDirectory(id: string) {
    return this.host.getSessionDirectory(id);
  }
  private _paths(id: string) {
    return this.host._paths(id);
  }
  async _typeMatches(
    row: ReadRow,
    prefixes: string[],
    cats: Set<number> | null | undefined,
    summaries: FileHandle,
  ) {
    if (!prefixes.length) return true;
    if (cats && row.category !== 0) return cats.has(row.category);
    const event = await summary(summaries, row);
    return prefixes.some(
      (prefix) => event.type === prefix || event.type.startsWith(`${prefix}.`),
    );
  }
  async _search<T>(
    capture: SessionCapture,
    prefixes: string[],
    search: string,
    indexHandle: FileHandle,
    summaries: FileHandle,
    operation: (cache: SearchCache, matches: FileHandle) => Promise<T>,
  ) {
    const run = this.searchQueue.then(async () => {
      const key = JSON.stringify([
        capture.metadata.id,
        capture.indexGeneration,
        prefixes,
        search,
      ]);
      let cache = this.searches.get(key);
      if (!cache) {
        while (this.searches.size >= 2) {
          const [oldKey, old] = this.searches.entries().next().value!;
          this.searches.delete(oldKey);
          await fs.rm(old.path, { force: true });
        }
        cache = {
          path: path.join(
            this.getSessionDirectory(capture.metadata.id),
            `.search-${randomUUID()}.idx`,
          ),
          count: 0,
          scanned: 0,
        };
        await fs.writeFile(cache.path, "");
        this.searches.set(key, cache);
      } else {
        this.searches.delete(key);
        this.searches.set(key, cache);
      }
      const source = await fs.open(capture.timelinePath, "r"),
        matches = await fs.open(cache.path, "a+");
      try {
        const cats = categoryFilter(prefixes);
        for await (const row of rows(
          indexHandle,
          cache.scanned,
          capture.indexCount,
        )) {
          if (
            (await this._typeMatches(row, prefixes, cats, summaries)) &&
            (await includesRaw(source, row, search))
          ) {
            const value = Buffer.alloc(8);
            value.writeDoubleLE(row.index);
            await writeAll(matches, value);
            cache.count++;
          }
          cache.scanned = row.index + 1;
        }
        return await operation(cache, matches);
      } finally {
        await source.close();
        await matches.close();
      }
    });
    this.searchQueue = run.catch(() => {});
    return run;
  }
  async timeline({
    sessionId,
    offset = 0,
    limit = 100,
    types = [],
    query = "",
    beforeSeq,
    afterSeq,
    snapshotSeq,
  }: TimelineQuery): Promise<TimelinePage> {
    const capture = await this.capture(sessionId),
      files = this._paths(sessionId);
    const prefixes = Array.isArray(types)
      ? [
          ...new Set(
            types.filter(
              (type) => typeof type === "string" && type.length < 200,
            ),
          ),
        ].sort()
      : [];
    const search = String(query || "").toLocaleLowerCase();
    if (search.length > 4096) throw new Error("搜索词过长");
    const skip = Math.max(0, Math.floor(Number(offset) || 0)),
      size = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    const upperSeq = Number.isSafeInteger(snapshotSeq)
      ? Math.min(snapshotSeq!, capture.metadata.lastSeq)
      : capture.metadata.lastSeq;
    const ascending = Number.isSafeInteger(afterSeq),
      cats = categoryFilter(prefixes);
    const indexHandle = await fs.open(files.index, "r"),
      summaries = await fs.open(files.summaries, "r");
    try {
      const count = await sequenceBound(
        indexHandle,
        capture.indexCount,
        upperSeq,
        true,
      );
      const lower = ascending
        ? await sequenceBound(indexHandle, count, afterSeq!, true)
        : 0;
      const upper = Number.isSafeInteger(beforeSeq)
        ? await sequenceBound(indexHandle, count, beforeSeq!, false)
        : count;
      const selected: EventPreview[] = [];
      let total = 0,
        skipped = 0,
        hasMore = false,
        scannedThroughSeq = ascending ? afterSeq! : null;
      const accept = async (row: ReadRow) => {
        if (skipped++ < skip) {
          scannedThroughSeq = row.seq;
          return true;
        }
        if (selected.length === size) {
          hasMore = true;
          return false;
        }
        selected.push(await summary(summaries, row));
        scannedThroughSeq = row.seq;
        return true;
      };
      if (search) {
        await this._search(
          capture,
          prefixes,
          search,
          indexHandle,
          summaries,
          async (cache, matches) => {
            const bound = async (rowIndex: number) => {
              let low = 0,
                high = cache.count;
              while (low < high) {
                const mid = low + Math.floor((high - low) / 2),
                  value = (await readExactly(matches, 8, mid * 8)).readDoubleLE(
                    0,
                  );
                if (value < rowIndex) low = mid + 1;
                else high = mid;
              }
              return low;
            };
            total = await bound(count);
            const start = await bound(lower),
              end = await bound(upper);
            for (
              let at = ascending ? start : end - 1;
              ascending ? at < end : at >= start;
              at += ascending ? 1 : -1
            ) {
              const rowIndex = (
                  await readExactly(matches, 8, at * 8)
                ).readDoubleLE(0),
                row = decodeRow(
                  await readExactly(
                    indexHandle,
                    ROW_BYTES,
                    rowIndex * ROW_BYTES,
                  ),
                  0,
                  rowIndex,
                );
              if (!(await accept(row))) break;
            }
          },
        );
      } else {
        if (!prefixes.length) total = count;
        else if (cats && count === capture.indexCount) {
          total = [...cats].reduce(
            (sum, key) => sum + (capture.categoryCounts[key] ?? 0),
            0,
          );
          if (capture.categoryCounts[0])
            for await (const row of rows(indexHandle, 0, count)) {
              if (
                row.category === 0 &&
                (await this._typeMatches(row, prefixes, cats, summaries))
              )
                total++;
            }
        } else
          for await (const row of rows(indexHandle, 0, count))
            if (await this._typeMatches(row, prefixes, cats, summaries))
              total++;
        for await (const row of rows(
          indexHandle,
          lower,
          upper,
          ascending ? 1 : -1,
        ))
          if (
            (await this._typeMatches(row, prefixes, cats, summaries)) &&
            !(await accept(row))
          )
            break;
      }
      if (ascending && !hasMore) scannedThroughSeq = upperSeq;
      return {
        events: selected,
        total,
        hasMore,
        firstSeq: selected[0]?.seq ?? null,
        lastSeq: selected.at(-1)?.seq ?? null,
        snapshotSeq: upperSeq,
        scannedThroughSeq,
      };
    } finally {
      await indexHandle.close();
      await summaries.close();
    }
  }
  async getEvent(
    sessionId: string,
    eventId: string,
    { preview = false, maxBytes = 100000 }: DetailOptions = {},
  ): Promise<StoredEvent | DetailPreview> {
    const capture = await this.capture(sessionId),
      files = this._paths(sessionId);
    const indexHandle = await fs.open(files.index, "r"),
      summaries = await fs.open(files.summaries, "r");
    let row: ReadRow | undefined, event: EventPreview | undefined;
    try {
      const prefix = `${sessionId}:`,
        sequence =
          typeof eventId === "string" && eventId.startsWith(prefix)
            ? Number(eventId.slice(prefix.length))
            : NaN;
      if (Number.isSafeInteger(sequence)) {
        const at = await sequenceBound(
          indexHandle,
          capture.indexCount,
          sequence,
          false,
        );
        if (at < capture.indexCount) {
          const candidate = decodeRow(
              await readExactly(indexHandle, ROW_BYTES, at * ROW_BYTES),
              0,
              at,
            ),
            value = await summary(summaries, candidate);
          if (value.id === eventId) {
            row = candidate;
            event = value;
          }
        }
      }
      if (!row && !Number.isSafeInteger(sequence))
        for await (const candidate of rows(
          indexHandle,
          0,
          capture.indexCount,
        )) {
          const value = await summary(summaries, candidate);
          if (value.id === eventId) {
            row = candidate;
            event = value;
            break;
          }
        }
      if (!row || !event) throw new Error("找不到指定事件");
    } finally {
      await indexHandle.close();
      await summaries.close();
    }
    if (!preview && row.length > MAX_FULL_DETAIL)
      throw new Error("该事件超过完整详情读取上限，请使用预览或导出原始数据");
    const length = preview
      ? Math.min(
          row.length,
          Math.max(
            1,
            Math.min(1024 * 1024, Math.floor(Number(maxBytes) || 100000)),
          ),
        )
      : row.length;
    const handle = await fs.open(files.timeline, "r");
    try {
      const value = await readExactly(handle, length, row.offset);
      if (!preview)
        return storedEvent(
          JSON.parse(value.toString("utf8")) as unknown,
          sessionId,
        );
      const decoder = new StringDecoder("utf8"),
        truncated = length < row.length;
      return {
        preview: decoder.write(value) + (truncated ? "" : decoder.end()),
        truncated,
        bytes: row.length,
        event,
      };
    } finally {
      await handle.close();
    }
  }
  async replaySeek({
    sessionId,
    timeMs,
    targetSeq,
    endSeq,
  }: ReplayQuery): Promise<ReplaySeekResult> {
    const capture = await this.capture(sessionId),
      files = this._paths(sessionId);
    const handle = await fs.open(files.index, "r");
    let summaries: FileHandle | undefined;
    try {
      summaries = await fs.open(files.summaries, "r");
      const upperSeq = Number.isSafeInteger(endSeq)
        ? Math.max(0, Math.min(endSeq!, capture.metadata.lastSeq))
        : capture.metadata.lastSeq;
      const count = await sequenceBound(
        handle,
        capture.indexCount,
        upperSeq,
        true,
      );
      const rowAt = async (index: number) =>
        decodeRow(
          await readExactly(handle, ROW_BYTES, index * ROW_BYTES),
          0,
          index,
        );
      const last = count ? await rowAt(count - 1) : null;
      let targetCount, position;
      if (Number.isSafeInteger(targetSeq)) {
        targetCount = await sequenceBound(
          handle,
          count,
          Math.max(0, targetSeq!),
          true,
        );
        position = targetCount ? (await rowAt(targetCount - 1)).elapsedMs : 0;
      } else if (timeMs === undefined) {
        let first;
        for await (const row of rows(handle, 0, count))
          if (row.category === 3) {
            const event = await summary(summaries, row);
            if (event.activePageId && event.pageId !== event.activePageId) continue;
            first = row;
            break;
          }
        if (!first) throw new Error("此会话没有可回放的 DOM 快照");
        targetCount = first.index + 1;
        position = first.elapsedMs;
      } else {
        position = Math.max(
          0,
          Math.min(Number(timeMs) || 0, last?.elapsedMs || 0),
        );
        let low = 0,
          high = count;
        while (low < high) {
          const mid = low + Math.floor((high - low) / 2);
          if ((await rowAt(mid)).elapsedMs <= position) low = mid + 1;
          else high = mid;
        }
        targetCount = low;
      }
      const target = targetCount ? await summary(summaries, await rowAt(targetCount - 1)) : null;
      // Selecting an event shows its source. Scrubbing time follows the foreground page.
      const pageId = Number.isSafeInteger(targetSeq) ? target?.pageId ?? target?.activePageId : target?.activePageId ?? target?.pageId;
      let baseline = null;
      for await (const row of rows(handle, 0, targetCount, -1))
        if (row.category === 3) {
          if (pageId && (await summary(summaries, row)).pageId !== pageId) continue;
          baseline = row;
          break;
        }
      let snapshot = null;
      if (baseline) {
        if (baseline.length > MAX_REPLAY_EVENT)
          throw new Error("此快照超过 64 MB 回放上限；原始数据仍可完整导出");
        const source = await fs.open(files.timeline, "r");
        try {
          snapshot = storedEvent(
            JSON.parse(
              (
                await readExactly(source, baseline.length, baseline.offset)
              ).toString("utf8"),
            ) as unknown,
            sessionId,
          );
        } finally {
          await source.close();
        }
      }
      return {
        session: capture.metadata,
        ...(pageId ? { pageId } : {}),
        snapshot,
        afterSeq: baseline?.seq || 0,
        targetSeq: targetCount ? (await rowAt(targetCount - 1)).seq : 0,
        endSeq: last?.seq || 0,
        durationMs: last?.elapsedMs || 0,
        timeMs: position,
      };
    } finally {
      await summaries?.close();
      await handle.close();
    }
  }
  async replayChunk({
    sessionId,
    afterSeq = 0,
    endSeq,
    limit = 200,
    maxBytes = 2 * 1024 * 1024,
  }: ChunkQuery): Promise<ReplayChunkResult> {
    if (
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      !Number.isSafeInteger(endSeq) ||
      endSeq < 0
    )
      throw new Error("无效的回放范围");
    const capture = await this.capture(sessionId),
      files = this._paths(sessionId);
    const index = await fs.open(files.index, "r"),
      source = await fs.open(files.timeline, "r");
    try {
      const end = await sequenceBound(
        index,
        capture.indexCount,
        Math.min(endSeq!, capture.metadata.lastSeq),
        true,
      );
      const start = await sequenceBound(index, end, afterSeq, true);
      const size = Math.max(1, Math.min(200, Math.floor(Number(limit) || 200)));
      const budget = Math.max(
        1024,
        Math.min(2 * 1024 * 1024, Number(maxBytes) || 0),
      );
      const events: StoredEvent[] = [];
      let bytes = 0,
        cursor = start;
      for await (const row of rows(index, start, end)) {
        if (
          events.length >= size ||
          (events.length && bytes + row.length > budget)
        )
          break;
        if (row.length > MAX_REPLAY_EVENT)
          throw new Error(
            `事件 #${row.seq} 超过 64 MB 回放上限；请导出原始数据`,
          );
        events.push(
          storedEvent(
            JSON.parse(
              (await readExactly(source, row.length, row.offset)).toString(
                "utf8",
              ),
            ) as unknown,
            sessionId,
          ),
        );
        bytes += row.length;
        cursor = row.index + 1;
      }
      return {
        events,
        afterSeq: events.at(-1)?.seq ?? afterSeq,
        hasMore: cursor < end,
      };
    } finally {
      await index.close();
      await source.close();
    }
  }
}
