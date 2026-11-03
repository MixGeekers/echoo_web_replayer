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
import { SESSION_GROUP_ID_PATTERN } from "./session-group-store";
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
interface AppendRequest {
  id: string;
  event: EventInput;
  resolve(event: StoredEvent): void;
  reject(error: unknown): void;
}
interface PreparedEvent {
  request: AppendRequest;
  event: StoredEvent;
  raw: Buffer;
  body: Buffer;
  category: number;
}
/** 录制期间 session.json 中的计数只用于展示；重启时由时间线重建，因此可以延迟合并写入。 */
const METADATA_DELAY_MS = 1000;
/** 单次合并写入的时间线字节上限，避免多个大快照拼接时占用过多内存。 */
const BATCH_BYTES = 4 * 1024 * 1024;
export class SessionStore {
  readonly rootDir: string;
  readonly sessions = new Map<string, SessionMetadata>();
  readonly indexes = new Map<string, ReturnType<typeof newIndex>>();
  queue: Promise<unknown> = Promise.resolve();
  private reader = new TimelineReader(this);
  private readers = new Map<string, number>();
  private libraryMutations = new Set<string>();
  /** 仍在队尾、尚未开始执行的追加批次；新事件可以并入其中，一次写入。 */
  private openBatch: AppendRequest[] | null = null;
  private metadataTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private metadataDirty = new Set<string>();
  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    this.queue = Promise.resolve();
  }
  _enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    // 其他操作排在批次之后时，后来的事件不能再并入之前的批次，否则会越过该操作。
    this.openBatch = null;
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
    // 调用方总是传入内存中最新的元数据，写入后不再需要延迟写。
    this._cancelMetadata(metadata.id);
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
      if (entry.isDirectory() && /^\.deleting-session-[a-zA-Z0-9-]+$/.test(entry.name)) {
        await fs.rm(path.join(this.rootDir, entry.name), { recursive: true, force: true });
        continue;
      }
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
        // 立即落盘 interrupted 状态，避免再次异常退出时重复标记。
        await this._writeMetadata(this._known(metadata.id));
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
  create(name: string, url: string, profile: { id: string; name: string }, sessionGroupId: string) {
    return this._enqueue(async () => {
      if (!profile || typeof profile.id !== "string" || !/^profile-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(profile.id) ||
          typeof profile.name !== "string" || !profile.name.trim())
        throw new Error("录制必须属于有效的 Profile");
      if (typeof sessionGroupId !== "string" || !SESSION_GROUP_ID_PATTERN.test(sessionGroupId))
        throw new Error("录制必须属于有效的 Session");
      const now = new Date().toISOString(),
        id = `session-${now.replace(/[^0-9]/g, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`;
      const metadata: SessionMetadata = {
        id,
        sessionGroupId,
        name: String(name || `录制 ${now}`)
          .trim()
          .slice(0, 200),
        status: "recording",
        profileId: profile.id,
        profileName: profile.name,
        libraryState: "active",
        archivedAt: null,
        trashedAt: null,
        trashOrigin: null,
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
        schemaVersion: 3,
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
  /**
   * 追加事件。排队期间到达的连续事件会合并为一批，每个文件只写一次；
   * 每个调用仍在其事件写入后单独完成，顺序与调用顺序一致。
   */
  append(id: string, event: EventInput): Promise<StoredEvent> {
    return new Promise<StoredEvent>((resolve, reject) => {
      const request = { id, event, resolve, reject };
      if (this.openBatch) {
        this.openBatch.push(request);
        return;
      }
      const batch: AppendRequest[] = [request];
      this._enqueue(async () => {
        if (this.openBatch === batch) this.openBatch = null;
        await this._appendBatch(batch);
      }).catch(() => {});
      this.openBatch = batch;
    });
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
  _append(sessionId: string, input: EventInput): Promise<StoredEvent> {
    return new Promise<StoredEvent>((resolve, reject) =>
      void this._appendRun([{ id: sessionId, event: input, resolve, reject }]),
    );
  }
  private async _appendBatch(batch: AppendRequest[]) {
    for (let start = 0; start < batch.length; ) {
      let end = start + 1;
      while (end < batch.length && batch[end]!.id === batch[start]!.id) end++;
      await this._appendRun(batch.slice(start, end));
      start = end;
    }
  }
  /** 写入同一记录的一组连续事件。每个请求都会被 resolve 或 reject，本方法不抛出。 */
  private async _appendRun(requests: AppendRequest[]) {
    const sessionId = requests[0]!.id;
    try {
      await this._ensureIndex(sessionId);
    } catch (error) {
      for (const request of requests) request.reject(error);
      return;
    }
    let chunk: PreparedEvent[] = [],
      chunkBytes = 0;
    for (let at = 0; at < requests.length; at++) {
      const request = requests[at]!;
      let prepared: PreparedEvent;
      try {
        prepared = this._prepare(sessionId, request, chunk);
      } catch (error) {
        request.reject(error);
        continue;
      }
      chunk.push(prepared);
      chunkBytes += prepared.raw.length;
      if (chunkBytes < BATCH_BYTES && at < requests.length - 1) continue;
      try {
        await this._commit(sessionId, chunk);
      } catch (error) {
        for (const item of chunk) item.request.reject(error);
        for (const rest of requests.slice(at + 1)) rest.reject(error);
        return;
      }
      chunk = [];
      chunkBytes = 0;
    }
    if (chunk.length) {
      try {
        await this._commit(sessionId, chunk);
      } catch (error) {
        for (const item of chunk) item.request.reject(error);
      }
    }
  }
  /** 基于已提交状态和本批中排在前面的事件，计算下一个事件。 */
  private _prepare(sessionId: string, request: AppendRequest, pending: PreparedEvent[]): PreparedEvent {
    const metadata = this._known(sessionId),
      input = request.event;
    if (!input || typeof input.type !== "string" || !input.type)
      throw new Error("事件类型不能为空");
    const previous = pending.at(-1)?.event;
    const lastSeq = previous?.seq ?? metadata.lastSeq,
      lastElapsedMs = previous?.elapsedMs ?? metadata.lastElapsedMs;
    const receivedAt = new Date().toISOString(),
      timestamp = Number.isFinite(Date.parse(input.timestamp ?? ""))
        ? new Date(input.timestamp!).toISOString()
        : receivedAt,
      seq = lastSeq + 1;
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
        lastElapsedMs || 0,
        Date.parse(receivedAt) - Date.parse(metadata.startedAt),
        0,
      ),
      url: input.url || previous?.url || metadata.url || "",
      title: input.title || "",
      documentId: input.documentId || null,
      payload: input.payload ?? {},
    };
    event.summary = summarize(event);
    return {
      request,
      event,
      raw: Buffer.from(`${JSON.stringify(event)}\n`),
      body: Buffer.from(`${JSON.stringify(compactEvent(event))}\n`),
      category: category(event.type),
    };
  }
  /** 三个文件各写一次；任一写入失败都标记索引待重建，以时间线文件为准恢复。 */
  private async _commit(sessionId: string, items: PreparedEvent[]) {
    const metadata = this._known(sessionId),
      index = this.indexes.get(sessionId)!,
      files = this._paths(sessionId);
    const rows: Buffer[] = [];
    let offset = index.bytes,
      summaryOffset = index.summaryBytes;
    const counts = [0, 0, 0, 0];
    for (const item of items) {
      rows.push(
        encodeRow({
          seq: item.event.seq,
          offset,
          length: item.raw.length,
          summaryOffset,
          summaryLength: item.body.length,
          category: item.category,
          elapsedMs: item.event.elapsedMs,
        }),
      );
      offset += item.raw.length;
      summaryOffset += item.body.length;
      if (item.category >= 1 && item.category <= 3) counts[item.category]!++;
    }
    const last = items.at(-1)!.event;
    try {
      await fs.appendFile(
        files.timeline,
        items.length === 1 ? items[0]!.raw : Buffer.concat(items.map((item) => item.raw)),
      );
    } catch (error) {
      index.dirty = true;
      throw error;
    }
    this.sessions.set(sessionId, {
      ...metadata,
      lastSeq: last.seq,
      lastElapsedMs: last.elapsedMs,
      eventCount: metadata.eventCount + items.length,
      actionCount: metadata.actionCount + counts[1]!,
      mutationCount: metadata.mutationCount + counts[2]!,
      snapshotCount: metadata.snapshotCount + counts[3]!,
      updatedAt: last.receivedAt,
      url: last.url || metadata.url,
    });
    try {
      await fs.appendFile(files.summaries, Buffer.concat(items.map((item) => item.body)));
      await fs.appendFile(files.index, Buffer.concat(rows));
      for (const item of items) {
        index.categories[item.category] = (index.categories[item.category] ?? 0) + 1;
        index.count++;
      }
      index.bytes = offset;
      index.summaryBytes = summaryOffset;
      index.lastSeq = last.seq;
      index.lastElapsedMs = last.elapsedMs;
    } catch (error) {
      index.dirty = true;
      this._scheduleMetadata(sessionId);
      throw error;
    }
    this._scheduleMetadata(sessionId);
    for (const item of items) item.request.resolve(item.event);
  }
  private _scheduleMetadata(id: string) {
    this.metadataDirty.add(id);
    if (this.metadataTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.metadataTimers.delete(id);
      this._enqueue(() => this._persistMetadata(id)).catch(() => {
        /* 下次追加、flush 或状态更新会重试；计数在重启时由时间线重建。 */
      });
    }, METADATA_DELAY_MS);
    timer.unref?.();
    this.metadataTimers.set(id, timer);
  }
  private _cancelMetadata(id: string) {
    clearTimeout(this.metadataTimers.get(id));
    this.metadataTimers.delete(id);
    this.metadataDirty.delete(id);
  }
  private async _persistMetadata(id: string) {
    if (!this.metadataDirty.has(id)) return;
    const metadata = this.sessions.get(id);
    if (!metadata) return this._cancelMetadata(id);
    try {
      await this._writeMetadata(metadata);
    } catch (error) {
      this.metadataDirty.add(id);
      throw error;
    }
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
  private manageable(id: string) {
    const value = this._known(id);
    if (value.status === "recording" || value.status === "paused")
      throw new Error("请先结束当前录制，再管理记录");
    return value;
  }
  private async saveChange(current: SessionMetadata, changes: Partial<SessionMetadata>) {
    const updated = { ...current, ...changes, updatedAt: new Date().toISOString() };
    await this._writeMetadata(updated);
    this.sessions.set(current.id, updated);
    return { ...updated };
  }
  rename(id: string, name: string) {
    return this._enqueue(async () => {
      const current = this.manageable(id);
      if (current.libraryState === "trashed") throw new Error("请先从回收站恢复记录");
      if (typeof name !== "string" || !name.trim() || name.trim().length > 160)
        throw new Error("会话名称需为 1 到 160 个字符");
      return this.saveChange(current, { name: name.trim() });
    });
  }
  archive(id: string) {
    return this._enqueue(async () => {
      const current = this.manageable(id);
      if (current.libraryState !== "active") throw new Error("只有常用记录可以归档");
      return this.saveChange(current, { libraryState: "archived", archivedAt: new Date().toISOString() });
    });
  }
  unarchive(id: string) {
    return this._enqueue(async () => {
      const current = this.manageable(id);
      if (current.libraryState !== "archived") throw new Error("此记录未归档");
      return this.saveChange(current, { libraryState: "active", archivedAt: null });
    });
  }
  trash(id: string) {
    return this._enqueue(async () => {
      const current = this.manageable(id);
      if (current.libraryState === "trashed") throw new Error("此记录已在回收站");
      return this.saveChange(current, {
        libraryState: "trashed", trashOrigin: current.libraryState, trashedAt: new Date().toISOString(),
      });
    });
  }
  restore(id: string) {
    return this._enqueue(async () => {
      const current = this.manageable(id);
      if (current.libraryState !== "trashed" || !current.trashOrigin)
        throw new Error("此记录不在回收站");
      return this.saveChange(current, { libraryState: current.trashOrigin, trashOrigin: null, trashedAt: null });
    });
  }
  deletePermanently(id: string): Promise<void> {
    return this._enqueue(async () => {
      const current = this.manageable(id);
      if (current.libraryState !== "trashed") throw new Error("请先将记录移入回收站");
      await this.deleteFiles(id);
    });
  }
  /** Preflight all children before persisting the parent's deletion intent. */
  deleteGroupRecordings(sessionGroupId: string, beforeDelete?: () => Promise<void>): Promise<void> {
    return this._enqueue(async () => {
      if (!SESSION_GROUP_ID_PATTERN.test(sessionGroupId)) throw new Error("无效 Session ID");
      const ids = this.list().filter(record => record.sessionGroupId === sessionGroupId).map(record => record.id);
      for (const id of ids) {
        this.manageable(id);
        if (this.readers.get(id)) throw new Error("记录正在读取，请稍后重试");
      }
      await beforeDelete?.();
      for (const id of ids) await this.deleteFiles(id);
    });
  }
  private async deleteFiles(id: string) {
    if (this.readers.get(id)) throw new Error("记录正在读取，请稍后重试");
    await this.reader.invalidate(id);
    this._cancelMetadata(id);
    const staging = path.join(this.rootDir, `.deleting-${id}-${randomUUID()}`);
    await fs.rename(this.getSessionDirectory(id), staging);
    this.sessions.delete(id);
    this.indexes.delete(id);
    // The renamed directory is a deletion tombstone, reclaimed on startup if interrupted.
    await fs.rm(staging, { recursive: true, force: true, maxRetries: 3 });
  }
  private async read<T>(id: string, operation: () => Promise<T>): Promise<T> {
    await this._enqueue(() => {
      this._known(id);
      if (this.libraryMutations.has(id)) throw new Error("记录正在批量整理，请稍后重试");
      this.readers.set(id, (this.readers.get(id) || 0) + 1);
    });
    try {
      return await operation();
    } finally {
      const count = (this.readers.get(id) || 1) - 1;
      if (count) this.readers.set(id, count);
      else this.readers.delete(id);
    }
  }
  /** Include resource reads in the same lease as timeline reads. Nested reads are safe. */
  withReadLease<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return this.read(id, operation);
  }
  /** Reserve the complete set before any write, without holding the store queue during writes. */
  async withLibraryMutation<T>(ids: string[], operation: () => Promise<T>): Promise<T> {
    const selected = [...new Set(ids)];
    await this._enqueue(() => {
      for (const id of selected) {
        const record = this.manageable(id);
        if (this.readers.get(id)) throw new Error(`采集记录“${record.name}”正在读取，请稍后重试；未执行任何批量操作`);
        if (this.libraryMutations.has(id)) throw new Error(`采集记录“${record.name}”正在整理，请稍后重试`);
      }
      for (const id of selected) this.libraryMutations.add(id);
    });
    try { return await operation(); }
    finally { await this._enqueue(() => { for (const id of selected) this.libraryMutations.delete(id); }); }
  }
  /** 等待已排队的写入完成，并落盘延迟中的元数据。 */
  flush(): Promise<void> {
    return this._enqueue(async () => {
      for (const id of [...this.metadataDirty])
        await this._persistMetadata(id).catch(() => {});
    }).catch(() => {});
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
    return this.read(query.sessionId, () => this.reader.timeline(query));
  }
  getEvent(sessionId: string, eventId: string, options: DetailOptions = {}) {
    return this.read(sessionId, () => this.reader.getEvent(sessionId, eventId, options));
  }
  replaySeek(query: ReplayQuery) {
    return this.read(query.sessionId, () => this.reader.replaySeek(query));
  }
  replayChunk(query: ChunkQuery) {
    return this.read(query.sessionId, () => this.reader.replayChunk(query));
  }
}
export { summarize, compactEvent } from "./index";
