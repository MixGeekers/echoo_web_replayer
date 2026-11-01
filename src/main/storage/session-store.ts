import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  EventInput,
  StoredEvent,
  SessionMetadata,
  SessionPatch,
  SessionCapture,
  TimelineQuery,
  ReplayQuery,
  ChunkQuery,
  DetailOptions,
} from "../../shared/contracts/storage";
import type { ResourceEntry } from "../../shared/contracts/resources";
import { scanTimeline } from "./parser";
import { errorOf, sessionMetadata } from "./values";
import { TimelineReader } from "./timeline-reader";
import {
  ID_PATTERN,
  STATUSES,
  ROW_BYTES,
  summarize,
  compactEvent,
  category,
  newIndex,
  encodeRow,
  decodeRow,
  readExactly,
  writeAll,
  hasFollowingLine,
} from "./index";
export class SessionStore {
  readonly rootDir: string;
  readonly sessions = new Map<string, SessionMetadata>();
  readonly indexes = new Map<string, ReturnType<typeof newIndex>>();
  queue: Promise<unknown> = Promise.resolve();
  private reader = new TimelineReader(this);
  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    this.queue = Promise.resolve();
  }
  _enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }
  _id(id: string) {
    if (typeof id !== "string" || !ID_PATTERN.test(id))
      throw new Error("无效的会话 ID");
    return id;
  }
  getSessionDirectory(id: string) {
    return path.join(this.rootDir, this._id(id));
  }
  _known(id: string) {
    this._id(id);
    const value = this.sessions.get(id);
    if (!value) throw new Error("找不到指定会话");
    return value;
  }
  _paths(id: string) {
    const directory = this.getSessionDirectory(id);
    return {
      directory,
      timeline: path.join(directory, "timeline.jsonl"),
      index: path.join(directory, "timeline.idx"),
      summaries: path.join(directory, "timeline.summaries.jsonl"),
    };
  }
  async _writeMetadata(metadata: SessionMetadata) {
    const filename = path.join(
        this.getSessionDirectory(metadata.id),
        "session.json",
      ),
      temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(
        temporary,
        `${JSON.stringify(metadata, null, 2)}\n`,
        "utf8",
      );
      await fs.rename(temporary, filename);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
  async _buildIndex(id: string, metadata: SessionMetadata) {
    const files = this._paths(id),
      suffix = `.${randomUUID()}.tmp`,
      indexPath = files.index + suffix,
      summariesPath = files.summaries + suffix;
    const index = newIndex();
    let recoveredTail = false,
      normalizedNewline = false;
    await fs.appendFile(files.timeline, "");
    const size = (await fs.stat(files.timeline)).size;
    let indexHandle: FileHandle | null = null,
      summaryHandle: FileHandle | null = null;
    try {
      indexHandle = await fs.open(indexPath, "w");
      summaryHandle = await fs.open(summariesPath, "w");
      try {
        for await (const record of scanTimeline(files.timeline, {
          byteLength: size,
        })) {
          const event = { ...record.event, summary: summarize(record.event) };
          if (!Number.isSafeInteger(event.seq) || event.seq <= index.lastSeq) {
            const error = errorOf(new Error("事件序号必须严格递增"));
            error.offset = record.offset;
            throw error;
          }
          const body = Buffer.from(`${JSON.stringify(event)}\n`);
          const row = {
            seq: event.seq,
            offset: record.offset,
            length: record.length,
            summaryOffset: index.summaryBytes,
            summaryLength: body.length,
            category: category(event.type),
            elapsedMs: event.elapsedMs || 0,
          };
          await writeAll(summaryHandle, body);
          await writeAll(indexHandle, encodeRow(row));
          index.count++;
          index.categories[row.category] =
            (index.categories[row.category] ?? 0) + 1;
          index.summaryBytes += body.length;
          index.lastSeq = event.seq;
          index.lastElapsedMs = Math.max(
            index.lastElapsedMs,
            event.elapsedMs || 0,
          );
        }
      } catch (caught) {
        const error = errorOf(caught);
        if (
          typeof error.offset !== "number" ||
          !Number.isSafeInteger(error.offset) ||
          error.offset < 0 ||
          (await hasFollowingLine(files.timeline, error.offset, size))
        )
          throw new Error(
            `会话 ${id} 的时间线损坏，原文件已保留：${error.message}`,
          );
        const backup = `timeline.recovery-${Date.now()}-${randomUUID().slice(0, 8)}.jsonl`;
        await fs.copyFile(files.timeline, path.join(files.directory, backup));
        await fs.truncate(files.timeline, error.offset);
        metadata.recoveryFile = backup;
        recoveredTail = true;
      }
      let currentSize = (await fs.stat(files.timeline)).size;
      if (currentSize) {
        const source = await fs.open(files.timeline, "r");
        let endsWithLF;
        try {
          endsWithLF =
            (await readExactly(source, 1, currentSize - 1))[0] === 10;
        } finally {
          await source.close();
        }
        if (!endsWithLF) {
          await fs.appendFile(files.timeline, "\n");
          normalizedNewline = true;
          currentSize++;
        }
      }
      index.bytes = currentSize;
      await indexHandle.close();
      indexHandle = null;
      await summaryHandle.close();
      summaryHandle = null;
      if (normalizedNewline && index.count) {
        const handle = await fs.open(indexPath, "r+");
        try {
          const row = decodeRow(
            await readExactly(handle, ROW_BYTES, (index.count - 1) * ROW_BYTES),
            0,
            index.count - 1,
          );
          if (row.offset + row.length === index.bytes - 1) {
            row.length++;
            await writeAll(handle, encodeRow(row), row.index * ROW_BYTES);
          }
        } finally {
          await handle.close();
        }
      }
      await fs.rename(summariesPath, files.summaries);
      await fs.rename(indexPath, files.index);
    } finally {
      await indexHandle?.close();
      await summaryHandle?.close();
      await fs.rm(indexPath, { force: true }).catch(() => {});
      await fs.rm(summariesPath, { force: true }).catch(() => {});
    }
    this.indexes.set(id, index);
    Object.assign(metadata, {
      eventCount: index.count,
      actionCount: index.categories[1],
      mutationCount: index.categories[2],
      snapshotCount: index.categories[3],
      lastSeq: index.lastSeq,
      lastElapsedMs: index.lastElapsedMs,
    });
    return recoveredTail;
  }
  async init() {
    await fs.mkdir(this.rootDir, { recursive: true });
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      const directory = this.getSessionDirectory(entry.name);
      let metadata;
      try {
        metadata = sessionMetadata(
          JSON.parse(
            await fs.readFile(path.join(directory, "session.json"), "utf8"),
          ) as unknown,
        );
      } catch (caught) {
        const error = errorOf(caught);
        if (error.code === "ENOENT") continue;
        throw new Error(
          `无法读取会话 ${entry.name} 的元数据：${error.message}`,
        );
      }
      if (metadata.id !== entry.name)
        throw new Error(`会话目录与 ID 不一致：${entry.name}`);
      for (const name of await fs.readdir(directory))
        if (/^\.search-[a-f0-9-]+\.idx$/.test(name))
          await fs.rm(path.join(directory, name), { force: true });
      const recoveredTail = await this._buildIndex(metadata.id, metadata);
      this.sessions.set(metadata.id, metadata);
      if (
        metadata.status === "recording" ||
        metadata.status === "paused" ||
        recoveredTail
      ) {
        metadata.status = "interrupted";
        metadata.endedAt = new Date().toISOString();
        await this._append(metadata.id, {
          type: "session.interrupted",
          timestamp: metadata.endedAt,
          payload: {
            reason: "上次程序退出时录制未正常结束，已恢复已写入事件。",
            recoveredTail,
            recoveryFile: metadata.recoveryFile || null,
          },
        });
      } else await this._writeMetadata(metadata);
    }
    return this;
  }
  list() {
    return [...this.sessions.values()]
      .map((value) => ({ ...value }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  getSession(id: string) {
    return { ...this._known(id) };
  }
  create(name: string, url = "") {
    return this._enqueue(async () => {
      const now = new Date().toISOString(),
        id = `session-${now.replace(/[^0-9]/g, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`;
      const metadata: SessionMetadata = {
        id,
        name: String(name || `录制 ${now}`)
          .trim()
          .slice(0, 200),
        status: "recording",
        startedAt: now,
        updatedAt: now,
        endedAt: null,
        url,
        eventCount: 0,
        actionCount: 0,
        mutationCount: 0,
        snapshotCount: 0,
        lastSeq: 0,
        lastElapsedMs: 0,
        schemaVersion: 1,
      };
      const files = this._paths(id);
      await fs.mkdir(files.directory, { recursive: false });
      await Promise.all([
        fs.writeFile(files.timeline, ""),
        fs.writeFile(files.index, ""),
        fs.writeFile(files.summaries, ""),
      ]);
      await this._writeMetadata(metadata);
      this.sessions.set(id, metadata);
      this.indexes.set(id, newIndex());
      return { ...metadata };
    });
  }
  append(id: string, event: EventInput) {
    return this._enqueue(() => this._append(id, event));
  }
  saveResource(id: string, entry: ResourceEntry, source?: string) {
    return this._enqueue(async () => {
      if (this._known(id).status !== "recording") return;
      const directory = this.getSessionDirectory(id);
      if (entry.sha256) {
        if (!/^[a-f0-9]{64}$/.test(entry.sha256))
          throw new Error("无效的资源校验值");
        await fs.mkdir(path.join(directory, "assets"), { recursive: true });
        if (!source) throw new Error("资源文件不存在");
        await fs.copyFile(source, path.join(directory, "assets", entry.sha256));
      }
      const event = await this._append(id, {
        type: "page.resource",
        timestamp: entry.capturedAt,
        payload: entry,
      });
      await fs.appendFile(
        path.join(directory, "resources.jsonl"),
        `${JSON.stringify({ ...entry, seq: event.seq, elapsedMs: event.elapsedMs })}\n`,
      );
    });
  }
  async _ensureIndex(id: string) {
    if (!this.indexes.has(id) || this.indexes.get(id)?.dirty) {
      const metadata = this._known(id);
      await this._buildIndex(id, metadata);
      await this._writeMetadata(metadata);
    }
    return this.indexes.get(id)!;
  }
  async _append(sessionId: string, input: EventInput): Promise<StoredEvent> {
    await this._ensureIndex(sessionId);
    const metadata = this._known(sessionId),
      index = this.indexes.get(sessionId)!,
      files = this._paths(sessionId);
    if (!input || typeof input.type !== "string" || !input.type)
      throw new Error("事件类型不能为空");
    const receivedAt = new Date().toISOString(),
      timestamp = Number.isFinite(Date.parse(input.timestamp ?? ""))
        ? new Date(input.timestamp!).toISOString()
        : receivedAt,
      seq = metadata.lastSeq + 1;
    const event: StoredEvent = {
      ...input,
      summary: input.summary || "",
      id: `${sessionId}:${String(seq).padStart(8, "0")}`,
      sessionId,
      seq,
      type: input.type,
      timestamp,
      receivedAt,
      elapsedMs: Math.max(
        metadata.lastElapsedMs || 0,
        Date.parse(receivedAt) - Date.parse(metadata.startedAt),
        0,
      ),
      url: input.url || metadata.url || "",
      title: input.title || "",
      documentId: input.documentId || null,
      payload: input.payload ?? {},
    };
    event.summary = summarize(event);
    const raw = Buffer.from(`${JSON.stringify(event)}\n`),
      body = Buffer.from(`${JSON.stringify(compactEvent(event))}\n`);
    const row = {
      seq,
      offset: index.bytes,
      length: raw.length,
      summaryOffset: index.summaryBytes,
      summaryLength: body.length,
      category: category(event.type),
      elapsedMs: event.elapsedMs,
    };
    await fs.appendFile(files.timeline, raw);
    const updated = {
      ...metadata,
      lastSeq: seq,
      lastElapsedMs: event.elapsedMs,
      eventCount: metadata.eventCount + 1,
      actionCount: metadata.actionCount + Number(row.category === 1),
      mutationCount: metadata.mutationCount + Number(row.category === 2),
      snapshotCount: metadata.snapshotCount + Number(row.category === 3),
      updatedAt: receivedAt,
      url: event.url || metadata.url,
    };
    this.sessions.set(sessionId, updated);
    try {
      await fs.appendFile(files.summaries, body);
      await fs.appendFile(files.index, encodeRow(row));
      index.count++;
      index.bytes += raw.length;
      index.summaryBytes += body.length;
      index.categories[row.category] =
        (index.categories[row.category] ?? 0) + 1;
      index.lastSeq = seq;
      index.lastElapsedMs = event.elapsedMs;
    } catch (error) {
      index.dirty = true;
      throw error;
    }
    await this._writeMetadata(updated);
    return event;
  }
  update(sessionId: string, patch: SessionPatch) {
    return this._enqueue(async () => {
      const current = this._known(sessionId);
      if (patch.status && !STATUSES.has(patch.status))
        throw new Error("无效的会话状态");
      const allowed = [
        "name",
        "status",
        "endedAt",
        "lastExportPath",
        "lastExportAt",
        "url",
      ] as const;
      const updated = {
        ...current,
        ...Object.fromEntries(
          allowed
            .filter((key) => Object.hasOwn(patch, key))
            .map((key) => [key, patch[key]]),
        ),
        updatedAt: new Date().toISOString(),
      };
      await this._writeMetadata(updated);
      this.sessions.set(sessionId, updated);
      return { ...updated };
    });
  }
  flush() {
    return this.queue;
  }
  capture(sessionId: string): Promise<SessionCapture> {
    return this._enqueue(async () => {
      const index = await this._ensureIndex(sessionId),
        files = this._paths(sessionId);
      if ((await fs.stat(files.timeline)).size !== index.bytes) {
        index.dirty = true;
        await this._ensureIndex(sessionId);
      }
      const current = this.indexes.get(sessionId)!;
      const resourcePath = path.join(files.directory, "resources.jsonl");
      const resourceBytes = await fs.stat(resourcePath).then(
        (value) => value.size,
        (error) => {
          if (error.code === "ENOENT") return 0;
          throw error;
        },
      );
      return {
        metadata: this.getSession(sessionId),
        timelinePath: files.timeline,
        byteLength: current.bytes,
        capturedAt: new Date().toISOString(),
        indexCount: current.count,
        indexGeneration: current.generation,
        categoryCounts: [...current.categories],
        resourcePath,
        resourceBytes,
      };
    });
  }
  timeline(query: TimelineQuery) {
    return this.reader.timeline(query);
  }
  getEvent(sessionId: string, eventId: string, options: DetailOptions = {}) {
    return this.reader.getEvent(sessionId, eventId, options);
  }
  replaySeek(query: ReplayQuery) {
    return this.reader.replaySeek(query);
  }
  replayChunk(query: ChunkQuery) {
    return this.reader.replayChunk(query);
  }
}
export { summarize, compactEvent } from "./index";
