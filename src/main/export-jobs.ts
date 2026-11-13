import { app, dialog } from "electron";
import type { BrowserWindow } from "electron";
import path from "node:path";
import { exportSession } from "./export/job";
import type { SessionStore } from "./storage/session-store";
import type { RecordingController } from "./recording";
import type {
  ExportOptions,
  ExportProgress,
  ExportResult,
} from "../shared/contracts/export";
import { errorMessage, object } from "../shared/runtime";
import { readAnnotationFile } from "./storage/annotation-store";
export interface ExportRequest extends ExportOptions {
  sessionId: string;
}
export type ExportOutcome =
  | { canceled: true }
  | ({ canceled: false } & ExportResult);
interface ExportJob {
  sessionId: string;
  controller: AbortController;
  progress: ExportProgress;
  promise: Promise<ExportOutcome>;
}
export function createExportJobs(
  win: BrowserWindow,
  store: SessionStore,
  recording: Pick<RecordingController, "currentSession" | "checkpoint"> & {
    serialize<T>(operation: () => T | Promise<T>): Promise<T>;
  },
  notify: () => void,
  publish: (progress: ExportProgress) => void,
) {
  let activeExport: ExportJob | null = null;
  const { serialize, currentSession, checkpoint } = recording;
  function publishExport(job: ExportJob, progress: ExportProgress) {
    job.progress = { ...job.progress, ...progress, sessionId: job.sessionId };
    publish(job.progress);
  }
  function canceledExport() {
    const error = new Error("导出已取消");
    object(error).name = "AbortError";
    return error;
  }
  async function exportRecording(
    input: ExportRequest,
    job: ExportJob,
    destination?: string,
  ): Promise<ExportOutcome> {
    const { sessionId, encoding, compression, range, script } = input;
    const selected = store.getSession(sessionId);
    if (selected.libraryState === "trashed") throw new Error("请先从回收站恢复会话");
    const result = destination ? {canceled: false, filePath: destination} : await dialog.showSaveDialog(win, {
      title: "导出 Agent 分析包",
      defaultPath: path.join(
        app.getPath("downloads"),
        `TraceDock-${sessionId}.zip`,
      ),
      filters: [{ name: "ZIP 分析包", extensions: ["zip"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true as const };
    if (job.controller.signal.aborted) throw canceledExport();
    publishExport(job, { phase: "preparing", bytesRead: 0, totalBytes: 0 });
    // Only the checkpoint and capture share the recording command queue. Encoding
    // runs in a worker after this immutable boundary so pause/stop remain usable.
    const capture = await serialize(async () => {
      if (job.controller.signal.aborted) throw canceledExport();
      if (
        sessionId === currentSession()?.id &&
        currentSession()?.status === "recording"
      )
        await checkpoint("snapshot", "export");
      const boundary = await store.capture(sessionId);
      // Annotations are read at the same boundary; the worker clips them to the exported seqs.
      const annotations = await readAnnotationFile(store.getSessionDirectory(sessionId), sessionId);
      return { ...boundary, annotations };
    });
    if (job.controller.signal.aborted) throw canceledExport();
    let lastProgressAt = 0;
    const exported = await exportSession({
      capture,
      sessionId,
      destination: result.filePath,
      appVersion: app.getVersion(),
      encoding,
      compression,
      range,
      script,
      signal: job.controller.signal,
      onProgress: (progress) => {
        const now = Date.now();
        if (
          progress.phase !== job.progress.phase ||
          now - lastProgressAt >= 100 ||
          progress.bytesRead === progress.totalBytes
        ) {
          lastProgressAt = now;
          publishExport(job, progress);
        }
      },
    });
    await store.update(sessionId, { lastExportPath: exported.path, lastExportAt: new Date().toISOString() });
    notify();
    return { canceled: false, ...exported };
  }
  function startExport(input: ExportRequest, destination?: string): Promise<ExportOutcome> {
    if (activeExport) throw new Error("已有导出任务正在运行");
    const options = { ...input };
    options.encoding ??= "delta";
    options.compression ??= "deflate";
    if (
      !["delta", "full"].includes(options.encoding) ||
      !["deflate", "store"].includes(options.compression)
    )
      throw new Error("无效的导出选项");
    if (store.getSession(options.sessionId).libraryState === "trashed")
      throw new Error("请先从回收站恢复会话");
    const job: ExportJob = {
      sessionId: options.sessionId,
      controller: new AbortController(),
      promise: Promise.resolve({ canceled: true }),
      progress: {
        phase: destination ? "preparing" : "selecting",
        sessionId: options.sessionId,
        encoding: options.encoding,
        compression: options.compression,
      },
    };
    activeExport = job;
    job.promise = exportRecording(options, job, destination)
      .then(
        (result) => {
          publishExport(job, { phase: result.canceled ? "canceled" : "done" });
          return result;
        },
        (error) => {
          if (
            job.controller.signal.aborted ||
            object(error).name === "AbortError"
          ) {
            publishExport(job, { phase: "canceled" });
            return { canceled: true as const };
          }
          publishExport(job, { phase: "error", message: errorMessage(error) });
          throw error;
        },
      )
      .finally(() => {
        if (activeExport === job) activeExport = null;
        notify();
      });
    return job.promise;
  }

  return {
    startExport,
    startExportTo: (input: ExportRequest, destination: string) => {
      if (!path.isAbsolute(destination)) throw new Error("导出路径必须为绝对路径");
      return startExport(input, destination);
    },
    progress: () => (activeExport ? { ...activeExport.progress } : null),
    waitForIdle: async () => { await activeExport?.promise.catch(() => {}); },
    cancel: () => {
      activeExport?.controller.abort();
      return { canceled: Boolean(activeExport) };
    },
    close: async () => {
      const job = activeExport;
      job?.controller.abort();
      await job?.promise.catch(() => {});
    },
  };
}
