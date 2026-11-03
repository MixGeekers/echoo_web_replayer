/** Per-recording bookmarks and notes. Stored beside, never inside, the timeline facts. */
export type AnnotationAuthor = "user" | "agent";
export interface Annotation {
  id: string;
  /** Anchor event seq. */
  seq: number;
  /** Optional inclusive range end; null for a single-event bookmark. */
  endSeq: number | null;
  text: string;
  author: AnnotationAuthor;
  createdAt: string;
  updatedAt: string;
  /** Copied from the anchor event when the note was created, for quick reading. */
  elapsedMs: number;
  timestamp: string;
  eventType: string;
}
export interface AnnotationSet {
  format: "tracedock-annotations";
  schemaVersion: 1;
  recordingId: string;
  /** Incremented on every successful write; pass back as expectedRevision. */
  revision: number;
  annotations: Annotation[];
}
export interface AnnotationCreateInput {
  sessionId: string;
  seq: number;
  endSeq?: number | null | undefined;
  text?: string | undefined;
  expectedRevision?: number | undefined;
}
export interface AnnotationUpdateInput {
  sessionId: string;
  annotationId: string;
  text?: string | undefined;
  endSeq?: number | null | undefined;
  expectedRevision?: number | undefined;
}
export interface AnnotationDeleteInput {
  sessionId: string;
  annotationId: string;
  expectedRevision?: number | undefined;
}
export interface AnnotationChange {
  sessionId: string;
  revision: number;
}
export type AnnotationResult = AnnotationSet & { annotation: Annotation | null };
/** Optional export slice. Seq bounds win over elapsed-time bounds when both are set. */
export interface ExportRange {
  startSeq?: number | undefined;
  endSeq?: number | undefined;
  startMs?: number | undefined;
  endMs?: number | undefined;
}
export interface ResolvedExportRange {
  requestedStartSeq: number;
  requestedEndSeq: number;
  /** First exported seq: the nearest dom.snapshot at or before the requested start, else the first event. */
  startSeq: number;
  endSeq: number;
  baselineSnapshotSeq: number | null;
  startByte: number;
  endByte: number;
  startElapsedMs: number;
  endElapsedMs: number;
  sourceEventCount: number;
  sourceLastSeq: number;
  sourceTimelineBytes: number;
  eventCount: number;
  actionCount: number;
  mutationCount: number;
  snapshotCount: number;
}
export interface AnnotationAPI {
  listAnnotations(sessionId: string): Promise<AnnotationSet>;
  createAnnotation(input: AnnotationCreateInput): Promise<AnnotationResult>;
  updateAnnotation(input: AnnotationUpdateInput): Promise<AnnotationResult>;
  deleteAnnotation(input: AnnotationDeleteInput): Promise<AnnotationResult>;
  /** Bookmark the latest seq of the active recording with a default note. */
  markAnnotation(input?: { text?: string }): Promise<AnnotationResult>;
  onAnnotations(callback: (change: AnnotationChange) => void): () => void;
}
export type AnnotationChannel =
  | "listAnnotations"
  | "createAnnotation"
  | "updateAnnotation"
  | "deleteAnnotation"
  | "markAnnotation";
export const DEFAULT_MARK_TEXT = "这里有问题";
export const ANNOTATION_TEXT_LIMIT = 2000;
export const ANNOTATION_COUNT_LIMIT = 1000;
