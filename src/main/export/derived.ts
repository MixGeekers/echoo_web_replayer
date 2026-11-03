import type { FileHandle } from "node:fs/promises";
import type { JsonToken } from "../storage/tokens";
import type { SessionMetadata } from "../../shared/contracts/storage";
import type { FileEntry, ExportSignals } from "../../shared/contracts/export";
import { errorOf } from "../storage/values";
type ScalarValue = string | number | boolean | null;
interface DerivedEvent {
  fields: Record<string, Spool>;
  values: Record<string, ScalarValue>;
  payload: Spool;
  spools: Spool[];
  reason: ScalarValue;
  signal: AbortSignal | undefined;
  invalidPayload?: boolean;
  html?: HtmlValue;
  outerHTML?: HtmlValue;
}
interface ActivePayload {
  boundary: ValueBoundary;
  html: HtmlValue | undefined;
  reason: SmallValue | null;
}
interface ActiveField {
  key: string;
  writer: JsonWriter | PayloadWriter | null;
  boundary: ValueBoundary;
  capture: SmallValue | null;
}
interface SnapshotEntry {
  eventId: ScalarValue | undefined;
  seq: number;
  documentId: ScalarValue | undefined;
  html: string;
  state: string;
}

// The token parser never assembles a complete JSONL event or a large JSON value.
// Small values stay in a bounded spool; larger values spill to the staging disk.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { parser } from "stream-json";

const BUFFER_BYTES = 64 * 1024;
const META_FIELDS = new Set([
  "id",
  "seq",
  "timestamp",
  "documentId",
  "url",
  "title",
]);
const CAPTURE_FIELDS = new Set([
  ...META_FIELDS,
  "type",
  "elapsedMs",
  "summary",
]);
const cell = (value: unknown) =>
  String(value ?? "")
    .slice(0, 1024)
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const abort = (signal?: AbortSignal | null) => {
  if (signal?.aborted)
    throw Object.assign(new Error("导出已取消"), { name: "AbortError" });
};

class Spool {
  directory: string;
  filename: string | null;
  handle: FileHandle | null;
  parts: Buffer[];
  buffered: number;
  bytes: number;
  closed: boolean;
  signal: AbortSignal | null | undefined;
  constructor(
    directory: string,
    forceFile: string | null = null,
    signal: AbortSignal | null | undefined = null,
  ) {
    this.directory = directory;
    this.filename = forceFile;
    this.handle = null;
    this.parts = [];
    this.buffered = 0;
    this.bytes = 0;
    this.closed = false;
    this.signal = signal;
  }
  async write(value: string | Buffer) {
    abort(this.signal);
    if (!value.length) return;
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.parts.push(bytes);
    this.buffered += bytes.length;
    this.bytes += bytes.length;
    if (this.buffered >= BUFFER_BYTES) await this.flush();
  }
  async flush() {
    if (!this.buffered) return;
    if (!this.handle) {
      if (!this.filename)
        this.filename = path.join(this.directory, `${randomUUID()}.part`);
      this.handle = await fsp.open(this.filename, "wx");
    }
    const buffer = Buffer.concat(this.parts, this.buffered);
    this.parts = [];
    this.buffered = 0;
    let offset = 0;
    while (offset < buffer.length)
      offset += (
        await this.handle.write(buffer, offset, buffer.length - offset)
      ).bytesWritten;
  }
  async finish(force = false) {
    if (this.closed) return;
    if (force || this.handle || this.filename) await this.flush();
    if (force && !this.handle) {
      if (!this.filename) throw new Error("输出文件未指定");
      this.handle = await fsp.open(this.filename, "wx");
    }
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
    this.closed = true;
  }
  async appendTo(output: Spool, { start = 0, end = this.bytes } = {}) {
    await this.finish();
    if (end <= start) return;
    if (this.filename) {
      for await (const chunk of fs.createReadStream(this.filename, {
        start,
        end: end - 1,
        highWaterMark: BUFFER_BYTES,
      }))
        await output.write(chunk);
    } else
      await output.write(
        Buffer.concat(this.parts, this.buffered).subarray(start, end),
      );
  }
  async dispose() {
    if (this.handle) {
      await this.handle.close().catch(() => {});
      this.handle = null;
    }
    if (this.filename)
      await fsp.rm(this.filename, { force: true }).catch(() => {});
  }
}

// JSON strings may be split between UTF-16 surrogate code units. Escaping each
// token separately preserves their JSON meaning, including isolated surrogates.
class JsonWriter {
  output: Spool;
  stack: { kind: "object" | "array"; first: boolean }[];
  constructor(output: Spool) {
    this.output = output;
    this.stack = [];
  }
  async valuePrefix() {
    const parent = this.stack.at(-1);
    if (parent?.kind === "array") {
      if (!parent.first) await this.output.write(",");
      parent.first = false;
    }
  }
  async token(token: JsonToken) {
    const name = token.name;
    if (name === "startKey") {
      const parent = this.stack.at(-1)!;
      if (!parent.first) await this.output.write(",");
      parent.first = false;
      await this.output.write('"');
    } else if (name === "endKey") await this.output.write('":');
    else if (name === "stringChunk")
      await this.output.write(JSON.stringify(token.value).slice(1, -1));
    else if (name === "startString") {
      await this.valuePrefix();
      await this.output.write('"');
    } else if (name === "endString") await this.output.write('"');
    else if (name === "startObject" || name === "startArray") {
      await this.valuePrefix();
      await this.output.write(name === "startObject" ? "{" : "[");
      this.stack.push({
        kind: name === "startObject" ? "object" : "array",
        first: true,
      });
    } else if (name === "endObject" || name === "endArray") {
      this.stack.pop();
      await this.output.write(name === "endObject" ? "}" : "]");
    } else if (name === "startNumber") await this.valuePrefix();
    else if (name === "numberChunk") await this.output.write(token.value);
    else if (
      name === "trueValue" ||
      name === "falseValue" ||
      name === "nullValue"
    ) {
      await this.valuePrefix();
      await this.output.write(name.slice(0, -5));
    }
  }
}

class ValueBoundary {
  depth: number;
  constructor() {
    this.depth = 0;
  }
  token({ name }: JsonToken) {
    if (name === "startObject" || name === "startArray") this.depth++;
    else if (name === "endObject" || name === "endArray")
      return --this.depth === 0;
    else if (
      name === "endString" ||
      name === "endNumber" ||
      ["trueValue", "falseValue", "nullValue"].includes(name)
    )
      return this.depth === 0;
    return false;
  }
}

class SmallValue {
  limit: number;
  text: string;
  kind: string | null;
  overflow: boolean;
  constructor(limit = 1024) {
    this.limit = limit;
    this.text = "";
    this.kind = null;
    this.overflow = false;
  }
  token(token: JsonToken) {
    if (token.name === "startString") this.kind = "string";
    if (token.name === "startNumber") this.kind = "number";
    if (token.name === "stringChunk" || token.name === "numberChunk") {
      this.overflow ||= this.text.length + token.value.length > this.limit;
      this.text += token.value.slice(
        0,
        Math.max(0, this.limit - this.text.length),
      );
    }
    if (["trueValue", "falseValue", "nullValue"].includes(token.name)) {
      this.kind = token.name;
      this.text = token.name.slice(0, -5);
    }
  }
  value() {
    if (this.kind === "number") return Number(this.text);
    if (this.kind === "nullValue") return null;
    if (this.kind === "trueValue") return true;
    if (this.kind === "falseValue") return false;
    return this.text;
  }
}

class HtmlValue {
  output: Spool;
  kind: string | null;
  carry: string;
  isNull: boolean;
  invalid = false;
  constructor(output: Spool) {
    this.output = output;
    this.kind = null;
    this.carry = "";
    this.isNull = false;
  }
  async text(value: string, final = false) {
    let text = this.carry + value;
    this.carry = "";
    if (!final && text.length && /[\uD800-\uDBFF]/.test(text.at(-1)!)) {
      this.carry = text.at(-1)!;
      text = text.slice(0, -1);
    }
    if (text) await this.output.write(text);
  }
  async token(token: JsonToken) {
    if (!this.kind) {
      this.kind = token.name;
      if (token.name === "nullValue") this.isNull = true;
      if (token.name === "trueValue" || token.name === "falseValue")
        await this.text(token.name.slice(0, -5), true);
      if (token.name === "startObject" || token.name === "startArray")
        this.invalid = true;
    }
    if (
      !this.invalid &&
      (token.name === "stringChunk" || token.name === "numberChunk")
    )
      await this.text(token.value);
    if (
      !this.invalid &&
      (token.name === "endString" || token.name === "endNumber")
    )
      await this.text("", true);
  }
}

// Routes the payload's direct fields while forwarding all nested values intact.
class PayloadWriter {
  event: DerivedEvent;
  directory: string;
  output: Spool;
  writer: JsonWriter;
  started: boolean;
  active: ActivePayload | null;
  key: string;
  pendingKey: JsonToken[];
  streamingKey: boolean;
  ignored = false;
  constructor(event: DerivedEvent, directory: string) {
    this.event = event;
    this.directory = directory;
    this.output = event.payload;
    this.writer = new JsonWriter(this.output);
    this.started = false;
    this.active = null;
    this.key = "";
    this.pendingKey = [];
    this.streamingKey = false;
  }
  async token(token: JsonToken) {
    if (!this.started) {
      this.started = true;
      if (token.name === "nullValue") {
        await this.output.write("{}");
        return;
      }
      if (token.name !== "startObject") {
        this.event.invalidPayload = true;
        this.ignored = true;
        return;
      }
      await this.writer.token(token);
      return;
    }
    if (this.ignored) return;
    if (this.active) {
      if (this.active.html) await this.active.html.token(token);
      else await this.writer.token(token);
      this.active.reason?.token(token);
      if (this.active.boundary.token(token)) {
        if (this.active.reason) this.event.reason = this.active.reason.value();
        this.active = null;
      }
      return;
    }
    if (token.name === "startKey") {
      this.key = "";
      this.pendingKey = [token];
      this.streamingKey = false;
      return;
    }
    if (token.name === "stringChunk") {
      if (!this.streamingKey) {
        this.key += token.value;
        this.pendingKey.push(token);
        if (this.key.length > 16) {
          for (const value of this.pendingKey) await this.writer.token(value);
          this.pendingKey = [];
          this.streamingKey = true;
          this.key = "";
        }
      } else await this.writer.token(token);
      return;
    }
    if (token.name === "endKey") {
      if (this.key !== "html" && this.key !== "outerHTML") {
        for (const value of this.pendingKey) await this.writer.token(value);
        await this.writer.token(token);
      }
      this.pendingKey = [];
      return;
    }
    if (token.name === "endObject") {
      await this.writer.token(token);
      return;
    }
    const htmlKey =
      this.key === "html" || this.key === "outerHTML" ? this.key : null;
    let html: HtmlValue | undefined;
    if (htmlKey) {
      const spool = new Spool(this.directory, null, this.event.signal);
      this.event.spools.push(spool);
      html = new HtmlValue(spool);
      this.event[htmlKey] = html;
    }
    this.active = {
      boundary: new ValueBoundary(),
      html,
      reason: this.key === "reason" ? new SmallValue(280) : null,
    };
    if (html) await html.token(token);
    else await this.writer.token(token);
    this.active.reason?.token(token);
    if (this.active.boundary.token(token)) {
      if (this.active.reason) this.event.reason = this.active.reason.value();
      this.active = null;
    }
  }
}

async function hashFile(filename: string, signal?: AbortSignal) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(filename, {
    highWaterMark: BUFFER_BYTES,
  })) {
    abort(signal);
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function deriveFiles({
  timelinePath,
  byteLength,
  staging,
  metadata,
  capturedAt,
  preface = "",
  onFile = async () => {},
  onSnapshot = async () => {},
  signal,
  onProgress = () => {},
}: ExportSignals & {
  timelinePath: string;
  byteLength: number;
  staging: string;
  metadata: Pick<SessionMetadata, "id" | "name">;
  capturedAt: string;
  /** Optional Markdown placed before the event table, such as human annotations. */
  preface?: string;
  onFile?: (item: FileEntry) => Promise<unknown>;
  onSnapshot?: (item: SnapshotEntry) => Promise<unknown>;
}) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0)
    throw new Error("无效的时间线长度");
  abort(signal);
  await fsp.mkdir(staging, { recursive: true });
  const scratch = await fsp.mkdtemp(path.join(staging, ".derive-"));
  const markdown = new Spool(
    scratch,
    path.join(staging, "timeline.md"),
    signal,
  );
  const pendingOutputs = new Set([markdown]);
  const counts = {
    eventCount: 0,
    lastSeq: 0,
    actionCount: 0,
    mutationCount: 0,
    snapshotCount: 0,
  };
  const input = byteLength
    ? fs.createReadStream(timelinePath, {
        start: 0,
        end: byteLength - 1,
        highWaterMark: BUFFER_BYTES,
      })
    : Readable.from([]);
  const tokens = parser({
    jsonStreaming: true,
    packValues: false,
    packKeys: false,
    packStrings: false,
    packNumbers: false,
  });
  tokens.on("error", () => {});
  let event: DerivedEvent | null = null,
    active: ActiveField | null = null,
    topKey = "",
    topKeyOpen = false,
    processed = 0;
  const failInput = (error: Error) => tokens.destroy(error);
  input.on("error", failInput);
  const cancel = () => {
    const error = Object.assign(new Error("导出已取消"), {
      name: "AbortError",
    });
    input.destroy(error);
    tokens.destroy(error);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  input.pipe(tokens);
  const disposeEvent = async () => {
    if (event) await Promise.all(event.spools.map((value) => value.dispose()));
    event = null;
  };
  const reportFile = async (name: string) =>
    onFile({
      path: name,
      ...(await hashFile(path.join(staging, ...name.split("/")), signal)),
    });
  async function finishEvent() {
    if (!event) throw new Error("事件未开始");
    const values = event.values;
    if (
      typeof values.seq !== "number" ||
      !Number.isSafeInteger(values.seq) ||
      values.seq <= counts.lastSeq ||
      typeof values.type !== "string" ||
      !values.type
    )
      throw new Error("时间线事件序号或类型无效");
    counts.eventCount++;
    counts.lastSeq = values.seq;
    counts.actionCount += Number(values.type.startsWith("action."));
    counts.mutationCount += Number(values.type === "dom.mutation");
    counts.snapshotCount += Number(values.type === "dom.snapshot");
    let link = "";
    if (values.type === "dom.snapshot") {
      if (
        event.invalidPayload ||
        event.html?.invalid ||
        event.outerHTML?.invalid
      )
        throw new Error(
          "DOM 快照 payload 必须是对象，html/outerHTML 必须是字符串或简单值",
        );
      await fsp.mkdir(path.join(staging, "snapshots"), { recursive: true });
      const stem = String(values.seq).padStart(8, "0");
      const htmlName = `snapshots/${stem}.html`,
        stateName = `snapshots/${stem}.state.json`;
      const htmlOutput = new Spool(
        scratch,
        path.join(staging, "snapshots", `${stem}.html`),
        signal,
      );
      pendingOutputs.add(htmlOutput);
      const source =
        event.html && !event.html.isNull ? event.html : event.outerHTML;
      if (source && !source.isNull) await source.output.appendTo(htmlOutput);
      await htmlOutput.finish(true);
      pendingOutputs.delete(htmlOutput);
      const stateOutput = new Spool(
        scratch,
        path.join(staging, "snapshots", `${stem}.state.json`),
        signal,
      );
      pendingOutputs.add(stateOutput);
      await stateOutput.write("{");
      let first = true;
      for (const [key, field] of [
        ["eventId", "id"],
        ["seq", "seq"],
        ["timestamp", "timestamp"],
        ["documentId", "documentId"],
        ["url", "url"],
        ["title", "title"],
      ] as const) {
        const fieldOutput = event.fields[field];
        if (!fieldOutput) continue;
        await stateOutput.write(`${first ? "" : ","}${JSON.stringify(key)}:`);
        first = false;
        await fieldOutput.appendTo(stateOutput);
      }
      await stateOutput.write(
        `${first ? "" : ","}"htmlFile":${JSON.stringify(`${stem}.html`)}`,
      );
      await event.payload.finish();
      if (event.payload.bytes > 2) {
        await stateOutput.write(",");
        await event.payload.appendTo(stateOutput, {
          start: 1,
          end: event.payload.bytes - 1,
        });
      }
      await stateOutput.write("}\n");
      await stateOutput.finish(true);
      pendingOutputs.delete(stateOutput);
      await reportFile(htmlName);
      await reportFile(stateName);
      await onSnapshot({
        eventId: values.id,
        seq: values.seq,
        documentId: values.documentId,
        html: htmlName,
        state: stateName,
      });
      link = `[HTML](${htmlName}) · [状态](${stateName})`;
    }
    const summary =
      values.summary ||
      (values.type === "dom.snapshot"
        ? `DOM 快照 · ${event.reason || "checkpoint"}`
        : values.type);
    await markdown.write(
      `| ${values.seq} | ${(Number(values.elapsedMs || 0) / 1000).toFixed(3)}s | ${cell(values.timestamp)} | ${cell(values.type)} | ${cell(summary)} | ${link} |\n`,
    );
    await disposeEvent();
  }
  try {
    await markdown.write(
      `# ${cell(metadata.name)} · 完整事件索引\n\n会话：${cell(metadata.id)}  \n导出截点：${cell(capturedAt)}  \n原始数据见 timeline.jsonl；摘要仅供检索。\n\n${preface}| 序号 | 相对时间 | UTC 时间 | 类型 | 摘要 | 快照 |\n| --- | --- | --- | --- | --- | --- |\n`,
    );
    for await (const token of tokens as AsyncIterable<JsonToken>) {
      if ((++processed & 1023) === 0) {
        abort(signal);
        onProgress({
          phase: "derive",
          bytesRead: ("bytesRead" in input ? input.bytesRead : 0) || 0,
          totalBytes: byteLength,
        });
      }
      if (!event) {
        if (token.name !== "startObject")
          throw new Error("时间线事件必须是 JSON 对象");
        const payload = new Spool(scratch, null, signal);
        event = {
          fields: Object.create(null),
          values: Object.create(null),
          payload,
          spools: [payload],
          reason: "",
          signal,
        };
        continue;
      }
      if (active) {
        if (active.writer) await active.writer.token(token);
        active.capture?.token(token);
        if (active.boundary.token(token)) {
          if (active.capture) event.values[active.key] = active.capture.value();
          active = null;
        }
        continue;
      }
      if (token.name === "startKey") {
        topKey = "";
        topKeyOpen = true;
        continue;
      }
      if (topKeyOpen && token.name === "stringChunk") {
        if (topKey.length <= 32) topKey += token.value;
        continue;
      }
      if (token.name === "endKey") {
        topKeyOpen = false;
        continue;
      }
      if (token.name === "endObject") {
        await finishEvent();
        continue;
      }
      let writer: JsonWriter | PayloadWriter | null = null;
      if (topKey === "payload") writer = new PayloadWriter(event, scratch);
      else if (META_FIELDS.has(topKey)) {
        const spool = new Spool(scratch, null, signal);
        event.spools.push(spool);
        event.fields[topKey] = spool;
        writer = new JsonWriter(spool);
      }
      active = {
        key: topKey,
        writer,
        boundary: new ValueBoundary(),
        capture: CAPTURE_FIELDS.has(topKey)
          ? new SmallValue(topKey === "summary" ? 280 : 1024)
          : null,
      };
      if (writer) await writer.token(token);
      active.capture?.token(token);
      if (active.boundary.token(token)) {
        if (active.capture) event.values[topKey] = active.capture.value();
        active = null;
      }
    }
    abort(signal);
    if (event || active) throw new Error("时间线最后一条事件不完整");
    if (
      byteLength &&
      ("bytesRead" in input ? input.bytesRead : 0) !== byteLength
    )
      throw new Error("时间线读取不完整");
    await markdown.finish(true);
    pendingOutputs.delete(markdown);
    await reportFile("timeline.md");
    return counts;
  } finally {
    signal?.removeEventListener("abort", cancel);
    input.destroy();
    tokens.destroy();
    await disposeEvent();
    await Promise.all([...pendingOutputs].map((output) => output.dispose()));
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

export { deriveFiles };
