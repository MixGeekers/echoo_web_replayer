import type {
  SessionMetadata,
  EventPreview,
  TimelineQuery,
  TimelinePage,
  ReplayQuery,
  ChunkQuery,
  ReplaySeekResult,
  ReplayChunkResult,
  DetailPreview,
  StoredEvent,
} from "./storage";
import type { ExportProgress, ExportResult } from "./export";
import type { ResourceSummary } from "./resources";
export type {
  SessionMetadata,
  EventPreview,
  TimelineQuery,
  ExportProgress,
  ExportResult,
};
export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
}
export interface AppState {
  browser: BrowserState;
  session: SessionMetadata | null;
  sessions: SessionMetadata[];
  export: ExportProgress | null;
}
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}
export interface EventNotice {
  id: string;
  seq: number;
  type: string;
  timestamp: string;
  elapsedMs: number;
  sessionId: string;
}
export type EventDetail = DetailPreview | StoredEvent;
export interface ExportOptions {
  encoding: "delta" | "full";
  compression: "deflate" | "store";
}
export interface CollectorAPI {
  getState(): Promise<AppState>;
  getTimeline(input: TimelineQuery): Promise<TimelinePage>;
  getEvent(input: {
    sessionId: string;
    eventId: string;
    preview?: boolean;
    maxBytes?: number;
  }): Promise<EventDetail>;
  replaySeek(input: ReplayQuery): Promise<ReplaySeekResult>;
  replayChunk(input: ChunkQuery): Promise<ReplayChunkResult>;
  replayResources(input: {
    sessionId: string;
    endSeq?: number;
  }): Promise<ResourceSummary>;
  navigate(url: string): Promise<{ url: string }>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  home(): Promise<{ url: string }>;
  startSession(name: string): Promise<SessionMetadata>;
  pauseSession(): Promise<SessionMetadata>;
  resumeSession(): Promise<SessionMetadata>;
  stopSession(): Promise<SessionMetadata | null>;
  snapshot(): Promise<SessionMetadata>;
  exportSession(
    input: ExportOptions & { sessionId: string },
  ): Promise<{ canceled: true } | ({ canceled: false } & ExportResult)>;
  cancelExport(): Promise<{ canceled: boolean }>;
  revealExport(sessionId: string): Promise<void>;
  setBrowserBounds(bounds: BrowserBounds): void;
  onState(callback: (state: AppState) => void): () => void;
  onEvent(callback: (event: EventNotice) => void): () => void;
  onError(callback: (error: string) => void): () => void;
  onExportProgress(callback: (progress: ExportProgress) => void): () => void;
}
declare global {
  interface Window {
    collector: CollectorAPI;
  }
}
