import type { AppState, SessionMetadata } from "../../shared/contracts/ui";
import type { LibraryState } from "../../shared/contracts/storage";
import { element as el } from "./dom";
import { libraryDateError, queryLibrary } from "./library-query";

type Action = "archive" | "unarchive" | "trash" | "restore" | "delete";
interface Options {
  state(): AppState;
  scope(): LibraryState;
  profileId(): string;
  busy(): boolean;
  replayId(): string | null;
  changed(): void;
  repaint(): void;
  update(state: AppState): void;
  notify(title: string, message?: string, error?: boolean): void;
  ask(title: string, description: string, action: () => Promise<AppState>, settings: {label: string; danger?: boolean}): void;
}

export function createLibraryUI(options: Options) {
  let name = "", from = "", to = "", allProfiles = false, selecting = false;
  const selectedGroups = new Set<string>(), selectedRecords = new Set<string>();
  const hasFilters = () => Boolean(name.trim() || from || to);
  let cachedState: AppState | undefined, cachedQuery = "";
  const cachedResults = new Map<LibraryState, ReturnType<typeof queryLibrary>>();
  function result(scope = options.scope()) {
    const state = options.state(), key = JSON.stringify([allProfiles, options.profileId(), name, from, to]);
    if (state !== cachedState || key !== cachedQuery) {cachedResults.clear(); cachedState = state; cachedQuery = key;}
    let view = cachedResults.get(scope);
    if (!view) {view = queryLibrary(state.sessionGroups, state.sessions, {profileId: allProfiles ? null : options.profileId(), scope, name, from, to}); cachedResults.set(scope, view);}
    return view;
  }
  const clearSelection = () => {selectedGroups.clear(); selectedRecords.clear();};
  const changed = () => {clearSelection(); options.changed();};
  const recordLocked = (record: SessionMetadata) => ["recording", "paused"].includes(record.status) ||
    options.state().export?.sessionId === record.id || options.replayId() === record.id;
  const groupReason = (id: string) => {
    if (!result().directGroupIds.has(id)) return "仅用于展示匹配记录的所属 Session";
    if (options.state().sessions.some(record => record.sessionGroupId === id && recordLocked(record))) return "先结束采集、导出或回放，再整理此 Session";
    return "";
  };
  const recordReason = (id: string) => {
    const record = options.state().sessions.find(record => record.id === id);
    if (!record) return "记录已不存在";
    if (options.state().sessionGroups.find(group => group.id === record.sessionGroupId)?.libraryState === "trashed") return result().directGroupIds.has(record.sessionGroupId) ? "请选择所属 Session 整组恢复或删除" : "请清除筛选后，选择所属 Session 整组恢复或删除";
    if (recordLocked(record)) return "先结束采集、导出或回放，再整理此记录";
    return "";
  };
  function selection() {
    const state = options.state();
    const groups = state.sessionGroups.filter(group => selectedGroups.has(group.id));
    const records = state.sessions.filter(record => selectedRecords.has(record.id) && !selectedGroups.has(record.sessionGroupId));
    const descendants = state.sessions.filter(record => selectedGroups.has(record.sessionGroupId));
    return {groups, records, descendants, totalRecords: records.length + descendants.length};
  }
  function available() {
    const view = result();
    return {groups: view.groups.filter(group => !groupReason(group.id)), records: view.records.filter(record => !recordReason(record.id))};
  }
  function sync() {
    const view = result(), groupIds = new Set(view.groups.map(group => group.id)), recordIds = new Set(view.records.map(record => record.id));
    for (const id of selectedGroups) if (!groupIds.has(id) || !view.directGroupIds.has(id)) selectedGroups.delete(id);
    for (const id of selectedRecords) if (!recordIds.has(id)) selectedRecords.delete(id);
  }
  function groupCheckbox(id: string, name: string) {
    const check = document.createElement("input"); check.type = "checkbox"; check.className = "library-checkbox";
    check.dataset.selectGroup = id; check.setAttribute("aria-label", `选择整个 Session：${name}`);
    check.checked = selectedGroups.has(id);
    check.indeterminate = !check.checked && options.state().sessions.some(record => record.sessionGroupId === id && selectedRecords.has(record.id));
    const reason = groupReason(id); check.disabled = options.busy() || Boolean(reason);
    check.title = reason || "选择整个 Session，包含全部采集记录";
    check.addEventListener("change", () => {
      if (check.checked) {selectedGroups.add(id); for (const record of options.state().sessions) if (record.sessionGroupId === id) selectedRecords.delete(record.id);}
      else selectedGroups.delete(id);
      options.repaint();
    });
    return check;
  }
  function recordCheckbox(record: SessionMetadata) {
    const check = document.createElement("input"); check.type = "checkbox"; check.className = "library-checkbox";
    check.dataset.selectRecord = record.id; check.setAttribute("aria-label", `选择采集记录：${record.name}`);
    const covered = selectedGroups.has(record.sessionGroupId), reason = recordReason(record.id);
    check.checked = covered || selectedRecords.has(record.id); check.disabled = covered || options.busy() || Boolean(reason);
    check.title = covered ? "已包含在所选 Session 中" : reason || "选择这条采集记录";
    check.addEventListener("change", () => {if (check.checked) selectedRecords.add(record.id); else selectedRecords.delete(record.id); options.repaint();});
    return check;
  }
  function actionReason(action: Action) {
    const picked = selection();
    if (!picked.groups.length && !picked.records.length) return "请先选择要整理的内容";
    if (picked.groups.some(group => groupReason(group.id)) || picked.records.some(record => recordReason(record.id))) return "所选内容正被采集、导出或回放占用";
    if (action === "unarchive" && picked.records.some(record => record.libraryState !== "archived" || options.state().sessionGroups.find(group => group.id === record.sessionGroupId)?.libraryState === "archived")) return "所属 Session 已归档，请选择 Session 取消归档";
    return "";
  }
  function batch(action: Action) {
    if (options.busy()) return;
    const reason = actionReason(action); if (reason) {options.notify("暂时无法整理", reason, true); return;}
    const picked = selection(), labels = {archive:"归档", unarchive:"取消归档", trash:"移入回收站", restore:"恢复", delete:"彻底删除"};
    const label = labels[action];
    const selectionLabel = [picked.groups.length ? `${picked.groups.length} 个 Session` : "", picked.records.length ? `${picked.records.length} 条独立采集记录` : ""].filter(Boolean).join("和");
    const scopeLabel = picked.groups.length ? `所选 Session 包含 ${picked.descendants.length} 条记录（包含筛选隐藏、归档和回收站中的子记录），合计涉及 ${picked.totalRecords} 条采集记录。` : `合计涉及 ${picked.totalRecords} 条采集记录。`;
    const consequence = action === "delete" ? "事件、快照、资源与索引将永久移除，无法恢复。已导出的 ZIP 保留。" : action === "trash" ? "内容将移入回收站，之后可以恢复；此操作不释放磁盘空间。Session 内的记录保留各自原有状态。" : action === "archive" ? `${picked.groups.length ? "所选 Session 将关闭并归档，子记录自身状态保留。" : "所选记录将归档。"}可用记录仍可查看、回放和导出。` : action === "unarchive" ? `取消所选对象的归档。${picked.groups.length ? "Session 保持关闭，可手动重新打开；子记录自身的归档和回收站状态保留。" : ""}` : "恢复到移入回收站前的分组；Session 内的记录保留各自原有状态，原已删除的子记录仍在回收站中。";
    const input = {action, sessionGroupIds:picked.groups.map(group => group.id), sessionIds:picked.records.map(record => record.id)};
    options.ask(`批量${label}`, `将${label}${selectionLabel}。${scopeLabel}${consequence}`, async () => {
      try {
        const next = await window.collector.batchLibrary(input);
        clearSelection(); options.notify(`已${label}`, selectionLabel); return next;
      } catch (error) {
        // Refresh after an I/O failure so completed changes cannot be retried from stale selections.
        try {options.update(await window.collector.getState());} catch { /* The original operation error remains the useful message. */ }
        throw error;
      }
    }, {label: action === "delete" ? "确认彻底删除" : `确认${label}`, danger:action === "trash" || action === "delete"});
  }
  function render() {
    sync();
    const state = options.state(), view = result(), picked = selection(), inTrash = options.scope() === "trashed";
    const error = libraryDateError(from, to);
    el("library-date-error", "p").hidden = !error; el("library-date-error", "p").textContent = error;
    for (const id of ["library-date-from", "library-date-to"]) el(id, "input").setAttribute("aria-invalid", String(Boolean(error)));
    el("library-filter-status", "div").hidden = !hasFilters();
    el("library-filter-summary", "span").textContent = `${view.groups.length} 个 Session · ${view.records.length} 条记录`;
    el("library-select-button", "button").textContent = selecting ? "完成" : "多选";
    el("library-select-button", "button").setAttribute("aria-pressed", String(selecting));
    el("library-select-button", "button").disabled = options.busy() || (!selecting && !view.groups.length);
    el("library-selection-tools", "div").hidden = !selecting;
    el("library-batch-bar", "div").hidden = !selecting;
    el("library-batch-summary", "strong").textContent = picked.groups.length || picked.records.length ? `已选 ${picked.groups.length} 个 Session · ${picked.records.length} 条独立记录` : "请选择要整理的内容";
    const archiveAction = options.scope() === "archived" ? "unarchive" : "archive";
    const reason = picked.groups.length || picked.records.length ? actionReason(inTrash ? "restore" : archiveAction) : "";
    el("library-batch-hint", "p").textContent = reason || (picked.groups.length ? `包含 Session 内全部记录，共 ${picked.totalRecords} 条` : "选择 Session 将包含全部子记录");
    const possible = available();
    const all = el("library-select-all", "input");
    const flags = [...possible.groups.map(group => selectedGroups.has(group.id)), ...possible.records.map(record => selectedGroups.has(record.sessionGroupId) || selectedRecords.has(record.id))];
    all.checked = flags.length > 0 && flags.every(Boolean); all.indeterminate = !all.checked && flags.some(Boolean); all.disabled = options.busy() || !flags.length;
    el("library-clear-selection", "button").disabled = options.busy() || (!picked.groups.length && !picked.records.length);
    for (const [id, action] of [["library-batch-archive",archiveAction],["library-batch-trash","trash"],["library-batch-restore","restore"],["library-batch-delete","delete"]] as const) {
      const button = el(id, "button"); button.hidden = inTrash !== (action === "restore" || action === "delete");
      button.disabled = options.busy() || Boolean(actionReason(action));
      button.title = actionReason(action);
    }
    el("library-batch-archive", "button").textContent = archiveAction === "unarchive" ? "取消归档" : "归档";
    for (const id of ["library-search-input", "library-date-from", "library-date-to"]) el(id, "input").disabled = options.busy();
    el("library-profile-range", "select").disabled = options.busy();
    for (const id of ["library-date-toggle", "library-reset-filters"]) el(id, "button").disabled = options.busy();
    el("library-date-toggle", "button").classList.toggle("filtered", Boolean(from || to));
    if (allProfiles) el("profile-tree-caption", "span").textContent = `全部 Profile · ${state.profiles.length} 个可用环境`;
  }
  el("library-search-input", "input").addEventListener("input", () => {name = el("library-search-input", "input").value; changed();});
  el("library-profile-range", "select").addEventListener("change", () => {allProfiles = el("library-profile-range", "select").value === "all"; changed();});
  el("library-date-toggle", "button").addEventListener("click", () => {
    const fields = el("library-date-fields", "div"); fields.hidden = !fields.hidden;
    el("library-date-toggle", "button").setAttribute("aria-expanded", String(!fields.hidden));
    // Collapsing this control never leaves an invisible date filter active.
    if (fields.hidden && (from || to)) {from = ""; to = ""; el("library-date-from", "input").value = ""; el("library-date-to", "input").value = ""; changed();}
  });
  for (const id of ["library-date-from", "library-date-to"]) el(id, "input").addEventListener("change", () => {
    from = el("library-date-from", "input").value; to = el("library-date-to", "input").value; changed();
  });
  function resetFilters() {
    name = ""; from = ""; to = "";
    for (const id of ["library-search-input", "library-date-from", "library-date-to"]) el(id, "input").value = "";
    changed();
  }
  function viewCurrentProfile() {
    allProfiles = false; el("library-profile-range", "select").value = "current"; clearSelection();
  }
  el("library-reset-filters", "button").addEventListener("click", resetFilters);
  el("library-select-button", "button").addEventListener("click", () => {selecting = !selecting; clearSelection(); options.repaint();});
  el("library-clear-selection", "button").addEventListener("click", () => {clearSelection(); options.repaint();});
  el("library-select-all", "input").addEventListener("change", () => {
    clearSelection();
    if (el("library-select-all", "input").checked) {
      const view = available(); for (const group of view.groups) selectedGroups.add(group.id);
      for (const record of view.records) if (!selectedGroups.has(record.sessionGroupId)) selectedRecords.add(record.id);
    }
    options.repaint();
  });
  el("library-batch-archive", "button").addEventListener("click", () => batch(options.scope() === "archived" ? "unarchive" : "archive"));
  el("library-batch-trash", "button").addEventListener("click", () => batch("trash"));
  el("library-batch-restore", "button").addEventListener("click", () => batch("restore"));
  el("library-batch-delete", "button").addEventListener("click", () => batch("delete"));
  return {result, render, sync, clearSelection, groupCheckbox, recordCheckbox, resetFilters, viewCurrentProfile,
    get hasFilters() {return hasFilters();}, get selecting() {return selecting;}, get allProfiles() {return allProfiles;},
    get signature() {return JSON.stringify([name, from, to, allProfiles, selecting, [...selectedGroups], [...selectedRecords], options.busy(), options.state().export?.sessionId, options.replayId()]);}};
}
