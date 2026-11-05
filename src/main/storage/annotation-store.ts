import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  Annotation,
  AnnotationAuthor,
  AnnotationResult,
  AnnotationSet,
} from "../../shared/contracts/annotations";
import {
  ANNOTATION_COUNT_LIMIT,
  ANNOTATION_TEXT_LIMIT,
} from "../../shared/contracts/annotations";
import type { SessionStore } from "./session-store";
import { errorOf } from "./values";

export const ANNOTATIONS_FILE = "annotations.json";
const ANNOTATION_ID = /^annotation-[a-f0-9-]{36}$/;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function fail(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_ANNOTATION" });
}
function seqValue(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    fail(`${name} 必须为正整数事件序号`);
  return value;
}
function textValue(value: unknown): string {
  if (typeof value !== "string") fail("标注内容必须为文本");
  const text = value.trim();
  if (!text) fail("标注内容不能为空");
  if (text.length > ANNOTATION_TEXT_LIMIT)
    fail(`标注内容不能超过 ${ANNOTATION_TEXT_LIMIT} 个字符`);
  return text;
}
function isoValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    fail(`${name} 必须为 ISO 时间`);
  return value;
}

/** Strictly validate one stored or exported annotation. */
export function parseAnnotation(value: unknown): Annotation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("标注必须为对象");
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !ANNOTATION_ID.test(raw.id))
    fail("无效的标注 ID");
  const seq = seqValue(raw.seq, "seq");
  const endSeq = raw.endSeq === null ? null : seqValue(raw.endSeq, "endSeq");
  if (endSeq !== null && endSeq < seq) fail("标注范围结束不能早于开始");
  if (raw.author !== "user" && raw.author !== "agent") fail("无效的标注作者");
  const elapsedMs = raw.elapsedMs;
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0)
    fail("无效的标注时间");
  if (typeof raw.eventType !== "string" || raw.eventType.length > 200)
    fail("无效的标注事件类型");
  return {
    id: raw.id,
    seq,
    endSeq,
    text: textValue(raw.text),
    author: raw.author,
    createdAt: isoValue(raw.createdAt, "createdAt"),
    updatedAt: isoValue(raw.updatedAt, "updatedAt"),
    elapsedMs,
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : "",
    eventType: raw.eventType,
  };
}
export function emptyAnnotations(recordingId: string): AnnotationSet {
  return {
    format: "tracedock-annotations",
    schemaVersion: 1,
    recordingId,
    revision: 0,
    annotations: [],
  };
}
/** Strictly validate an annotations.json document (store or export). */
export function parseAnnotationSet(
  value: unknown,
  recordingId?: string,
): AnnotationSet {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("标注文件必须为对象");
  const raw = value as Record<string, unknown>;
  if (raw.format !== "tracedock-annotations" || raw.schemaVersion !== 1)
    fail("不支持的标注文件版本");
  if (typeof raw.recordingId !== "string" || !raw.recordingId)
    fail("标注文件缺少采集记录 ID");
  if (recordingId !== undefined && raw.recordingId !== recordingId)
    fail("标注文件与采集记录不一致");
  if (
    typeof raw.revision !== "number" ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 0
  )
    fail("无效的标注版本");
  if (!Array.isArray(raw.annotations) || raw.annotations.length > ANNOTATION_COUNT_LIMIT)
    fail("无效的标注列表");
  const annotations = raw.annotations.map(parseAnnotation);
  if (new Set(annotations.map((item) => item.id)).size !== annotations.length)
    fail("标注 ID 重复");
  return {
    format: "tracedock-annotations",
    schemaVersion: 1,
    recordingId: raw.recordingId,
    revision: raw.revision,
    annotations: sortAnnotations(annotations),
  };
}
export function sortAnnotations(list: Annotation[]): Annotation[] {
  return [...list].sort(
    (a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}
/** Read a recording directory's annotations; a missing file is an empty set. */
export async function readAnnotationFile(
  directory: string,
  recordingId: string,
): Promise<AnnotationSet> {
  const filename = path.join(directory, ANNOTATIONS_FILE);
  let text: string;
  try {
    const stat = await fs.stat(filename);
    if (stat.size > MAX_FILE_BYTES) fail("标注文件过大");
    text = await fs.readFile(filename, "utf8");
  } catch (caught) {
    if (errorOf(caught).code === "ENOENT") return emptyAnnotations(recordingId);
    throw caught;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`采集记录 ${recordingId} 的标注文件损坏，原文件已保留`);
  }
  return parseAnnotationSet(parsed, recordingId);
}
/** Limit annotations to an export boundary: anchors inside [startSeq, endSeq], ranges clipped. */
export function clipAnnotations(
  set: AnnotationSet,
  startSeq: number,
  endSeq: number,
): AnnotationSet {
  return {
    ...set,
    annotations: set.annotations
      .filter((item) => item.seq >= startSeq && item.seq <= endSeq)
      .map((item) => ({
        ...item,
        endSeq: item.endSeq === null ? null : Math.min(item.endSeq, endSeq),
      })),
  };
}

export interface AnnotationAnchor {
  seq: number;
  endSeq?: number | null | undefined;
  elapsedMs: number;
  timestamp: string;
  eventType: string;
}

/**
 * Writes are serialized on the recording store queue, so they never interleave with
 * appends, lifecycle changes or deletion of the same recording directory.
 */
export class AnnotationStore {
  constructor(private readonly store: SessionStore) {}
  private directory(id: string) {
    return this.store.getSessionDirectory(id);
  }
  private editable(id: string) {
    const record = this.store._known(id);
    if (record.libraryState === "trashed") throw new Error("请先从回收站恢复记录，再编辑标注");
    return record;
  }
  async read(id: string): Promise<AnnotationSet> {
    this.store._known(id);
    return readAnnotationFile(this.directory(id), id);
  }
  private async write(set: AnnotationSet) {
    const filename = path.join(this.directory(set.recordingId), ANNOTATIONS_FILE),
      temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(set, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      // Windows scanners/readers can briefly lock the destination. Retry only
      // the atomic replacement; never unlink the last valid annotation file.
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(temporary, filename);
          break;
        } catch (caught) {
          if (process.platform !== "win32" || attempt >= 6 ||
              !["EPERM", "EACCES", "EBUSY"].includes(errorOf(caught).code ?? ""))
            throw caught;
          await delay(25 * 2 ** attempt);
        }
      }
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
  private change(
    id: string,
    expectedRevision: number | undefined,
    apply: (set: AnnotationSet, now: string) => Annotation | null,
  ): Promise<AnnotationResult> {
    return this.store._enqueue(async () => {
      this.editable(id);
      const current = await readAnnotationFile(this.directory(id), id);
      if (expectedRevision !== undefined && expectedRevision !== current.revision)
        throw Object.assign(new Error("标注已被其他操作修改，请刷新后重试"), {
          code: "REVISION_CONFLICT",
        });
      const now = new Date().toISOString();
      const next: AnnotationSet = {
        ...current,
        annotations: [...current.annotations],
        revision: current.revision + 1,
      };
      const annotation = apply(next, now);
      next.annotations = sortAnnotations(next.annotations);
      await this.write(next);
      return { ...next, annotation };
    });
  }
  private checkAnchor(id: string, anchor: { seq: number; endSeq?: number | null | undefined }) {
    const record = this.store._known(id);
    const seq = seqValue(anchor.seq, "seq");
    const endSeq =
      anchor.endSeq === undefined || anchor.endSeq === null
        ? null
        : seqValue(anchor.endSeq, "endSeq");
    if (seq > record.lastSeq || (endSeq !== null && endSeq > record.lastSeq))
      fail("标注位置超出已保存的事件");
    if (endSeq !== null && endSeq < seq) fail("标注范围结束不能早于开始");
    return { seq, endSeq: endSeq === seq ? null : endSeq };
  }
  async create(
    id: string,
    input: AnnotationAnchor & { text: string; author: AnnotationAuthor },
    expectedRevision?: number,
  ) {
    const text = textValue(input.text);
    if (input.author !== "user" && input.author !== "agent") fail("无效的标注作者");
    return this.change(id, expectedRevision, (set, now) => {
      const { seq, endSeq } = this.checkAnchor(id, input);
      if (set.annotations.length >= ANNOTATION_COUNT_LIMIT)
        fail(`每条采集记录最多 ${ANNOTATION_COUNT_LIMIT} 条标注`);
      const annotation: Annotation = {
        id: `annotation-${randomUUID()}`,
        seq,
        endSeq,
        text,
        author: input.author,
        createdAt: now,
        updatedAt: now,
        elapsedMs: Math.max(0, Number(input.elapsedMs) || 0),
        timestamp: String(input.timestamp || ""),
        eventType: String(input.eventType || "").slice(0, 200),
      };
      set.annotations.push(annotation);
      return annotation;
    });
  }
  async update(
    id: string,
    annotationId: string,
    patch: { text?: string | undefined; endSeq?: number | null | undefined },
    expectedRevision?: number,
  ) {
    const text = patch.text === undefined ? undefined : textValue(patch.text);
    return this.change(id, expectedRevision, (set, now) => {
      const index = set.annotations.findIndex((item) => item.id === annotationId);
      const current = set.annotations[index];
      if (!current) throw Object.assign(new Error("找不到指定标注"), { code: "NOT_FOUND" });
      const endSeq =
        patch.endSeq === undefined
          ? current.endSeq
          : this.checkAnchor(id, { seq: current.seq, endSeq: patch.endSeq }).endSeq;
      const updated = { ...current, text: text ?? current.text, endSeq, updatedAt: now };
      set.annotations[index] = updated;
      return updated;
    });
  }
  async remove(id: string, annotationId: string, expectedRevision?: number) {
    return this.change(id, expectedRevision, (set) => {
      const index = set.annotations.findIndex((item) => item.id === annotationId);
      if (index < 0) throw Object.assign(new Error("找不到指定标注"), { code: "NOT_FOUND" });
      set.annotations.splice(index, 1);
      return null;
    });
  }
}
