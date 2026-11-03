import { element as el, message } from "./dom";
import type {
  CollectorAPI,
  AppState,
  SessionMetadata,
  ExportProgress,
  ExportOptions,
} from "../../shared/contracts/ui";
import type { ExportRange } from "../../shared/contracts/annotations";
const phaseLabels: Record<string, string> = {
  selecting: "选择保存位置…", preparing: "准备记录…", prepare: "准备记录…",
  encode: "整理数据", validate: "校验记录", derive: "生成阅读材料",
  archive: "生成 ZIP", complete: "完成校验…", writing: "写入分析包…",
};
export const exportProgressLabel = (phase: string) => phaseLabels[phase] || "正在导出…";
interface Options {
  sessionId(): string | null;
  selectedSession(): SessionMetadata | null | undefined;
  state(): AppState;
  renderState(): void;
  showDialog(dialog: HTMLDialogElement): void;
  closeDialog(dialog: HTMLDialogElement): void;
  notify(
    title: string,
    message?: string,
    error?: boolean,
    sessionId?: string | null,
  ): void;
  /** Optional slice chosen in the dialog; undefined exports the whole recording. */
  range?(): ExportRange | undefined;
}
export function createExportUI(api: CollectorAPI, options: Options) {
  async function run<T>(task: () => Promise<T>): Promise<T | undefined> {
    try {
      return await task();
    } catch (error) {
      options.notify("操作未完成", message(error), true);
      return undefined;
    }
  }
  let exporting = false;
  let exportSessionId: string | null = null;
  let exportCancelRequested = false;
  let exportOptions: ExportOptions = {
    encoding: "delta",
    compression: "deflate",
  };
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem("tracedock.exportOptions") || "null",
    );
    if (
      saved &&
      typeof saved === "object" &&
      "encoding" in saved &&
      "compression" in saved &&
      (saved.encoding === "delta" || saved.encoding === "full") &&
      (saved.compression === "deflate" || saved.compression === "store")
    )
      exportOptions = {
        encoding: saved.encoding,
        compression: saved.compression,
      };
  } catch {}
  function updateExportProgress(progress: ExportProgress) {
    if (!progress) return;
    const terminal = ["done", "canceled", "error"].includes(progress.phase);
    if (terminal) {
      exporting = false;
      el("export-progress", "div").hidden = true;
      options.renderState();
      return;
    }
    exporting = true;
    exportSessionId = progress.sessionId || exportSessionId;
    el("export-progress", "div").hidden = false;
    const label = exportProgressLabel(progress.phase);
    const total = Number(progress.totalBytes || progress.total || 0);
    const completed = Number(progress.bytesRead ?? progress.completed ?? 0);
    const ratio =
      total > 0 ? Math.max(0, Math.min(1, completed / total)) : null;
    el("export-progress-label", "span").textContent = exportCancelRequested
      ? "正在取消导出…"
      : `${label}${ratio === null ? "" : ` · ${Math.floor(ratio * 100)}%`}`;
    el("export-progress-label", "span").title =
      options.state().sessions.find((s) => s.id === exportSessionId)?.name ||
      "";
    const bar = el("export-progress-bar", "progress");
    if (ratio === null) bar.removeAttribute("value");
    else {
      bar.max = 1;
      bar.value = ratio;
    }
    el("cancel-export-button", "button").disabled =
      exportCancelRequested ||
      progress.phase === "selecting" ||
      progress.phase === "complete";
    options.renderState();
  }

  el("export-button", "button").addEventListener("click", () => {
    if (!options.sessionId() || exporting) return;
    exportSessionId = options.sessionId();
    el("export-session-name", "p").textContent =
      options.selectedSession()?.name || "";
    el("export-mode-delta", "input").checked =
      exportOptions.encoding === "delta";
    el("export-mode-full", "input").checked = exportOptions.encoding === "full";
    el("export-compression", "input").checked =
      exportOptions.compression === "deflate";
    options.showDialog(el("export-dialog", "dialog"));
  });
  el("cancel-export-dialog-button", "button").addEventListener("click", () =>
    options.closeDialog(el("export-dialog", "dialog")),
  );
  el("export-form", "form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!exportSessionId || exporting) return;
    const sessionId = exportSessionId;
    const range = options.range?.();
    exportOptions = {
      encoding: el("export-mode-full", "input").checked ? "full" : "delta",
      compression: el("export-compression", "input").checked
        ? "deflate"
        : "store",
    };
    try {
      localStorage.setItem(
        "tracedock.exportOptions",
        JSON.stringify(exportOptions),
      );
    } catch {}
    options.closeDialog(el("export-dialog", "dialog"));
    exportCancelRequested = false;
    updateExportProgress({ sessionId, phase: "selecting" });
    const result = await run(() =>
      api.exportSession({ sessionId, ...exportOptions, ...(range ? { range } : {}) }),
    );
    exporting = false;
    el("export-progress", "div").hidden = true;
    options.renderState();
    if (result?.canceled) options.notify("已取消导出", "已有文件未改变。");
    else if (result && !result.canceled)
      options.notify(
        "ZIP 导出成功",
        result.path || "数据、还原脚本和 Agent 说明已打包。",
        false,
        sessionId,
      );
    exportCancelRequested = false;
  });
  el("cancel-export-button", "button").addEventListener("click", async () => {
    if (!exporting || exportCancelRequested) return;
    exportCancelRequested = true;
    el("cancel-export-button", "button").disabled = true;
    el("export-progress-label", "span").textContent = "正在取消导出…";
    const result = await run(() => api.cancelExport());
    if (result === undefined) {
      exportCancelRequested = false;
      el("cancel-export-button", "button").disabled = false;
    }
  });
  return {
    get busy() {
      return exporting;
    },
    update: updateExportProgress,
  };
}
