import type { ProfileMetadata } from "./profile";
import type { SessionGroupMetadata } from "./session-group";
export type { SessionGroupMetadata } from "./session-group";
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
import type { LibraryBatchInput } from "./library";
import type { MCPState, MCPCommand, MCPConfig } from "./mcp";
import type { AnnotationAPI, ExportRange } from "./annotations";
export type { LibraryBatchAction, LibraryBatchInput } from "./library";
export type {
  SessionMetadata,
  EventPreview,
  TimelineQuery,
  ExportProgress,
  ExportResult,
};
export interface BrowserState {
  available: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
}
export interface AppState {
  mcp?: MCPState;
  profiles: ProfileMetadata[];
  sessionGroups: SessionGroupMetadata[];
  activeProfileId: string | null;
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
  range?: ExportRange | undefined;
}
export interface CollectorAPI extends AnnotationAPI {
  mcpCommand(input: MCPCommand): Promise<AppState>;
  mcpConfig(): Promise<MCPConfig>;
  getState(): Promise<AppState>;
  batchLibrary(input: LibraryBatchInput): Promise<AppState>;
  createSessionGroup(input: {profileId: string; name: string}): Promise<AppState>;
  renameSessionGroup(input: {sessionGroupId: string; name: string}): Promise<AppState>;
  closeSessionGroup(sessionGroupId: string): Promise<AppState>;
  reopenSessionGroup(sessionGroupId: string): Promise<AppState>;
  archiveSessionGroup(sessionGroupId: string): Promise<AppState>;
  unarchiveSessionGroup(sessionGroupId: string): Promise<AppState>;
  trashSessionGroup(sessionGroupId: string): Promise<AppState>;
  restoreSessionGroup(sessionGroupId: string): Promise<AppState>;
  deleteSessionGroup(sessionGroupId: string): Promise<AppState>;
  createProfile(name: string): Promise<AppState>;
  renameProfile(input: {profileId: string; name: string}): Promise<AppState>;
  switchProfile(profileId: string): Promise<AppState>;
  closeProfile(): Promise<AppState>;
  deleteProfile(profileId: string): Promise<AppState>;
  clearProfileData(input: {profileId: string; kind: "cache" | "storage"}): Promise<AppState>;
  renameSession(input: {sessionId: string; name: string}): Promise<AppState>;
  archiveSession(sessionId: string): Promise<AppState>;
  unarchiveSession(sessionId: string): Promise<AppState>;
  trashSession(sessionId: string): Promise<AppState>;
  restoreSession(sessionId: string): Promise<AppState>;
  deleteSession(sessionId: string): Promise<AppState>;
  setReplaySession(sessionId: string | null): Promise<void>;
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
  startSession(input: {sessionGroupId: string; name: string}): Promise<SessionMetadata>;
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
