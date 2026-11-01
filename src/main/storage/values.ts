import type {
  EventPreview,
  SessionMetadata,
  SessionStatus,
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
/** Normalize legacy envelope omissions without interpreting or copying its arbitrary payload. */
export function storedEvent(
  value: unknown,
  fallbackSessionId = "",
): StoredEvent {
  const { raw, seq, type } = envelope(value);
  const sessionId = optionalString(raw.sessionId) ?? fallbackSessionId;
  const timestamp = optionalString(raw.timestamp) ?? "";
  return {
    ...raw,
    seq,
    type,
    sessionId,
    id:
      optionalString(raw.id) ?? `${sessionId}:${String(seq).padStart(8, "0")}`,
    timestamp,
    receivedAt: optionalString(raw.receivedAt) ?? timestamp,
    elapsedMs: finiteNumber(raw.elapsedMs) ?? 0,
    documentId: optionalString(raw.documentId) ?? null,
    url: optionalString(raw.url) ?? "",
    title: optionalString(raw.title) ?? "",
    summary: optionalString(raw.summary) ?? "",
    payload: raw.payload,
  };
}
export function sessionMetadata(value: unknown): SessionMetadata {
  const raw = object(value);
  if (
    typeof raw.id !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.startedAt !== "string"
  )
    throw new Error("无效会话元数据");
  let status: SessionStatus;
  switch (raw.status) {
    case "recording":
    case "paused":
    case "stopped":
    case "interrupted":
      status = raw.status;
      break;
    default:
      throw new Error("无效会话状态");
  }
  const count = (key: string, fallback?: number) => {
    const value = raw[key] ?? fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new Error(`无效会话计数：${key}`);
    return value;
  };
  return {
    ...raw,
    id: raw.id,
    name: raw.name,
    startedAt: raw.startedAt,
    status,
    updatedAt: optionalString(raw.updatedAt) ?? raw.startedAt,
    endedAt: optionalString(raw.endedAt) ?? null,
    url: optionalString(raw.url) ?? "",
    eventCount: count("eventCount"),
    actionCount: count("actionCount"),
    mutationCount: count("mutationCount"),
    snapshotCount: count("snapshotCount"),
    lastSeq: count("lastSeq"),
    lastElapsedMs: count("lastElapsedMs", 0),
    schemaVersion: count("schemaVersion", 1),
    recoveryFile: optionalString(raw.recoveryFile),
    lastExportPath: optionalString(raw.lastExportPath),
    lastExportAt: optionalString(raw.lastExportAt),
  };
}
