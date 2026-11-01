import type { ApplicationEventSink } from "../shared/contracts/application";
import type { WebContentsView } from "electron";
import type { BrowserState } from "./recording";
import { errorMessage, errorCode } from "../shared/runtime";
interface Options {
  browser: WebContentsView;
  browserState: BrowserState;
  demoURL: string;
  notify: () => void;
  reportError: (error: unknown) => void;
  record: ApplicationEventSink;
}
export function createBrowserController({
  browser,
  browserState,
  demoURL,
  notify,
  reportError,
  record,
}: Options) {
  function normalizeURL(input: unknown) {
    const raw = String(input || "").trim();
    if (raw === demoURL || raw === "tracedock://demo" || raw === "demo")
      return demoURL;
    if (!raw) throw new Error("请输入网址");
    const candidate =
      /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^/]+:\d+(\/|$)/.test(raw)
        ? raw
        : `https://${raw}`;
    let url;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error("网址格式无效");
    }
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("支持 http:// 和 https:// 网址");
    return url.href;
  }
  async function navigate(input: unknown) {
    const url = normalizeURL(input);
    browserState.error = null;
    browserState.url = url;
    notify();
    // Navigation resolves after the load. Return promptly so a slow site cannot lock the controls.
    browser.webContents.loadURL(url).catch((error) => {
      if (errorCode(error) !== "ERR_ABORTED") {
        browserState.error = errorMessage(error);
        notify();
      }
    });
    return { url };
  }
  function browserEvents() {
    const wc = browser.webContents;
    const refresh = () => {
      browserState.canGoBack = wc.navigationHistory.canGoBack();
      browserState.canGoForward = wc.navigationHistory.canGoForward();
      notify();
    };

    wc.on("did-start-loading", () => {
      browserState.loading = true;
      browserState.error = null;
      refresh();
    });
    wc.on("did-stop-loading", () => {
      browserState.loading = false;
      refresh();
    });
    wc.on("page-title-updated", (_event, title) => {
      browserState.title = title;
      refresh();
    });
    wc.on("did-navigate", (_event, url, httpResponseCode) => {
      browserState.url = url;
      refresh();
      record("page.navigation", { url, httpResponseCode, sameDocument: false });
    });
    wc.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      browserState.url = url;
      refresh();
      record("page.navigation", { url, sameDocument: true });
    });
    wc.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return;
        browserState.loading = false;
        browserState.error = `页面加载失败 (${errorCode})：${errorDescription}`;
        record("page.error", {
          errorCode,
          errorDescription,
          url: validatedURL,
        });
        refresh();
      },
    );
    wc.on("render-process-gone", (_event, details) => {
      browserState.loading = false;
      browserState.error = "页面进程已退出，请刷新页面。";
      record("recorder.error", {
        message: "Browser renderer exited",
        ...details,
        possibleGap: true,
      });
      refresh();
    });
    wc.on("preload-error", (_event, _preloadPath, error) => {
      reportError(error);
      record("recorder.error", {
        message: errorMessage(error),
        possibleGap: true,
      });
    });
    wc.on("will-navigate", (event, url) => {
      try {
        normalizeURL(url);
      } catch {
        event.preventDefault();
        reportError(new Error("已阻止不支持的页面协议"));
      }
    });
    wc.setWindowOpenHandler(({ url }) => {
      record("page.popup", { url, disposition: "opened-in-current-view" });
      navigate(url).catch(reportError);
      return { action: "deny" };
    });
    wc.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    wc.session.setPermissionCheckHandler(() => false);
  }
  return { navigate, normalizeURL, installEvents: browserEvents };
}
