export type {
  CollectorAPI,
  AppState,
  BrowserState,
  EventNotice,
  BrowserBounds,
} from "./ui";
import type { CollectorAPI } from "./ui";
export type InvokeChannel =
  | "getState"
  | "getTimeline"
  | "getEvent"
  | "replaySeek"
  | "replayChunk"
  | "replayResources"
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "home"
  | "startSession"
  | "pauseSession"
  | "resumeSession"
  | "stopSession"
  | "snapshot"
  | "exportSession"
  | "cancelExport"
  | "revealExport";
export type InvokeArgs<K extends InvokeChannel> = Parameters<CollectorAPI[K]>;
export type InvokeResult<K extends InvokeChannel> = Awaited<
  ReturnType<CollectorAPI[K]>
>;
