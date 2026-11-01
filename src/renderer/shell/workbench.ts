import { createTimeline } from "./timeline";
import { createExportUI } from "./export";
import { formatDate, count, statusName } from "./format";
import { element as el, required, message } from "./dom";
import { svg } from "./icons";
import { ReplayPanel } from "../replay-panel";
import type { AppState } from "../../shared/contracts/ui";
export function startWorkbench(): void {
  document.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
    el.innerHTML = svg(el.dataset.icon);
  });
  const api = window.collector;
  let state: AppState = {
    browser: {
      url: "",
      title: "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
    },
    session: null,
    sessions: [],
    export: null,
  };
  let selectedSessionId: string | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let sessionSignature = "";
  let busy = false;
  let exportToastSessionId: string | null = null;
  let boundsFrame = 0;
  let lastBounds = "";
  const replay = new ReplayPanel(
    api,
    () => {
      renderState();
      scheduleBounds();
    },
    (error) => notify("回放未完成", error.message, true),
  );

  const active = () =>
    state.session && ["recording", "paused"].includes(state.session?.status);
  const selectedSession = () =>
    state.sessions.find((s) => s.id === selectedSessionId) ||
    (state.session?.id === selectedSessionId ? state.session : null);
  const timeline = createTimeline(api, replay, {
    sessionId: () => selectedSessionId,
    selectedSession,
    state: () => state,
    active,
    notify,
  });
  const exportUI = createExportUI(api, {
    sessionId: () => selectedSessionId,
    selectedSession,
    state: () => state,
    renderState,
    showDialog,
    closeDialog,
    notify,
  });

  function notify(
    title: string,
    message = "",
    error = false,
    sessionId: string | null = null,
  ) {
    clearTimeout(toastTimer);
    el("toast-title", "strong").textContent = title;
    el("toast-message", "span").textContent = message;
    el("toast", "div").classList.toggle("error", error);
    el("toast-icon", "span").innerHTML = svg(error ? "info" : "check");
    el("toast-action", "button").hidden = !sessionId;
    exportToastSessionId = sessionId;
    el("toast", "div").hidden = false;
    toastTimer = setTimeout(
      () => {
        el("toast", "div").hidden = true;
      },
      error ? 9000 : 6500,
    );
  }

  async function run<T>(task: () => Promise<T>): Promise<T | undefined> {
    try {
      return await task();
    } catch (error) {
      notify(
        "操作未完成",
        message(error).replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
        true,
      );
      return undefined;
    }
  }

  function scheduleBounds() {
    cancelAnimationFrame(boundsFrame);
    boundsFrame = requestAnimationFrame(() => {
      const rect = el("browser-surface", "div").getBoundingClientRect();
      const bounds = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
        visible:
          !replay.active &&
          !document.querySelector("dialog[open]") &&
          !document.hidden,
      };
      const signature = JSON.stringify(bounds);
      if (signature === lastBounds) return;
      lastBounds = signature;
      el("viewport-size", "span").textContent =
        `${bounds.width} × ${bounds.height}`;
      Promise.resolve(api?.setBrowserBounds(bounds)).catch((error) =>
        console.error("Browser layout:", error),
      );
    });
  }

  function showDialog(dialog: HTMLDialogElement) {
    dialog.showModal();
    scheduleBounds();
  }

  function closeDialog(dialog: HTMLDialogElement) {
    dialog.close();
    scheduleBounds();
  }

  function newSession() {
    if (active() || busy) return;
    if (replay.active) replay.close();
    el("session-name-input", "input").value =
      `浏览器采集 · ${new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date())}`;
    showDialog(el("session-dialog", "dialog"));
    el("session-name-input", "input").select();
  }

  function renderSessions() {
    const sig = JSON.stringify([
      selectedSessionId,
      state.sessions.map((s) => [s.id, s.name, s.status, s.startedAt]),
    ]);
    if (sig === sessionSignature) return;
    sessionSignature = sig;
    el("session-total", "span").textContent = String(state.sessions.length);
    const fragment = document.createDocumentFragment();
    if (!state.sessions.length) {
      const empty = document.createElement("div");
      empty.className = "sidebar-empty";
      empty.textContent = "暂无会话";
      fragment.append(empty);
    }
    [...state.sessions]
      .sort(
        (a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      )
      .forEach((session) => {
        const button = document.createElement("button");
        button.className = `session-item${session.id === selectedSessionId ? " selected" : ""}`;
        button.title = session.name;
        button.setAttribute(
          "aria-pressed",
          String(session.id === selectedSessionId),
        );
        const icon = document.createElement("span");
        icon.className = "session-item-icon";
        icon.innerHTML = svg("document");
        const body = document.createElement("span");
        body.className = "session-item-body";
        const name = document.createElement("span");
        name.className = "session-name";
        name.textContent = session.name || "未命名会话";
        const date = document.createElement("span");
        date.className = "session-date";
        const status = document.createElement("span");
        const dot = document.createElement("i");
        dot.className = `session-state-dot ${session.status}`;
        status.append(dot, statusName(session.status));
        date.append(status, "·", formatDate(session.startedAt));
        body.append(name, date);
        button.append(icon, body);
        button.addEventListener("click", () => selectSession(session.id));
        fragment.append(button);
      });
    el("session-list", "div").replaceChildren(fragment);
  }

  function renderDuration() {
    const session = selectedSession();
    let seconds = 0;
    if (session)
      seconds = Math.max(
        0,
        Math.floor(
          ((session.endedAt
            ? new Date(session.endedAt).getTime()
            : Date.now()) -
            new Date(session.startedAt).getTime()) /
            1000,
        ),
      );
    if (!Number.isFinite(seconds)) seconds = 0;
    el("duration", "strong").textContent =
      seconds >= 3600
        ? `${count(Math.floor(seconds / 3600))}:${count(Math.floor(seconds / 60) % 60)}:${count(seconds % 60)}`
        : `${count(Math.floor(seconds / 60))}:${count(seconds % 60)}`;
  }

  function renderState() {
    const session = selectedSession();
    const browser = state.browser || {};
    const currentActive = active();
    const historical = Boolean(
      currentActive && session && session.id !== state.session?.id,
    );
    const recording = currentActive && state.session?.status === "recording";
    const paused = currentActive && state.session?.status === "paused";
    el("recording-status", "span").className =
      `recording-status${recording ? " recording" : paused ? " paused" : ""}`;
    required(el("recording-status", "span").lastElementChild).textContent =
      recording ? "采集中" : paused ? "已暂停" : "就绪";
    el("recording-status", "span").title = currentActive
      ? `当前录制：${state.session?.name}`
      : "当前没有录制任务";
    el("start-button", "button").hidden = Boolean(currentActive);
    el("start-button", "button").disabled = busy;
    el("new-session-button", "button").disabled =
      Boolean(currentActive) || busy;
    el("pause-button", "button").hidden = !currentActive;
    el("stop-button", "button").hidden = !currentActive;
    el("pause-button", "button").disabled = busy;
    el("stop-button", "button").disabled = busy;
    required(el("pause-button", "button").firstElementChild).innerHTML = svg(
      paused ? "play" : "pause",
    );
    required(el("pause-button", "button").lastElementChild).textContent = paused
      ? "继续"
      : "暂停";
    el("pause-button", "button").title =
      `${paused ? "继续" : "暂停"}：${state.session?.name || "当前会话"}`;
    el("stop-button", "button").title =
      `结束：${state.session?.name || "当前会话"}`;
    el("export-button", "button").disabled = !session || exportUI.busy || busy;
    el("replay-button", "button").disabled = !session?.snapshotCount || busy;
    el("export-button", "button").title = session
      ? `导出所选会话：${session.name}`
      : "先选择一个会话";
    el("snapshot-button", "button").disabled = !recording || busy || historical;
    el("snapshot-button", "button").title = historical
      ? "请先选中正在录制的会话，再捕获快照"
      : recording
        ? `捕获当前页面快照 · ${state.session?.name}`
        : "录制时可捕获当前页面快照";
    el("current-session-name", "strong").textContent =
      session?.name || "未开始采集";
    el("current-session-name", "strong").title = session?.name || "";
    el("current-session-subtitle", "span").hidden = !session;
    el("current-session-subtitle", "span").textContent = session
      ? historical
        ? "查看历史会话 · 录制按钮控制当前采集"
        : `${statusName(session.status)} · ${formatDate(session.startedAt)}`
      : "";
    el("current-session-subtitle", "span").title = historical
      ? `当前录制：${state.session?.name}；统计和导出对应所选历史会话。`
      : "";
    el("action-count", "strong").textContent = (
      session?.actionCount || 0
    ).toLocaleString("zh-CN");
    el("mutation-count", "strong").textContent = (
      session?.mutationCount || 0
    ).toLocaleString("zh-CN");
    el("snapshot-count", "strong").textContent = (
      session?.snapshotCount || 0
    ).toLocaleString("zh-CN");
    el("address-input", "input").title = [browser.title, browser.url]
      .filter(Boolean)
      .join("\n");
    required(document.querySelector(".browser-card")).setAttribute(
      "aria-label",
      browser.title ? `内嵌浏览器：${browser.title}` : "内嵌浏览器",
    );
    if (document.activeElement !== el("address-input", "input"))
      el("address-input", "input").value = browser.url || "";
    el("back-button", "button").disabled = !browser.canGoBack;
    el("forward-button", "button").disabled = !browser.canGoForward;
    el("reload-button", "button").classList.toggle(
      "loading",
      Boolean(browser.loading),
    );
    el("browser-error", "div").hidden = replay.active || !browser.error;
    el("browser-error-text", "span").textContent = browser.error || "";
    el("page-status", "span").textContent = browser.error
      ? "页面加载失败，可修改地址后重试"
      : browser.loading
        ? "页面加载中…"
        : "页面已就绪";
    el("page-status-dot", "i").className = browser.error
      ? "error"
      : browser.loading
        ? "loading"
        : "";
    renderDuration();
    renderSessions();
    scheduleBounds();
  }

  function handleState(next: AppState) {
    const previousSelected = selectedSessionId;
    const previousSession = selectedSession();
    state = next;
    if (!Array.isArray(state.sessions)) state.sessions = [];
    if (state.export) exportUI.update(state.export);
    if (!selectedSessionId || !selectedSession())
      selectedSessionId = state.session?.id || state.sessions[0]?.id || null;
    renderState();
    const current = selectedSession();
    if (previousSelected !== selectedSessionId) timeline.refresh(true);
    else if (
      timeline.follow &&
      current?.eventCount !== previousSession?.eventCount
    )
      timeline.schedule();
  }

  function selectSession(id: string) {
    if (id === selectedSessionId) return;
    selectedSessionId = id;
    timeline.clear();
    el("event-detail", "div").hidden = true;
    renderState();
    timeline.refresh(true);
    if (replay.active) {
      const session = selectedSession();
      if (session?.snapshotCount) replay.open(id, session.name);
      else replay.close();
    }
  }

  el("start-button", "button").addEventListener("click", newSession);
  el("replay-button", "button").addEventListener("click", () => {
    const session = selectedSession();
    if (session?.snapshotCount) replay.open(session.id, session.name);
  });
  el("new-session-button", "button").addEventListener("click", newSession);
  el("session-form", "form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = el("session-name-input", "input").value.trim();
    if (!name || busy) return;
    busy = true;
    el("confirm-session-button", "button").disabled = true;
    renderState();
    const result = await run(() => api.startSession(name));
    busy = false;
    el("confirm-session-button", "button").disabled = false;
    if (result !== undefined) {
      closeDialog(el("session-dialog", "dialog"));
      const next = await run(() => api.getState());
      if (next) {
        handleState(next);
        if (next.session?.id) selectSession(next.session.id);
      }
    }
    renderState();
  });
  el("cancel-session-button", "button").addEventListener("click", () =>
    closeDialog(el("session-dialog", "dialog")),
  );
  el("pause-button", "button").addEventListener("click", async () => {
    if (busy || !active()) return;
    busy = true;
    renderState();
    await run(() =>
      state.session?.status === "paused"
        ? api.resumeSession()
        : api.pauseSession(),
    );
    busy = false;
    const next = await run(() => api.getState());
    if (next) handleState(next);
    renderState();
    timeline.schedule();
  });
  el("stop-button", "button").addEventListener("click", async () => {
    if (busy || !active()) return;
    busy = true;
    renderState();
    const result = await run(() => api.stopSession());
    busy = false;
    const next = await run(() => api.getState());
    if (next) handleState(next);
    renderState();
    timeline.schedule();
    if (result !== undefined)
      notify("采集已结束", "时间线已保存，可导出 ZIP 交给 Agent 分析。");
  });
  el("address-form", "form").addEventListener("submit", (event) => {
    event.preventDefault();
    const url = el("address-input", "input").value.trim();
    if (url) {
      el("address-input", "input").blur();
      run(() => api.navigate(url));
    }
  });
  el("back-button", "button").addEventListener("click", () =>
    run(() => api.back()),
  );
  el("forward-button", "button").addEventListener("click", () =>
    run(() => api.forward()),
  );
  el("reload-button", "button").addEventListener("click", () =>
    run(() => api.reload()),
  );
  el("home-button", "button").addEventListener("click", () =>
    run(() => api.home()),
  );
  el("snapshot-button", "button").addEventListener("click", async () => {
    const result = await run(() => api.snapshot());
    if (result !== undefined)
      notify("已捕获页面快照", "当前 DOM 与表单状态已加入时间线。");
  });
  el("toast-action", "button").addEventListener("click", () => {
    if (exportToastSessionId)
      run(() => api.revealExport(required(exportToastSessionId)));
  });
  el("toast-close", "button").addEventListener("click", () => {
    el("toast", "div").hidden = true;
  });
  el("help-button", "button").addEventListener("click", () =>
    showDialog(el("help-dialog", "dialog")),
  );
  for (const id of ["close-help-button", "help-done-button"])
    el(id, "button").addEventListener("click", () =>
      closeDialog(el("help-dialog", "dialog")),
    );
  document
    .querySelectorAll("dialog")
    .forEach((dialog) => dialog.addEventListener("close", scheduleBounds));
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "/" &&
      !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName ?? "") &&
      !document.querySelector("dialog[open]")
    ) {
      event.preventDefault();
      el("search-input", "input").focus();
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "l" &&
      !document.querySelector("dialog[open]")
    ) {
      event.preventDefault();
      el("address-input", "input").focus();
      el("address-input", "input").select();
    }
  });
  new ResizeObserver(scheduleBounds).observe(el("browser-surface", "div"));
  window.addEventListener("resize", scheduleBounds);
  document.addEventListener("visibilitychange", scheduleBounds);
  setInterval(renderDuration, 1000);
  renderState();
  timeline.render();
  if (!api) {
    notify("桌面环境尚未连接", "请通过 TraceDock 桌面程序启动此工作台。", true);
    return;
  }
  api.onState(handleState);
  api.onEvent((event) => {
    if (
      timeline.follow &&
      (!event.sessionId || event.sessionId === selectedSessionId)
    )
      timeline.schedule();
  });
  api.onError?.((error) => notify("采集器提示", message(error), true));
  api.onExportProgress?.(exportUI.update);
  run(async () => {
    handleState(await api.getState());
    await timeline.refresh();
    scheduleBounds();
  });
}
