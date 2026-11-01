import type { AppState, SessionMetadata } from "../../shared/contracts/ui";
import { element as el, required, message } from "./dom";
import { svg } from "./icons";
import { createLibraryUI } from "./library";

type LibraryState = SessionMetadata["libraryState"];
interface Options {
  state(): AppState;
  selectedSession(): SessionMetadata | null | undefined;
  busy(): boolean;
  setBusy(value: boolean): void;
  update(state: AppState): void;
  changed(): void;
  repaint(): void;
  closeReplay(): Promise<void>;
  replaySessionId(): string | null;
  showDialog(dialog: HTMLDialogElement): void;
  closeDialog(dialog: HTMLDialogElement): void;
  notify(title: string, message?: string, error?: boolean): void;
}
export function createLifecycleUI(options: Options) {
  const api = window.collector;
  let scope: LibraryState = "active";
  let profileFilter = "";
  let groupId = "";
  let profileSignature = "";
  let tabsSignature = "";
  let managedId = "";
  let lastActiveProfileId: string | null = null;
  let confirmation: ((name: string) => Promise<AppState>) | null = null;
  const profileName = (id: string, snapshot = "") => {
    const profile = options.state().profiles.find(p => p.id === id);
    return profile ? profile.name : `${snapshot || "未知环境"}（已删除）`;
  };
  const selectedGroup = () => options.state().sessionGroups.find(g => g.id === groupId);
  const groupFor = (record: SessionMetadata) => options.state().sessionGroups.find(g => g.id === record.sessionGroupId);
  const effectiveState = (record: SessionMetadata): LibraryState => {
    const group = groupFor(record);
    if (group?.libraryState === "trashed" || record.libraryState === "trashed") return "trashed";
    if (group?.libraryState === "archived" || record.libraryState === "archived") return "archived";
    return "active";
  };
  const library = createLibraryUI({...options, scope:()=>scope, profileId:()=>profileFilter, replayId:options.replaySessionId, ask});
  const visibleSessions = (target = scope) => library.result(target).records;
  const visibleGroups = (target = scope) => library.result(target).groups;
  const canCapture = () => {
    const group = selectedGroup(), state = options.state();
    return Boolean(scope === "active" && group && group.status === "open" && group.libraryState === "active" && group.profileId === state.activeProfileId && state.browser.available);
  };
  function sync() {
    const state = options.state();
    if (state.activeProfileId && state.activeProfileId !== lastActiveProfileId) {profileFilter = state.activeProfileId; library.clearSelection();}
    lastActiveProfileId = state.activeProfileId;
    const ids = new Set([...state.profiles.map(p => p.id), ...state.sessionGroups.map(g => g.profileId)]);
    if (!ids.has(profileFilter)) profileFilter = state.activeProfileId || state.profiles[0]?.id || state.sessionGroups[0]?.profileId || "";
    if (!visibleGroups().some(g => g.id === groupId)) groupId = visibleGroups()[0]?.id || "";
    library.sync();
  }
  function chooseGroup(id: string) {
    const group = options.state().sessionGroups.find(g => g.id === id);
    if (!group) return;
    groupId = id;
    profileFilter = group.profileId;
  }
  function chooseSession(id: string) {
    const record = options.state().sessions.find(s => s.id === id);
    if (!record) return;
    scope = effectiveState(record);
    profileFilter = record.profileId;
    groupId = record.sessionGroupId;
  }
  function selectOptions(select: HTMLSelectElement, entries: [string, string][], value: string) {
    select.replaceChildren(...entries.map(([id, name]) => {
      const option = document.createElement("option"); option.value = id; option.textContent = name; return option;
    }));
    select.value = value;
  }
  async function perform(action: () => Promise<AppState>): Promise<boolean> {
    if (options.busy()) return false;
    options.setBusy(true);
    try { options.update(await action()); return true; }
    catch (error) {
      options.notify("操作未完成", message(error).replace(/^Error invoking remote method '[^']+': Error: /, ""), true);
      return false;
    } finally { options.setBusy(false); }
  }
  function ask(title: string, description: string, action: (name: string) => Promise<AppState>, settings: {name?: string; label?: string; danger?: boolean} = {}) {
    if (options.busy()) return;
    confirmation = action;
    el("management-title", "h2").textContent = title;
    el("management-description", "p").textContent = description;
    const input = el("management-name", "input"), named = settings.name !== undefined;
    input.hidden = !named; input.required = named; input.value = settings.name || "";
    input.maxLength = title.includes("Profile") ? 80 : 160;
    el("management-name-label", "label").hidden = !named;
    const button = el("management-confirm", "button");
    button.textContent = settings.label || "确认";
    button.className = `button ${settings.danger ? "stop" : "primary"}`;
    options.showDialog(el("management-dialog", "dialog"));
    if (named) { input.focus(); input.select(); }
  }
  async function changeEnvironment(action: () => Promise<AppState>) { await options.closeReplay(); return action(); }
  function switchTo(id: string) {
    if (!id || options.busy()) return;
    const rangeChanged = library.allProfiles;
    library.viewCurrentProfile();
    if (!options.state().profiles.some(p => p.id === id) || id === options.state().activeProfileId) {
      if (profileFilter === id) {if (rangeChanged) options.changed(); return;}
      profileFilter = id; groupId = ""; options.changed(); return;
    }
    const action = async () => {
      const next = await changeEnvironment(() => api.switchProfile(id));
      profileFilter = id; groupId = ""; return next;
    };
    if (options.state().session && ["recording", "paused"].includes(options.state().session!.status))
      ask("切换浏览环境", "将先结束并保存当前采集，再打开所选 Profile。", action, {label: "结束并切换"});
    else void perform(action);
  }
  function newGroup() {
    const profileId = profileFilter;
    if (!options.state().profiles.some(p => p.id === profileId)) return;
    ask("新建 Session", `在“${profileName(profileId)}”中创建 Session，可保存多条独立的采集记录。`, async name => {
      const oldIds = new Set(options.state().sessionGroups.map(g => g.id));
      const next = await api.createSessionGroup({profileId, name});
      library.resetFilters();
      groupId = next.sessionGroups.find(g => !oldIds.has(g.id))?.id || "";
      scope = "active"; return next;
    }, {name: "", label: "创建 Session"});
  }
  function renderProfiles() {
    const state = options.state(), entries = new Map(state.profiles.map(p => [p.id, p.name]));
    for (const group of state.sessionGroups) if (!entries.has(group.profileId)) entries.set(group.profileId, profileName(group.profileId, group.profileName));
    const signatureTabs = JSON.stringify([entries.size, [...entries], state.sessionGroups.map(g => [g.id, g.profileId, g.libraryState]), profileFilter, state.activeProfileId, options.busy()]);
    if (signatureTabs !== tabsSignature) {
    tabsSignature = signatureTabs;
    const tabs = document.createDocumentFragment();
    for (const [id, name] of entries) {
      const button = document.createElement("button");
      button.type = "button"; button.className = `profile-tab${id === profileFilter ? " selected" : ""}`;
      button.dataset.profileId = id; button.setAttribute("aria-pressed", String(id === profileFilter));
      button.title = name; button.disabled = options.busy();
      const dot = document.createElement("i"); dot.className = id === state.activeProfileId ? "open" : "";
      const label = document.createElement("span"); label.textContent = name;
      const total = document.createElement("small"); total.textContent = String(state.sessionGroups.filter(g => g.profileId === id && g.libraryState !== "trashed").length);
      button.append(dot, label, total); button.addEventListener("click", () => switchTo(id)); tabs.append(button);
    }
    const nav = el("profile-tabs", "nav"), scroll = nav.scrollLeft;
    nav.replaceChildren(tabs); nav.scrollLeft = scroll;
    }
    const signature = JSON.stringify(state.profiles.map(p => [p.id, p.name]));
    if (signature !== profileSignature) {
      profileSignature = signature;
      if (!state.profiles.some(p => p.id === managedId)) managedId = state.activeProfileId || state.profiles[0]?.id || "";
      selectOptions(el("managed-profile-select", "select"), state.profiles.length ? state.profiles.map(p => [p.id, p.name] as [string,string]) : [["", "暂无 Profile，请先创建"]], managedId);
    }
    const open = state.activeProfileId === profileFilter;
    el("active-profile-label", "span").textContent = state.activeProfileId ? "独立登录环境" : "环境已关闭";
    el("close-profile-button", "button").hidden = !state.activeProfileId;
    el("close-profile-button", "button").disabled = options.busy();
    el("profile-tree-caption", "span").textContent = entries.get(profileFilter) || "选择或新建 Profile";
    el("profile-tree-caption", "span").title = open ? "此 Profile 的浏览环境已打开" : "历史 Session 与采集记录";
    for (const id of ["open-managed-profile", "rename-profile-button", "clear-profile-cache-button", "clear-profile-storage-button", "delete-profile-button"])
      el(id, "button").disabled = options.busy() || !managedId;
    el("open-managed-profile", "button").disabled ||= managedId === state.activeProfileId;
    el("open-managed-profile", "button").textContent = managedId && managedId === state.activeProfileId ? "环境已打开" : "打开环境";
    el("managed-profile-status", "p").textContent = managedId === state.activeProfileId ? "当前正在使用此浏览环境。" : "打开后，可在此 Profile 的 Session 中采集。";
    el("create-profile-button", "button").disabled = options.busy();
    el("management-confirm", "button").disabled = options.busy();
    el("management-cancel", "button").disabled = options.busy();
    el("new-session-button", "button").disabled = options.busy() || !state.profiles.some(p => p.id === profileFilter);
  }
  function render() {
    const state = options.state();
    renderProfiles();
    library.render();
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-library-scope]")) {
      const tab = button.dataset.libraryScope as LibraryState;
      button.setAttribute("aria-pressed", String(tab === scope));
      required(button.querySelector("span")).textContent = String(visibleGroups(tab).length);
    }
    el("library-scope-caption", "p").textContent = scope === "trashed" ? "已删除的 Session 与采集记录" : scope === "archived" ? "已归档的 Session 与采集记录" : "Session / 采集记录";
    const selected = options.selectedSession(), group = selectedGroup();
    const parentTrashed = group?.libraryState === "trashed";
    const profileDeleted = Boolean(group && !state.profiles.some(p => p.id === group.profileId));
    const trashed = selected ? effectiveState(selected) === "trashed" : parentTrashed;
    const recording = selected && ["recording", "paused"].includes(selected.status);
    const exporting = Boolean(selected && state.export?.sessionId === selected.id);
    const playing = selected && options.replaySessionId() === selected.id;
    const locked = options.busy() || Boolean(recording || exporting || playing || parentTrashed);
    el("recording-overview", "div").hidden = !selected;
    el("session-management", "div").hidden = !selected || Boolean(trashed);
    el("current-session-profile", "span").textContent = selected ? `所属 Profile：${profileName(selected.profileId, selected.profileName)}` : "";
    el("session-management-hint", "span").textContent = recording ? "结束采集后可整理记录" : exporting ? "导出完成或取消后可整理记录" : playing ? "返回浏览器后可整理记录" : group?.libraryState === "archived" ? "所属 Session 已归档，记录仍可回放和导出" : "";
    for (const id of ["rename-session-button", "archive-session-button", "trash-session-button"])
      el(id, "button").disabled = !selected || locked;
    for (const id of ["restore-session-button", "delete-session-button"])
      el(id, "button").disabled = !selected || locked;
    el("archive-session-button", "button").textContent = selected?.libraryState === "archived" ? "取消归档" : "归档";
    el("group-context", "div").hidden = !selected || !group;
    el("select-parent-group", "button").textContent = group?.name || "";
    el("select-parent-group", "button").title = group?.name || "";
    el("group-overview", "div").hidden = Boolean(selected) || !group;
    el("current-group-name", "h2").textContent = group?.name || "";
    el("current-group-name", "h2").title = group?.name || "";
    const children = state.sessions.filter(s => s.sessionGroupId === group?.id);
    const groupStatus = group?.libraryState === "trashed" ? "已删除" : group?.libraryState === "archived" ? "已归档" : group?.status === "open" ? "已打开" : "已关闭";
    el("current-group-meta", "p").textContent = group ? `${groupStatus} · ${children.length} 条采集记录` : "";
    const groupRunning = children.some(s => ["recording", "paused"].includes(s.status));
    const groupExporting = children.some(s => s.id === state.export?.sessionId);
    const groupPlaying = children.some(s => s.id === options.replaySessionId());
    const groupLocked = options.busy() || groupRunning || groupExporting || groupPlaying;
    for (const id of ["rename-group-button", "archive-group-button", "trash-group-button", "reopen-group-button", "restore-group-button", "delete-group-button"])
      el(id, "button").disabled = !group || groupLocked;
    el("reopen-group-button", "button").disabled ||= profileDeleted;
    el("close-group-button", "button").disabled = !group || options.busy() || groupExporting || groupPlaying;
    for (const id of ["rename-group-button", "archive-group-button", "trash-group-button"])
      el(id, "button").hidden = Boolean(parentTrashed);
    el("close-group-button", "button").hidden = !group || group.status !== "open" || group.libraryState !== "active";
    el("reopen-group-button", "button").hidden = !group || group.status !== "closed" || group.libraryState !== "active";
    el("archive-group-button", "button").textContent = group?.libraryState === "archived" ? "取消归档" : "归档";
    el("group-management-hint", "p").textContent = groupExporting ? "导出完成后可整理此 Session" : groupPlaying ? "返回浏览器后可整理此 Session" : groupRunning ? "关闭 Session 会结束并保存当前采集" : "";
    const showNotice = !selected || Boolean(trashed);
    required(document.querySelector(".timeline-card")).classList.toggle("library-empty", showNotice);
    el("session-library-notice", "div").hidden = !showNotice;
    el("timeline-list", "div").hidden = showNotice;
    for (const element of document.querySelectorAll<HTMLElement>(".timeline-heading, .timeline-filters, .timeline-search, .session-metrics")) element.hidden = showNotice;
    if (showNotice) { el("event-detail", "div").hidden = true; el("load-more-button", "button").hidden = true; }
    el("search-input", "input").disabled = showNotice;
    el("follow-button", "button").disabled = showNotice;
    el("restore-session-button", "button").hidden = !selected || !trashed || Boolean(parentTrashed);
    el("delete-session-button", "button").hidden = !selected || !trashed || Boolean(parentTrashed);
    el("restore-group-button", "button").hidden = !parentTrashed;
    el("delete-group-button", "button").hidden = !parentTrashed;
    el("new-recording-button", "button").hidden = Boolean(selected) || !canCapture() || scope !== "active";
    el("new-recording-button", "button").disabled = options.busy() || Boolean(state.session && ["recording", "paused"].includes(state.session.status));
    el("empty-new-session-button", "button").hidden = Boolean(group) || library.hasFilters || scope !== "active" || !state.profiles.some(p => p.id === profileFilter);
    el("empty-new-session-button", "button").disabled = options.busy();
    const noGroups = !visibleGroups().length;
    el("library-notice-icon", "span").innerHTML = svg(scope === "trashed" || trashed ? "trash" : scope === "archived" ? "archive" : "layers");
    el("library-notice-title", "strong").textContent = parentTrashed ? "Session 在回收站中" : trashed ? "采集记录在回收站中" : noGroups ? scope === "trashed" ? "回收站为空" : scope === "archived" ? "暂无归档内容" : "从一个 Session 开始" : children.length ? "选择一条采集记录" : "还没有采集记录";
    el("library-notice-description", "p").textContent = parentTrashed ? "恢复 Session 后，可继续查看其中的采集记录。彻底删除会一并移除所有记录。" : trashed ? "记录仍保存在本地。恢复后即可查看时间线、回放和导出。" : noGroups ? scope === "trashed" ? "删除的 Session 和采集记录会出现在这里，可恢复或彻底删除。" : scope === "archived" ? "将暂时不用的 Session 或采集记录归档，在这里集中查看。" : "按一次工作或测试任务组织 Session，每个 Session 可保存多条采集记录。" : profileDeleted ? "此 Profile 已删除，历史 Session 和采集记录仍可查看、回放和导出。" : group?.libraryState === "archived" ? "此 Session 已归档，仍可查看和回放记录。取消归档并重新打开后可继续采集。" : group?.status === "closed" ? "Session 已关闭。历史记录保留，重新打开后可继续添加采集记录。" : children.length ? "从左侧选择记录查看时间线，或在此 Session 中开始下一次采集。" : "开始一次采集，结束后记录将保存在此 Session 下。";
    if (noGroups && library.hasFilters) {
      el("library-notice-title", "strong").textContent = "没有匹配的 Session 或记录";
      el("library-notice-description", "p").textContent = "调整名称或创建时间，或清除左侧筛选后查看全部内容。";
    }
    el("timeline-display-count", "span").hidden = showNotice;
  }
  el("manage-profiles-button", "button").addEventListener("click", () => {
    managedId = options.state().profiles.some(p => p.id === profileFilter) ? profileFilter : options.state().profiles[0]?.id || "";
    el("managed-profile-select", "select").value = managedId;
    render(); options.showDialog(el("profiles-dialog", "dialog"));
  });
  el("managed-profile-select", "select").addEventListener("change", () => { managedId = el("managed-profile-select", "select").value; render(); });
  for (const id of ["close-profiles-dialog", "profiles-done-button"])
    el(id, "button").addEventListener("click", () => options.closeDialog(el("profiles-dialog", "dialog")));
  el("open-managed-profile", "button").addEventListener("click", () => switchTo(managedId));
  el("create-profile-button", "button").addEventListener("click", () => ask("新建 Profile", "创建独立浏览环境并打开。如果正在采集，会先结束并保存当前记录。", async name => {
    const next = await changeEnvironment(() => api.createProfile(name)); managedId = next.activeProfileId || ""; profileSignature = ""; scope = "active"; groupId = ""; return next;
  }, {name: "", label: "创建并打开"}));
  el("rename-profile-button", "button").addEventListener("click", () => {
    const id = managedId, profile = options.state().profiles.find(p => p.id === id);
    if (profile) ask("重命名 Profile", "修改显示名称，登录数据与采集记录不变。", name => api.renameProfile({profileId: id, name}), {name: profile.name, label: "保存名称"});
  });
  el("close-profile-button", "button").addEventListener("click", () => ask("关闭浏览环境", "将结束并保存当前采集。Profile 的登录数据、Session 和采集记录继续保留。", () => changeEnvironment(() => api.closeProfile()), {label: "关闭环境"}));
  for (const kind of ["cache", "storage"] as const)
    el(`clear-profile-${kind}-button`, "button").addEventListener("click", () => {
      const id = managedId; if (!id) return;
      ask(kind === "cache" ? "清理 Profile 缓存" : "清除 Profile 登录数据", `${profileName(id)}：${kind === "cache" ? "清理浏览器缓存。" : "清除 Cookie 和网站存储，下次访问需要重新登录。"}如果该环境正在使用，会结束采集并关闭环境；Session 与记录保留。`, () => changeEnvironment(() => api.clearProfileData({profileId: id, kind})), {label: "确认清理", danger: true});
    });
  el("delete-profile-button", "button").addEventListener("click", () => {
    const id = managedId;
    if (id) ask("删除 Profile", `永久删除“${profileName(id)}”的登录数据与缓存。如果正在使用，会先结束采集并关闭环境。其 Session 和采集记录保留，可继续回放、导出和管理。`, () => changeEnvironment(() => api.deleteProfile(id)), {label: "删除 Profile", danger: true});
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-library-scope]"))
    button.addEventListener("click", () => { scope = button.dataset.libraryScope as LibraryState; groupId = ""; library.clearSelection(); options.changed(); });
  for (const id of ["new-session-button", "empty-new-session-button"]) el(id, "button").addEventListener("click", newGroup);
  el("select-parent-group", "button").addEventListener("click", () => options.changed());
  el("rename-group-button", "button").addEventListener("click", () => {
    const group = selectedGroup(); if (group) ask("重命名 Session", "修改 Session 名称，其中的采集记录不变。", name => api.renameSessionGroup({sessionGroupId: group.id, name}), {name: group.name, label: "保存名称"});
  });
  el("close-group-button", "button").addEventListener("click", () => {
    const group = selectedGroup(); if (group) ask("关闭 Session", "结束并保存此 Session 中正在进行的采集。已有记录继续保留，之后可以重新打开。", () => api.closeSessionGroup(group.id), {label: "关闭 Session"});
  });
  el("reopen-group-button", "button").addEventListener("click", () => { const group = selectedGroup(); if (group) void perform(() => api.reopenSessionGroup(group.id)); });
  el("archive-group-button", "button").addEventListener("click", () => { const group = selectedGroup(); if (group) void perform(() => group.libraryState === "archived" ? api.unarchiveSessionGroup(group.id) : api.archiveSessionGroup(group.id)); });
  el("trash-group-button", "button").addEventListener("click", () => {
    const group = selectedGroup(); if (group) ask("将 Session 移入回收站", `“${group.name}”及其所有采集记录将移入回收站，之后可以恢复。此操作不会释放磁盘空间。`, () => api.trashSessionGroup(group.id), {label: "移入回收站", danger: true});
  });
  el("restore-group-button", "button").addEventListener("click", () => { const group = selectedGroup(); if (group) void perform(() => api.restoreSessionGroup(group.id)); });
  el("delete-group-button", "button").addEventListener("click", () => {
    const group = selectedGroup(); if (group) ask("彻底删除 Session", `永久删除“${group.name}”及其全部采集记录，包含事件、快照和资源，无法恢复。此前导出的 ZIP 不会被删除。`, () => api.deleteSessionGroup(group.id), {label: "彻底删除 Session", danger: true});
  });
  el("rename-session-button", "button").addEventListener("click", () => {
    const record = options.selectedSession(); if (record) ask("重命名采集记录", "修改这条采集记录的显示名称。", name => api.renameSession({sessionId: record.id, name}), {name: record.name, label: "保存名称"});
  });
  el("archive-session-button", "button").addEventListener("click", () => { const record = options.selectedSession(); if (record) void perform(() => record.libraryState === "archived" ? api.unarchiveSession(record.id) : api.archiveSession(record.id)); });
  el("trash-session-button", "button").addEventListener("click", () => {
    const record = options.selectedSession(); if (record) ask("将采集记录移入回收站", `“${record.name}”将移入回收站，之后可以恢复。其他采集记录不受影响。`, () => api.trashSession(record.id), {label: "移入回收站", danger: true});
  });
  el("restore-session-button", "button").addEventListener("click", () => { const record = options.selectedSession(); if (record) void perform(() => api.restoreSession(record.id)); });
  el("delete-session-button", "button").addEventListener("click", () => {
    const record = options.selectedSession(); if (record) ask("彻底删除采集记录", `永久删除“${record.name}”的事件、快照、资源和索引，无法恢复。此前导出的 ZIP 不会被删除。`, () => api.deleteSession(record.id), {label: "彻底删除", danger: true});
  });
  el("management-form", "form").addEventListener("submit", async event => {
    event.preventDefault(); if (!confirmation || options.busy()) return;
    const action = confirmation;
    if (await perform(() => action(el("management-name", "input").value.trim()))) {
      confirmation = null; options.closeDialog(el("management-dialog", "dialog"));
    }
  });
  el("management-cancel", "button").addEventListener("click", () => options.closeDialog(el("management-dialog", "dialog")));
  el("management-dialog", "dialog").addEventListener("cancel", event => { if (options.busy()) event.preventDefault(); });
  return { render, sync, visibleSessions, visibleGroups, chooseSession, chooseGroup, selectedGroup, effectiveState, canCapture, profileName, newGroup, library,
    get scope() {return scope;}, get profileFilter() {return profileFilter;}, get selectedGroupId() {return groupId;} };
}
