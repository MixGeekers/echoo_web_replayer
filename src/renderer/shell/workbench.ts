import { createLifecycleUI } from "./lifecycle";
import { createTimeline } from "./timeline";
import { createExportUI } from "./export";
import { createMCPUI } from "./mcp";
import { createCodegenUI } from "./codegen";
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
      available: false,
      url: "",
      title: "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
    },
    profiles: [],
    activeProfileId: null,
    session: null,
    sessions: [],
    sessionGroups: [],
    export: null,
  };
  let selectedSessionId: string | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let sessionSignature = "";
  let recordingGroupId = "";
  const collapsedGroups = new Set<string>();
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
    sessionId: () => selectedSession() && lifecycle.effectiveState(selectedSession()!) === "trashed" ? null : selectedSessionId,
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

  const lifecycle = createLifecycleUI({
    state: () => state,
    selectedSession,
    busy: () => busy,
    setBusy: value => { busy = value; renderState(); },
    update: handleState,
    changed: () => {
      void replay.close().catch(error => notify("操作未完成", message(error), true));
      selectedSessionId = null;
      timeline.clear();
      void timeline.refresh(true);
      handleState(state);
    },
    repaint: renderState,
    closeReplay: () => replay.close(),
    replaySessionId: () => replay.sessionId,
    showDialog,
    closeDialog,
    notify,
  });
  const codegenUI = createCodegenUI(api, {
    sessionId: () => selectedSession() && lifecycle.effectiveState(selectedSession()!) === "trashed" ? null : selectedSessionId,
    selectedSession,
    showDialog,
    closeDialog,
    notify,
  });
  const mcp = createMCPUI(api, {
    state: () => state,
    update: handleState,
    boundsChanged: scheduleBounds,
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
          state.browser.available &&
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

  async function newSession() {
    if (active() || busy || mcp.controlled() || !lifecycle.canCapture()) return;
    if (replay.active) await replay.close();
    recordingGroupId = lifecycle.selectedGroupId;
    el("recording-parent-label", "p").textContent = `保存到 Session：${lifecycle.selectedGroup()?.name || ""}`;
    el("session-name-input", "input").value =
      `浏览器采集 · ${new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date())}`;
    showDialog(el("session-dialog", "dialog"));
    el("session-name-input", "input").select();
  }

  function renderSessions() {
    const sig = JSON.stringify([
      selectedSessionId, lifecycle.selectedGroupId, lifecycle.scope, lifecycle.profileFilter,
      [...collapsedGroups], state.sessionGroups, lifecycle.library.signature,
      state.sessions.map(s => [s.id, s.name, s.status, s.startedAt, s.libraryState, s.sessionGroupId]),
    ]);
    if (sig === sessionSignature) return;
    sessionSignature = sig;
    const groups = lifecycle.visibleGroups(), records = lifecycle.visibleSessions();
    el("session-total", "span").textContent = String(groups.length);
    const fragment = document.createDocumentFragment();
    if (!groups.length) {
      const empty = document.createElement("div");
      empty.className = "sidebar-empty";
      empty.textContent = lifecycle.library.hasFilters ? "没有匹配的内容" : lifecycle.scope === "trashed" ? "回收站为空" : lifecycle.scope === "archived" ? "暂无归档内容" : "还没有 Session";
      if (lifecycle.library.hasFilters) {
        const reset = document.createElement("button"); reset.type = "button"; reset.className = "text-button"; reset.textContent = "清除筛选";
        reset.addEventListener("click", lifecycle.library.resetFilters); empty.append(reset);
      }
      fragment.append(empty);
    }
    for (const group of groups) {
      const section = document.createElement("section");
      section.className = `session-group${group.id === lifecycle.selectedGroupId ? " current" : ""}`;
      section.dataset.sessionGroupId = group.id;
      const children = records.filter(record => record.sessionGroupId === group.id);
      const row = document.createElement("div"); row.className = "session-group-row";
      const toggle = document.createElement("button");
      toggle.type = "button"; toggle.className = "session-group-toggle icon-button";
      toggle.innerHTML = svg("chevron-down");
      const expanded = lifecycle.library.hasFilters || !collapsedGroups.has(group.id);
      toggle.disabled = lifecycle.library.hasFilters;
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute("aria-label", `${expanded ? "折叠" : "展开"} ${group.name}`);
      toggle.addEventListener("click", () => {
        if (collapsedGroups.has(group.id)) collapsedGroups.delete(group.id); else collapsedGroups.add(group.id);
        renderSessions();
      });
      const button = document.createElement("button");
      button.type = "button"; button.className = `session-group-select${group.id === lifecycle.selectedGroupId && !selectedSessionId ? " selected" : ""}`;
      button.dataset.sessionGroupId = group.id; button.title = group.name;
      button.setAttribute("aria-pressed", String(group.id === lifecycle.selectedGroupId && !selectedSessionId));
      const name = document.createElement("span"); name.className = "group-name"; name.textContent = group.name;
      const meta = document.createElement("span"); meta.className = "group-row-meta";
      meta.textContent = `${group.libraryState === "trashed" ? "已删除" : group.libraryState === "archived" ? "已归档" : group.status === "closed" ? "已关闭" : "已打开"} · ${children.length} 条${lifecycle.library.hasFilters ? "匹配" : ""}记录`;
      button.append(name, meta);
      if (lifecycle.library.allProfiles) {
        const source = document.createElement("span"); source.className = "group-profile-source";
        source.textContent = lifecycle.profileName(group.profileId, group.profileName); source.title = source.textContent; button.append(source);
      }
      button.addEventListener("click", () => {
        lifecycle.chooseGroup(group.id); collapsedGroups.delete(group.id);
        selectedSessionId = null; timeline.clear();
        void timeline.refresh(true);
        void replay.close().catch(error => notify("操作未完成", message(error), true));
        handleState(state);
      });
      if (lifecycle.library.selecting) row.append(lifecycle.library.groupCheckbox(group.id, group.name));
      row.append(toggle, button); section.append(row);
      const branch = document.createElement("div"); branch.className = "session-group-records"; branch.hidden = !expanded;
      for (const session of children) {
        const item = document.createElement("button");
        item.type = "button"; item.className = `session-item${session.id === selectedSessionId ? " selected" : ""}`;
        item.dataset.recordingId = session.id; item.title = session.name;
        item.setAttribute("aria-pressed", String(session.id === selectedSessionId));
        const icon = document.createElement("span"); icon.className = "session-item-icon"; icon.innerHTML = svg("document");
        const body = document.createElement("span"); body.className = "session-item-body";
        const name = document.createElement("span"); name.className = "session-name"; name.textContent = session.name;
        const date = document.createElement("span"); date.className = "session-date";
        const status = document.createElement("span"), dot = document.createElement("i");
        dot.className = `session-state-dot ${session.status}`;
        status.append(dot, statusName(session.status)); date.append(status, "·", formatDate(session.startedAt));
        body.append(name, date); item.append(icon, body);
        item.addEventListener("click", () => selectSession(session.id));
        if (lifecycle.library.selecting) {
          const selectableRow = document.createElement("div"); selectableRow.className = "library-record-row";
          selectableRow.append(lifecycle.library.recordCheckbox(session), item); branch.append(selectableRow);
        } else branch.append(item);
      }
      if (!children.length) {
        const empty = document.createElement("span"); empty.className = "group-empty"; empty.textContent = lifecycle.library.hasFilters ? "无匹配的采集记录" : "暂无采集记录"; branch.append(empty);
      }
      section.append(branch); fragment.append(section);
    }
    const list = el("session-list", "div"), scroll = list.scrollTop;
    const focused = document.activeElement instanceof HTMLInputElement && list.contains(document.activeElement) ?
      {group:document.activeElement.dataset.selectGroup, record:document.activeElement.dataset.selectRecord} : null;
    list.replaceChildren(fragment); list.scrollTop = scroll;
    if (focused) {
      const replacement = [...list.querySelectorAll<HTMLInputElement>(".library-checkbox")].find(input =>
        focused.group ? input.dataset.selectGroup === focused.group : input.dataset.selectRecord === focused.record);
      replacement?.focus({preventScroll:true});
    }
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
    el("start-button", "button").disabled = busy || !lifecycle.canCapture();
    el("start-button", "button").title = lifecycle.canCapture() ? `在 ${lifecycle.selectedGroup()?.name} 中新建采集记录` : lifecycle.scope !== "active" ? "先切换到常用，再选择一个已打开的 Session" : "先选择一个已打开的 Session";
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
    el("export-button", "button").disabled = !session || lifecycle.effectiveState(session) === "trashed" || exportUI.busy || busy;
    el("replay-button", "button").disabled = !session?.snapshotCount || lifecycle.effectiveState(session) === "trashed" || busy;
    codegenUI.render(busy);
    el("export-button", "button").title = session
      ? `导出所选采集记录：${session.name}`
      : "先选择一条采集记录";
    el("snapshot-button", "button").disabled = !recording || busy || historical;
    el("snapshot-button", "button").title = historical
      ? "请先选中正在采集的记录，再捕获快照"
      : recording
        ? `捕获当前页面快照 · ${state.session?.name}`
        : "录制时可捕获当前页面快照";
    el("current-session-name", "strong").textContent =
      session?.name || "未开始采集";
    el("current-session-name", "strong").title = session?.name || "";
    el("current-session-subtitle", "span").hidden = !session;
    el("current-session-subtitle", "span").textContent = session
      ? historical
        ? "查看历史记录 · 采集按钮控制当前任务"
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
    el("browser-placeholder", "div").hidden = browser.available || replay.active;
    el("browser-placeholder", "div").textContent = "浏览环境已关闭 · 从顶部打开或新建 Profile";
    el("address-input", "input").disabled = !browser.available || busy;
    el("reload-button", "button").disabled = !browser.available || busy;
    el("home-button", "button").disabled = !browser.available || busy;
    el("back-button", "button").disabled = !browser.available || !browser.canGoBack;
    el("forward-button", "button").disabled = !browser.available || !browser.canGoForward;
    el("reload-button", "button").classList.toggle(
      "loading",
      Boolean(browser.loading),
    );
    el("browser-error", "div").hidden = replay.active || !browser.error;
    el("browser-error-text", "span").textContent = browser.error || "";
    el("page-status", "span").textContent = !browser.available ? "浏览环境已关闭" : browser.error
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
    lifecycle.render();
    renderSessions();
    mcp.render();
    scheduleBounds();
  }

  function handleState(next: AppState) {
    const previousSelected = selectedSessionId;
    const previousSession = selectedSession();
    state = next;
    lifecycle.sync();
    if (state.export) exportUI.update(state.export);
    if (selectedSessionId && !lifecycle.visibleSessions().some(s => s.id === selectedSessionId && s.sessionGroupId === lifecycle.selectedGroupId)) {
      selectedSessionId = null;
      if (replay.active) void replay.close().catch(error => notify("操作未完成", message(error), true));
    }
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
    lifecycle.chooseSession(id);
    collapsedGroups.delete(lifecycle.selectedGroupId);
    if (id === selectedSessionId) return;
    selectedSessionId = id;
    timeline.clear();
    el("event-detail", "div").hidden = true;
    renderState();
    timeline.refresh(true);
    if (replay.active) {
      const session = selectedSession();
      if (session?.snapshotCount && lifecycle.effectiveState(session) !== "trashed") void replay.open(id, session.name);
      else void replay.close().catch(error => notify("操作未完成", message(error), true));
    }
  }

  el("start-button", "button").addEventListener("click", () => { void run(newSession); });
  el("replay-button", "button").addEventListener("click", () => {
    const session = selectedSession();
    if (session?.snapshotCount && lifecycle.effectiveState(session) !== "trashed") void replay.open(session.id, session.name);
  });
  el("new-recording-button", "button").addEventListener("click", () => { void run(newSession); });
  el("session-form", "form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = el("session-name-input", "input").value.trim();
    if (!name || busy) return;
    busy = true;
    el("confirm-session-button", "button").disabled = true;
    renderState();
    const result = await run(() => api.startSession({sessionGroupId: recordingGroupId, name}));
    busy = false;
    el("confirm-session-button", "button").disabled = false;
    if (result !== undefined) {
      closeDialog(el("session-dialog", "dialog"));
      const next = await run(() => api.getState());
      if (next) {
        state = next;
        if (next.session?.id) {
          lifecycle.library.viewCurrentProfile();
          lifecycle.library.resetFilters();
          lifecycle.chooseSession(next.session.id);
        }
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
      !mcp.panelOpen &&
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
