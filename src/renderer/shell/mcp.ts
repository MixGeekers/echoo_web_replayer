import type { AppState, CollectorAPI } from "../../shared/contracts/ui";
import { element as el, message } from "./dom";
import { exportProgressLabel } from "./export";

type MCPState = NonNullable<AppState["mcp"]>;
type Connection = MCPState["connections"][number];
type Permission = "read" | "capture" | "browser" | "organize" | "export";
type Command = Parameters<CollectorAPI["mcpCommand"]>[0];
interface Options {
  state(): AppState;
  update(state: AppState): void;
  boundsChanged(): void;
  notify(title: string, detail?: string, error?: boolean): void;
}
const permissions: Permission[] = ["read", "capture", "browser", "organize", "export"];
const statusNames: Record<string, string> = {
  pending: "等待首次授权", connected: "已连接", disconnected: "已断开", revoked: "授权已撤销",
  queued: "等待执行", running: "执行中", succeeded: "已完成", completed: "已完成",
  failed: "失败", canceled: "已取消", cancelled: "已取消", unknown: "待核验", interrupted: "已中断",
};
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
  const result = document.createElement(tag); result.textContent = text; result.className = className; return result;
}
function time(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", {hour:"2-digit",minute:"2-digit",hour12:false}).format(date) : "";
}

export function createMCPUI(api: CollectorAPI, options: Options) {
  let panelOpen = false;
  let selectedId = "";
  let busy = false;
  let dirty = false;
  let draftSignature = "";
  let scopeSignature = "";
  let clientSignature = "";
  let activitySignature = "";
  let operationSignature = "";
  let deleteSignature = "";
  let configSignature = "";
  let configLoading = false;
  const state = () => options.state().mcp;
  const selected = () => state()?.connections.find(connection => connection.id === selectedId);
  const profileName = (id: string) => options.state().profiles.find(profile => profile.id === id)?.name || "已删除的 Profile";
  const clientName = (id: string | null | undefined) => state()?.connections.find(connection => connection.id === id)?.name || "Agent";
  const controlled = () => Boolean(state()?.control);

  function setPanel(open: boolean) {
    panelOpen = open;
    el("mcp-panel", "aside").hidden = !open;
    document.body.classList.toggle("mcp-panel-open", open);
    el("mcp-open-button", "button").setAttribute("aria-expanded", String(open));
    options.boundsChanged();
    if (open) void loadConfig();
  }
  async function loadConfig(force = false) {
    const current = state();
    const key = current?.instanceId || "";
    if (configLoading || (!force && configSignature === key && el("mcp-config", "textarea").value)) return;
    configLoading = true;
    try {
      const config = await api.mcpConfig();
      const {command, args, env} = config;
      el("mcp-config", "textarea").value = JSON.stringify({mcpServers:{tracedock:{command,args,...(env && Object.keys(env).length ? {env} : {})}}}, null, 2);
      configSignature = key;
    } catch (error) {
      options.notify("无法读取接入配置", message(error), true);
    } finally { configLoading = false; }
  }
  async function command(input: Command) {
    if (busy) return;
    busy = true;
    render();
    try {
      const next = await api.mcpCommand(input);
      dirty = false;
      draftSignature = "";
      options.update(next);
    } catch (error) {
      options.notify("Agent 操作未完成", message(error).replace(/^Error invoking remote method '[^']+': Error: /, ""), true);
    } finally { busy = false; render(); }
  }
  function draft(connection: Connection) {
    const app = options.state();
    const signature = JSON.stringify([connection.id, connection.status, connection.profileIds, connection.permissions, app.profiles.map(profile => [profile.id,profile.name])]);
    if (signature === draftSignature || dirty) return;
    draftSignature = signature;
    const allowed = connection.profileIds.length ? connection.profileIds : [app.activeProfileId || app.profiles[0]?.id || ""];
    const fragment = document.createDocumentFragment();
    for (const profile of app.profiles) {
      const label = node("label"), input = node("input"), name = node("span", profile.name);
      input.type = "checkbox"; input.value = profile.id; input.checked = allowed.includes(profile.id); input.dataset.profileId = profile.id;
      name.title = profile.name; label.append(input, name); fragment.append(label);
    }
    if (!app.profiles.length) fragment.append(node("span", "先创建一个 Profile，再授予访问范围。", "mcp-note"));
    el("mcp-profile-list", "div").replaceChildren(fragment);
    for (const permission of permissions) el(`mcp-permission-${permission}`, "input").checked = permission === "read" || Boolean(connection.permissions[permission]);
  }
  function renderActivity(current: MCPState) {
    const signature = JSON.stringify(current.activity);
    if (signature === activitySignature) return;
    activitySignature = signature;
    const fragment = document.createDocumentFragment();
    for (const event of current.activity.slice(0, 25)) {
      const item = node("li");
      const actor = node("span", event.actor, "mcp-activity-actor"); actor.title = event.actor;
      const text = node("span", event.message, "mcp-activity-message");
      const detail = node("span", [time(event.at), event.detail].filter(Boolean).join(" · "), "mcp-activity-detail");
      item.append(actor, text, detail); fragment.append(item);
    }
    el("mcp-activity-list", "ol").replaceChildren(fragment);
    el("mcp-activity-empty", "p").hidden = current.activity.length > 0;
    el("mcp-activity-count", "span").textContent = String(current.activity.length);
  }
  function renderOperations(current: MCPState) {
    const signature = JSON.stringify(current.operations);
    if (signature === operationSignature) return;
    operationSignature = signature;
    const fragment = document.createDocumentFragment();
    for (const operation of current.operations.slice(0, 10)) {
      const item = node("div", "", "mcp-operation"), heading = node("div", "", "mcp-operation-heading");
      heading.append(node("strong", operation.kind === "export" ? "导出分析包" : operation.kind), node("span", statusNames[operation.status] || operation.status));
      item.append(heading);
      if (operation.progress !== undefined) {
        item.append(node("p", exportProgressLabel(operation.progress)));
      }
      item.append(node("p", operation.error || operation.path || operation.id));
      if (["queued", "running"].includes(operation.status)) {
        const button = node("button", "取消任务", "text-button"); button.type = "button";
        button.addEventListener("click", () => { void command({action:"cancelOperation",operationId:operation.id}); }); item.append(button);
      }
      if (operation.path && ["succeeded", "completed"].includes(operation.status)) {
        const button = node("button", "打开所在文件夹", "text-button"); button.type = "button";
        button.addEventListener("click", () => { void command({action:"revealOperation",operationId:operation.id}); }); item.append(button);
      }
      fragment.append(item);
    }
    el("mcp-operation-list", "div").replaceChildren(fragment);
    el("mcp-operations-section", "section").hidden = !current.operations.length;
    el("mcp-operation-count", "span").textContent = String(current.operations.length);
  }
  function renderDeletes(current: MCPState) {
    const plans = current.deletePlans || [];
    const signature = JSON.stringify(plans);
    if (signature === deleteSignature) return;
    deleteSignature = signature;
    const fragment = document.createDocumentFragment();
    for (const plan of plans) {
      const item = node("div", "", "mcp-delete-plan");
      item.append(node("p", `${clientName(plan.connectionId)} · ${plan.summary}`));
      const details = node("details"), list = node("ul"); details.append(node("summary", `查看 ${plan.items.length} 个受影响对象`));
      for (const entry of plan.items) list.append(node("li", entry));
      details.append(list); item.append(details);
      const button = node("button", plan.approved ? "已批准此范围" : "批准永久删除此范围", "button stop"); button.type = "button"; button.disabled = plan.approved || Date.parse(plan.expiresAt) <= Date.now();
      button.addEventListener("click", () => { void command({action:"approveDelete",planId:plan.id}); });
      item.append(button); fragment.append(item);
    }
    el("mcp-delete-list", "div").replaceChildren(fragment);
    el("mcp-delete-section", "section").hidden = !plans.length;
  }
  function render() {
    const current = state();
    const allConnections = current?.connections || [];
    const activeClients = new Set(allConnections.filter(connection => ["connected", "pending"].includes(connection.status)).map(connection => connection.clientId));
    const newest = new Map(allConnections.map(connection => [connection.clientId, connection.id]));
    // Keep simultaneous live connections, but collapse old disconnected transports
    // so a reconnect does not add another indistinguishable client to the picker.
    const connections = allConnections.filter(connection => ["connected", "pending"].includes(connection.status) || (!activeClients.has(connection.clientId) && newest.get(connection.clientId) === connection.id));
    const connected = connections.filter(connection => connection.status === "connected");
    const pending = connections.filter(connection => connection.status === "pending" || connection.requestedControl);
    const control = current?.control;
    const capture = options.state().session;
    const running = capture && ["recording", "paused"].includes(capture.status);
    const captureOwner = current?.captureOwner?.recordingId === capture?.id ? current?.captureOwner?.connectionId : null;
    const activeName = options.state().activeProfileId ? profileName(options.state().activeProfileId!) : "环境已关闭";
    const currentGroup = options.state().sessionGroups.find(group => group.id === capture?.sessionGroupId);
    el("mcp-collaboration", "section").classList.toggle("agent-controlled", Boolean(control));
    el("mcp-operator-label", "strong").textContent = control ? control.status === "reserved" ? "Agent 已获控制权" : "Agent 正在操作" : "你在操作";
    el("mcp-status-button", "button").textContent = pending.length ? `${pending.length} 项连接 / 控制请求待确认` : !current?.enabled ? "本地 MCP 未开启" : connected.length ? `${connected.length} 个 Agent 已连接${control ? ` · ${clientName(control.connectionId)}` : " · 网页由你操作"}` : "等待 Agent 连接";
    el("mcp-status-button", "button").classList.toggle("has-request", pending.length > 0);
    el("mcp-capture-label", "span").textContent = running ? `${captureOwner ? "Agent" : "人工"}采集${capture.status === "paused" ? "已暂停" : "中"}` : "";
    const strip = el("mcp-collaboration", "section");
    strip.classList.toggle("capturing", Boolean(running) && capture?.status === "recording");
    strip.classList.toggle("capture-paused", Boolean(running) && capture?.status === "paused");
    strip.classList.toggle("agent-capture", Boolean(running && captureOwner));
    el("mcp-target-label", "span").textContent = control ? `${profileName(control.profileId)}${control.status === "reserved" ? " · 待打开环境" : currentGroup ? ` / ${currentGroup.name}` : ""}` : [activeName, currentGroup?.name].filter(Boolean).join(" / ");
    el("mcp-target-label", "span").title = el("mcp-target-label", "span").textContent || "";
    // 顶栏空间有限：窄窗口下目标与连接说明可能被隐藏或截断，悬停徽标可看到完整状态。
    strip.title = [el("mcp-operator-label", "strong").textContent, el("mcp-capture-label", "span").textContent, el("mcp-status-button", "button").textContent, el("mcp-target-label", "span").textContent].filter(Boolean).join(" · ");
    el("mcp-takeover-button", "button").hidden = !control;
    el("mcp-takeover-button", "button").disabled = busy;
    el("mcp-entry-label", "span").textContent = connected.length ? `Agent 连接 · ${connected.length}` : "Agent 连接";
    el("mcp-entry-dot", "i").hidden = pending.length === 0;
    el("mcp-service-status", "span").textContent = current?.enabled ? "已开启 · 仅限本机" : "未开启";
    el("mcp-service-button", "button").textContent = current?.enabled ? "关闭" : "开启";
    el("mcp-service-button", "button").disabled = busy;
    el("mcp-client-count", "span").textContent = String(connected.length);
    el("mcp-empty", "div").hidden = connections.length > 0;
    el("mcp-client-detail", "div").hidden = !connections.length;
    if (!connections.some(connection => connection.id === selectedId)) {
      const previousClientId = allConnections.find(connection => connection.id === selectedId)?.clientId;
      selectedId = connections.find(connection => connection.clientId === previousClientId)?.id || pending[0]?.id || connected[0]?.id || connections[0]?.id || "";
      dirty = false; draftSignature = "";
    }
    const select = el("mcp-client-select", "select");
    const signature = JSON.stringify(connections.map(connection => [connection.id,connection.name,connection.status,Boolean(connection.requestedControl)]));
    if (signature !== clientSignature) {
      clientSignature = signature;
      select.replaceChildren(...connections.map(connection => {
        const option = node("option", `${connection.name} · ${connection.requestedControl ? "请求控制" : statusNames[connection.status] || connection.status}`); option.value = connection.id; return option;
      }));
    }
    select.value = selectedId;
    const connection = selected();
    if (connection) {
      draft(connection);
      const pendingConnection = connection.status === "pending";
      const disconnected = connection.status === "disconnected";
      const revoked = connection.status === "revoked";
      const canEdit = !busy && Boolean(current?.enabled) && (pendingConnection || connection.status === "connected");
      const nextScopeSignature = `${connection.id}:${connection.status}`;
      if (scopeSignature !== nextScopeSignature) {
        scopeSignature = nextScopeSignature;
        el("mcp-scope-details", "details").open = pendingConnection;
      }
      el("mcp-scope-summary", "p").textContent = pendingConnection ? "选定访问环境与能力后，再允许首次连接。" : `${connection.profileIds.map(profileName).join("、") || "尚未授予环境"} · ${permissions.filter(permission => permission !== "read" && connection.permissions[permission]).length ? "已授予业务操作" : "仅读取"}`;
      el("mcp-client-status-label", "strong").textContent = statusNames[connection.status] || connection.status;
      el("mcp-client-dot", "i").className = connection.status;
      el("mcp-client-id", "span").textContent = pendingConnection ? `配对码 ${connection.pairingCode}` : connection.clientId.slice(0, 12);
      el("mcp-client-id", "span").title = connection.clientId;
      el("mcp-connection-note", "p").textContent = pendingConnection ? "首次连接：请核对客户端返回的配对码与访问范围。名称由客户端提供，默认仅读取。" : disconnected ? "已释放网页控制权。重连后先读取状态，不自动恢复操作或采集。" : revoked ? "已撤销此客户端授权，再次接入需要重新确认。" : "访问范围与业务能力在此管理。操作网页需要单独申请本次控制。";
      el("mcp-grant-button", "button").textContent = pendingConnection ? "允许连接" : "保存授权范围";
      el("mcp-grant-button", "button").disabled = !canEdit || (!dirty && !pendingConnection) || !options.state().profiles.length;
      el("mcp-deny-button", "button").hidden = !pendingConnection;
      el("mcp-deny-button", "button").disabled = busy;
      el("mcp-grant-actions", "div").hidden = revoked;
      for (const input of el("mcp-profile-list", "div").querySelectorAll<HTMLInputElement>("input")) input.disabled = !canEdit;
      for (const permission of permissions) el(`mcp-permission-${permission}`, "input").disabled = permission === "read" || !canEdit;
      el("mcp-disconnect-button", "button").disabled = busy || connection.status !== "connected";
      el("mcp-revoke-button", "button").disabled = busy || revoked || pendingConnection;
      const request = connection.requestedControl;
      el("mcp-control-request", "section").hidden = !request;
      if (request) {
        const group = options.state().sessionGroups.find(item => item.id === request.sessionId);
        el("mcp-control-request-description", "p").textContent = `${connection.name} 请求操作 ${profileName(request.profileId)}${group ? ` / ${group.name}` : ""}。${request.profileId !== options.state().activeProfileId ? "授权后，Agent 可显式保存当前采集并打开此环境。" : "采集与网页控制分别管理，你可以随时接管。"}`;
      }
      el("mcp-control-approve", "button").disabled = busy || !current?.enabled || Boolean(control && control.connectionId !== connection.id);
      el("mcp-control-deny", "button").disabled = busy;
      el("mcp-control-owner", "strong").textContent = control ? clientName(control.connectionId) : "你";
      el("mcp-control-note", "p").textContent = control ? "人工接管时采集继续；断线或到期后释放操作权。" : "连接和业务授权不等于网页控制权。";
    }
    if (current) { renderActivity(current); renderOperations(current); renderDeletes(current); }
    if (control) {
      for (const id of ["start-button", "pause-button", "stop-button", "snapshot-button", "back-button", "forward-button", "reload-button", "home-button"]) el(id, "button").disabled = true;
      el("address-input", "input").disabled = true;
      const submit = el("address-form", "form").querySelector<HTMLButtonElement>('button[type="submit"]'); if (submit) submit.disabled = true;
    } else {
      const submit = el("address-form", "form").querySelector<HTMLButtonElement>('button[type="submit"]'); if (submit) submit.disabled = !options.state().browser.available;
    }
  }

  el("mcp-open-button", "button").addEventListener("click", () => setPanel(!panelOpen));
  el("mcp-status-button", "button").addEventListener("click", () => {
    const pending = state()?.connections.find(connection => connection.status === "pending" || connection.requestedControl);
    if (pending) { selectedId = pending.id; dirty = false; draftSignature = ""; render(); }
    setPanel(true);
  });
  el("mcp-close-button", "button").addEventListener("click", () => { setPanel(false); el("mcp-open-button", "button").focus(); });
  el("mcp-service-button", "button").addEventListener("click", () => { void command({action:"enable",enabled:!state()?.enabled}); });
  el("mcp-takeover-button", "button").addEventListener("click", () => { void command({action:"takeover"}); });
  el("mcp-client-select", "select").addEventListener("change", event => {
    selectedId = (event.target as HTMLSelectElement).value; dirty = false; draftSignature = ""; el("mcp-grant-error", "p").hidden = true; render();
  });
  el("mcp-grant-form", "form").addEventListener("change", () => { dirty = true; el("mcp-grant-error", "p").hidden = true; render(); });
  el("mcp-grant-form", "form").addEventListener("submit", event => {
    event.preventDefault(); const connection = selected(); if (!connection) return;
    const profileIds = [...el("mcp-profile-list", "div").querySelectorAll<HTMLInputElement>("input:checked")].map(input => input.value);
    if (!profileIds.length) { el("mcp-grant-error", "p").textContent = "请至少选择一个可访问的 Profile。"; el("mcp-grant-error", "p").hidden = false; return; }
    const permissionValues = {read:true,capture:false,browser:false,organize:false,export:false};
    for (const permission of permissions) permissionValues[permission] = permission === "read" || el(`mcp-permission-${permission}`, "input").checked;
    void command({action:"grant",connectionId:connection.id,profileIds,permissions:permissionValues});
  });
  for (const [id, action] of [["mcp-deny-button","deny"],["mcp-disconnect-button","disconnect"],["mcp-revoke-button","revoke"],["mcp-control-deny","controlDeny"]] as const) {
    el(id, "button").addEventListener("click", () => { if (selectedId) void command({action,connectionId:selectedId}); });
  }
  el("mcp-control-approve", "button").addEventListener("click", () => {
    const connection = selected(); if (connection?.requestedControl) void command({action:"controlApprove",connectionId:connection.id,profileId:connection.requestedControl.profileId});
  });
  el("mcp-copy-config", "button").addEventListener("click", async () => {
    await loadConfig(); const field = el("mcp-config", "textarea");
    if (!field.value) return;
    try { await navigator.clipboard.writeText(field.value); options.notify("接入配置已复制", "在 MCP 客户端添加服务后，回到这里确认首次连接。"); }
    catch { field.focus(); field.select(); options.notify("接入配置已选中", "按 ⌘C 或 Ctrl+C 复制配置。"); }
  });
  el("mcp-setup", "details").addEventListener("toggle", () => { if (el("mcp-setup", "details").open) void loadConfig(); });
  return {render, controlled, get panelOpen() { return panelOpen; }};
}
