import { Worker } from "node:worker_threads";
import * as path from "node:path";
import type {
  ExportOptions,
  ExportSignals,
  ExportResult,
  ExportCapture,
  WorkerMessage,
} from "../../shared/contracts/export";
import type { SessionStore } from "../storage/session-store";
import { checkAbort } from "./delta-codec";
import { validateOptions } from "./options";
interface PreparedExportOptions extends ExportOptions, ExportSignals {
  store?: SessionStore | undefined;
  sessionId: string;
  capture?: ExportCapture | undefined;
  destination: string;
  appVersion?: string | undefined;
}
export { agentReadme } from "./readme";
export { runPreparedExport } from "./pipeline";
export { validateOptions } from "./options";
export async function exportSession({
  store,
  sessionId,
  capture,
  destination,
  appVersion = "0.2.0",
  encoding = "delta",
  compression = "deflate",
  signal,
  onProgress,
}: PreparedExportOptions): Promise<ExportResult> {
  validateOptions({ encoding, compression });
  checkAbort(signal);
  if (!destination || typeof destination !== "string")
    throw new Error("请选择 ZIP 导出路径");
  const boundary =
    capture || (store ? await store.capture(sessionId) : undefined);
  checkAbort(signal);
  if (!boundary?.metadata || boundary.metadata.id !== sessionId)
    throw new Error("导出截点与会话不一致");
  return new Promise<ExportResult>((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "export-worker.cjs"), {
      workerData: {
        capture: {
          metadata: boundary.metadata,
          timelinePath: boundary.timelinePath,
          byteLength: boundary.byteLength,
          capturedAt: boundary.capturedAt,
          resourcePath: boundary.resourcePath,
          resourceBytes: boundary.resourceBytes,
        },
        sessionId,
        destination,
        appVersion,
        encoding,
        compression,
      },
    });
    let settled = false;
    const cancel = () => worker.postMessage({ type: "cancel" });
    const finish = (error: Error | null, result?: ExportResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("导出工作线程没有返回结果"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "progress") {
        try {
          onProgress?.(message.progress);
        } catch {
          /* Consumer rendering cannot break an export. */
        }
      } else if (message.type === "result") finish(null, message.result);
      else if (message.type === "error") {
        const error = new Error(message.error.message);
        error.name = message.error.name || "Error";
        if (message.error.stack) error.stack = message.error.stack;
        finish(error);
      }
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (!settled) finish(new Error(`导出工作线程提前退出 (${code})`));
    });
  });
}
