/** Raw persistence accepts arbitrary payloads; replay validates its supported event variants separately. */
export interface EventInput {
  type: string;
  timestamp?: string | undefined;
  url?: string | undefined;
  title?: string | undefined;
  documentId?: string | null | undefined;
  payload?: unknown;
  summary?: string | undefined;
  [key: string]: unknown;
}
export interface StoredEvent extends EventInput {
  id: string;
  sessionId: string;
  seq: number;
  timestamp: string;
  receivedAt: string;
  elapsedMs: number;
  url: string;
  title: string;
  documentId: string | null;
  payload: unknown;
  summary: string;
}
export interface EventPreview {
  seq: number;
  type: string;
  id?: string | undefined;
  sessionId?: string | undefined;
  timestamp?: string | undefined;
  receivedAt?: string | undefined;
  elapsedMs?: number | undefined;
  documentId?: string | null | undefined;
  url?: string | undefined;
  title?: string | undefined;
  summary?: string | undefined;
  payload: unknown;
  payloadTruncated?: boolean | undefined;
  [key: string]: unknown;
}
export type SessionStatus = "recording" | "paused" | "stopped" | "interrupted";
export type LibraryState = "active" | "archived" | "trashed";
export interface SessionMetadata {
  id: string;
  sessionGroupId: string;
  name: string;
  status: SessionStatus;
  profileId: string;
  profileName: string;
  libraryState: LibraryState;
  archivedAt: string | null;
  trashedAt: string | null;
  trashOrigin: "active" | "archived" | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  url: string;
  eventCount: number;
  actionCount: number;
  mutationCount: number;
  snapshotCount: number;
  lastSeq: number;
  lastElapsedMs: number;
  schemaVersion: number;
  recoveryFile?: string | undefined;
  lastExportPath?: string | undefined;
  lastExportAt?: string | undefined;
}
export type SessionPatch = Partial<
  Pick<
    SessionMetadata,
    "name" | "status" | "endedAt" | "lastExportPath" | "lastExportAt" | "url"
  >
>;
export interface SessionCapture {
  metadata: SessionMetadata;
  timelinePath: string;
  byteLength: number;
  capturedAt: string;
  indexCount: number;
  indexGeneration: string;
  categoryCounts: number[];
  resourcePath: string;
  resourceBytes: number;
}
export interface TimelineQuery {
  sessionId: string;
  offset?: number | undefined;
  limit?: number | undefined;
  types?: string[] | undefined;
  query?: string | undefined;
  beforeSeq?: number | undefined;
  afterSeq?: number | undefined;
  snapshotSeq?: number | undefined;
}
export interface TimelinePage {
  events: EventPreview[];
  total: number;
  hasMore: boolean;
  firstSeq: number | null;
  lastSeq: number | null;
  snapshotSeq: number;
  scannedThroughSeq: number | null;
}
export interface ReplayQuery {
  sessionId: string;
  timeMs?: number | undefined;
  targetSeq?: number | undefined;
  endSeq?: number | undefined;
}
export interface ChunkQuery {
  sessionId: string;
  afterSeq?: number | undefined;
  endSeq: number;
  limit?: number | undefined;
  maxBytes?: number | undefined;
}
export interface ReplaySeekResult {
  session: SessionMetadata;
  snapshot: StoredEvent | null;
  afterSeq: number;
  targetSeq: number;
  endSeq: number;
  durationMs: number;
  timeMs: number;
}
export interface ReplayChunkResult {
  events: StoredEvent[];
  afterSeq: number;
  hasMore: boolean;
}
export interface DetailPreview {
  preview: string;
  truncated: boolean;
  bytes: number;
  event: EventPreview;
}
export interface DetailOptions {
  preview?: boolean | undefined;
  maxBytes?: number | undefined;
}
