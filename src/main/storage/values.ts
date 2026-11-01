import type {
  EventPreview,
  SessionMetadata,
  StoredEvent,
} from "../../shared/contracts/storage";
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function errorOf(
  value: unknown,
): Error & { code?: string; offset?: number; lineNumber?: number } {
  return value instanceof Error ? value : new Error(String(value));
}
export function parseObject(text: string): Record<string, unknown> {
  return object(JSON.parse(text) as unknown);
}
const optionalString = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const finiteNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
function envelope(value: unknown) {
  const raw = object(value);
  if (
    typeof raw.seq !== "number" ||
    !Number.isSafeInteger(raw.seq) ||
    raw.seq < 1 ||
    typeof raw.type !== "string" ||
    !raw.type
  )
    throw new Error("无效事件：需要正整数 seq 与字符串 type");
  return { raw, seq: raw.seq, type: raw.type };
}
/** A bounded UI projection. Original metadata and payload remain intact in the fact file. */
export function preview(value: unknown): EventPreview {
  const { raw, seq, type } = envelope(value);
  return {
    ...raw,
    seq,
    type,
    payload: raw.payload,
    id: optionalString(raw.id),
    sessionId: optionalString(raw.sessionId),
    timestamp: optionalString(raw.timestamp),
    receivedAt: optionalString(raw.receivedAt),
    elapsedMs: finiteNumber(raw.elapsedMs),
    documentId: raw.documentId === null ? null : optionalString(raw.documentId),
    url: optionalString(raw.url),
    title: optionalString(raw.title),
    summary: optionalString(raw.summary),
    payloadTruncated: raw.payloadTruncated === true || undefined,
  };
}
/** Validate the current persisted event envelope without altering its payload. */
export function storedEvent(value: unknown, expectedSessionId: string): StoredEvent {
  const { raw, seq, type } = envelope(value);
  for (const key of ["id", "sessionId", "timestamp", "receivedAt", "url", "title", "summary"])
    if (typeof raw[key] !== "string") throw new Error(`无效事件字段：${key}`);
  if (raw.sessionId !== expectedSessionId ||
      typeof raw.elapsedMs !== "number" || !Number.isFinite(raw.elapsedMs) || raw.elapsedMs < 0 ||
      (raw.documentId !== null && typeof raw.documentId !== "string") ||
      !Object.hasOwn(raw, "payload"))
    throw new Error("无效事件信封");
  return { ...raw, seq, type } as StoredEvent;
}
export function sessionMetadata(value: unknown): SessionMetadata {
  const raw = object(value);
  if (raw.schemaVersion !== 3) throw new Error("仅支持当前基线的采集格式（schemaVersion 3）");
  for (const key of ["id", "sessionGroupId", "name", "profileId", "profileName", "startedAt", "updatedAt", "url"])
    if (typeof raw[key] !== "string") throw new Error(`无效会话字段：${key}`);
  if (!/^group-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(raw.sessionGroupId as string))
    throw new Error("无效采集 Session");
  if (!(raw.name as string).trim() || !(raw.profileName as string).trim() ||
      !/^profile-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(raw.profileId as string)) throw new Error("无效会话 Profile");
  for (const key of ["startedAt", "updatedAt"])
    if (!Number.isFinite(Date.parse(raw[key] as string))) throw new Error(`无效会话时间：${key}`);
  for (const key of ["endedAt", "archivedAt", "trashedAt"])
    if (raw[key] !== null && (typeof raw[key] !== "string" || !Number.isFinite(Date.parse(raw[key]))))
      throw new Error(`无效会话时间：${key}`);
  if (!["recording", "paused", "stopped", "interrupted"].includes(String(raw.status)))
    throw new Error("无效会话状态");
  if (!["active", "archived", "trashed"].includes(String(raw.libraryState)))
    throw new Error("无效记录管理状态");
  if (["recording", "paused"].includes(String(raw.status)) && raw.libraryState !== "active")
    throw new Error("活动录制不能归档或删除");
  if (raw.libraryState === "trashed") {
    if (!["active", "archived"].includes(String(raw.trashOrigin)) || raw.trashedAt === null)
      throw new Error("无效回收站元数据");
  } else if (raw.trashOrigin !== null || raw.trashedAt !== null) {
    throw new Error("无效回收站元数据");
  }
  const archived = raw.libraryState === "archived" || raw.trashOrigin === "archived";
  if (archived !== (raw.archivedAt !== null)) throw new Error("无效归档元数据");
  for (const key of ["eventCount", "actionCount", "mutationCount", "snapshotCount", "lastSeq", "lastElapsedMs"])
    if (typeof raw[key] !== "number" || !Number.isSafeInteger(raw[key]) || raw[key] < 0)
      throw new Error(`无效会话计数：${key}`);
  return { ...raw } as unknown as SessionMetadata;
}
