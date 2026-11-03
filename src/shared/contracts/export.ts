import type { SessionCapture } from "./storage";
export type ExportEncoding = "delta" | "full";
export type ExportCompression = "deflate" | "store";
export interface ExportOptions {
  encoding?: ExportEncoding | undefined;
  compression?: ExportCompression | undefined;
  /** Add a generated Playwright Test script (script.spec.ts) to the package. */
  script?: boolean | undefined;
}
export interface ExportProgress {
  phase: string;
  sessionId?: string | undefined;
  encoding?: ExportEncoding | undefined;
  compression?: ExportCompression | undefined;
  bytesRead?: number | undefined;
  totalBytes?: number | undefined;
  completed?: number | undefined;
  total?: number | undefined;
  bytesWritten?: number | undefined;
  message?: string | undefined;
}
export interface ExportResult {
  path: string;
  eventCount: number;
  capturedAt: string;
  encoding: ExportEncoding;
  compression: ExportCompression;
  bytes: number;
  timelineBytes: number;
  sha256: string;
  fileCount: number;
  blocks?: number | undefined;
  deltaBlocks?: number | undefined;
}
export interface FileDigest {
  bytes: number;
  sha256: string;
}
export interface FileEntry extends FileDigest {
  path: string;
}
export interface ExportSignals {
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: ExportProgress) => void) | undefined;
}
export type ExportCapture = Pick<
  SessionCapture,
  "metadata" | "timelinePath" | "byteLength" | "capturedAt" | "resourcePath" | "resourceBytes"
>;
export interface PreparedExport extends ExportOptions, ExportSignals {
  capture: ExportCapture;
  sessionId: string;
  destination: string;
  appVersion?: string | undefined;
}
export type WorkerMessage =
  | { type: "progress"; progress: ExportProgress }
  | { type: "result"; result: ExportResult }
  | {
      type: "error";
      error: { name: string; message: string; stack?: string | undefined };
    };
/** Structured-clone transport only: callbacks and AbortSignal stay in the host process. */
export interface ExportWorkerData extends ExportOptions {
  capture: ExportCapture;
  sessionId: string;
  destination: string;
  appVersion?: string | undefined;
}
export type ExportWorkerCommand = { type: 'cancel' };
export type ExportWorkerSend = (message: WorkerMessage) => void;
export type ExportWorkerCommandSend = (message: ExportWorkerCommand) => void;
