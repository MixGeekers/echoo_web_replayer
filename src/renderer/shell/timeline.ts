import { element as el, required, message } from "./dom";
import { svg } from "./icons";
import { object } from "../../shared/runtime";
import { formatTime, escapeText } from "./format";
import type {
  CollectorAPI,
  AppState,
  EventPreview,
  SessionMetadata,
  TimelineQuery,
} from "../../shared/contracts/ui";
import type { ReplayPanel } from "../replay-panel";
import { networkPresentation, isNetworkEvent, networkDetail, NETWORK_DETAIL_BYTES } from "./network-view";
interface Options {
  sessionId(): string | null;
  selectedSession(): SessionMetadata | null | undefined;
  state(): AppState;
  active(): boolean | null;
  notify(title: string, message?: string, error?: boolean): void;
  /** Optional row decoration, such as an annotation bookmark marker. */
  decorate?(button: HTMLButtonElement, event: EventPreview): void;
  /** Called when the details panel shows an event. */
  inspected?(event: EventPreview | null): void;
}
export function createTimeline(
  api: CollectorAPI,
  replay: ReplayPanel,
  options: Options,
) {
  let selectedSessionId: string | null = null;
  async function run<T>(task: () => Promise<T>): Promise<T | undefined> {
    try {
      return await task();
    } catch (error) {
      options.notify("操作未完成", message(error), true);
      return undefined;
    }
  }
  let selectedEventId: string | null = null;
  let filter = "all";
  let search = "";
  let events: EventPreview[] = [];
  let timelineTotal = 0;
  const timelineWindowLimit = 2000;
  let timelineInitialized = false;
  let timelineLoading = false;
  let pendingRefresh = false;
  let hasEarlierEvents = false;
  let liveCursor = 0;
  let timelineSnapshotSeq = 0;
  let follow = true;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let requestVersion = 0;
  function eventPresentation(event: EventPreview): [string, string, string] {
    const type = event.type || "";
    const descriptions: Record<string, [string, string, string]> = {
      "action.click": ["点击元素", "click", "action"],
      "action.dblclick": ["双击元素", "click", "action"],
      "action.input": ["输入内容", "input", "action"],
      "action.change": ["更改表单", "input", "action"],
      "action.keydown": ["键盘操作", "key", "action"],
      "action.submit": ["提交表单", "arrow-right", "action"],
      "action.focus": ["聚焦元素", "click", "action"],
      "action.scroll": ["滚动页面", "scroll", "action"],
      "dom.mutation": ["DOM 变化", "code", "dom"],
      "dom.snapshot": ["页面快照", "camera", "snapshot"],
      "page.navigation": ["页面导航", "globe", "page"],
      "page.navigate": ["页面导航", "globe", "page"],
      "page.lifecycle": ["页面生命周期", "globe", "page"],
      "page.error": ["页面错误", "info", "page"],
      "session.start": ["开始采集", "record", "session"],
      "session.pause": ["暂停采集", "pause", "session"],
      "session.resume": ["继续采集", "play", "session"],
      "session.stop": ["结束采集", "stop", "session"],
    };
    const network = networkPresentation(event);
    if (network) return network;
    const specific = descriptions[type];
    if (specific) return specific;
    if (type.startsWith("page.")) return ["页面事件", "globe", "page"];
    if (type.startsWith("session.")) return ["采集事件", "record", "session"];
    if (type.startsWith("action.")) return ["用户操作", "click", "action"];
    return [type || "采集事件", "document", "session"];
  }

  function eventSummary(event: EventPreview): string {
    if (typeof event.summary === "string") return event.summary;
    const payload = object(event.payload),
      target = object(payload.target);
    const selector = String(
      target.selector || payload.selector || target.tagName || target.tag || "",
    );
    if (event.type === "dom.mutation")
      return `${Array.isArray(payload.mutations) ? payload.mutations.length : Array.isArray(payload.records) ? payload.records.length : (payload.count ?? "多项")} 项页面变化${payload.reason ? ` · ${String(payload.reason)}` : ""}`;
    if (event.type === "dom.snapshot")
      return `${String(payload.reason || "完整 DOM 快照")} · ${String(event.title || payload.title || event.url || "")}`;
    if (event.type.startsWith("page."))
      return String(
        payload.url ||
          payload.name ||
          payload.phase ||
          payload.reason ||
          event.url ||
          "",
      );
    if (event.type === "action.keydown")
      return `${String(payload.key || payload.code || "")}${selector ? ` · ${selector}` : ""}`;
    if (event.type === "action.input" || event.type === "action.change")
      return `${selector || "表单元素"}${payload.value !== undefined ? ` → ${String(payload.value)}` : target.value !== undefined ? ` → ${String(target.value)}` : ""}`;
    return String(
      selector ||
        payload.reason ||
        payload.message ||
        target.text ||
        event.url ||
        "",
    );
  }

  function renderEmpty(kind: string) {
    const empty = document.createElement("div");
    empty.className = "timeline-empty";
    const title = document.createElement("strong");
    title.textContent = kind === "filter" ? "没有匹配的事件" : "暂无事件";
    const p = document.createElement("p");
    p.textContent =
      kind === "filter"
        ? "更换关键词或筛选条件。"
        : options.active() && selectedSessionId === options.state().session?.id
          ? options.state().session?.status === "paused"
            ? "继续采集后记录页面操作。"
            : "操作页面后，记录会显示在这里。"
          : selectedSessionId
            ? "此采集记录没有事件。"
            : "点击「开始采集」记录页面操作。";
    empty.append(title, p);
    return empty;
  }

  // 行节点按事件复用：实时刷新只创建新增事件的行，已有行仅调整顺序和选中状态。
  const rows = new Map<string, { event: EventPreview; button: HTMLButtonElement }>();
  const eventsById = new Map<string, EventPreview>();
  const rowKey = (event: EventPreview) => event.id ?? `seq:${event.seq}`;
  function buildRow(event: EventPreview): HTMLButtonElement {
    const [label, iconName, category] = eventPresentation(event);
    const summaryText = escapeText(eventSummary(event), 500);
    const button = document.createElement("button");
    button.className = `timeline-event${category.endsWith(" issue") ? " issue" : ""}`;
    button.dataset.eventId = rowKey(event);
    button.setAttribute(
      "aria-label",
      `${label} ${formatTime(event.timestamp)} ${summaryText}`,
    );
    const icon = document.createElement("span");
    icon.className = `event-icon ${category}`;
    icon.innerHTML = svg(iconName);
    const body = document.createElement("span");
    body.className = "event-body";
    const first = document.createElement("span");
    first.className = "event-first-line";
    const name = document.createElement("span");
    name.className = "event-name";
    name.textContent = label;
    const time = document.createElement("span");
    time.className = "event-time";
    time.textContent = formatTime(event.timestamp);
    first.append(name, time);
    const summary = document.createElement("span");
    summary.className = "event-summary";
    summary.textContent = summaryText;
    summary.title = summaryText;
    const seq = document.createElement("span");
    seq.className = "event-seq";
    seq.textContent = `#${String(event.seq ?? "").padStart(4, "0")} · ${event.type}`;
    body.append(first, summary, seq);
    button.append(icon, body);
    return button;
  }
  function renderTimeline() {
    const list = el("timeline-list", "div");
    const previousScroll = list.scrollTop;
    const fragment = document.createDocumentFragment();
    if (!events.length)
      fragment.append(
        renderEmpty(search || filter !== "all" ? "filter" : "empty"),
      );
    eventsById.clear();
    for (const event of events) {
      const key = rowKey(event);
      eventsById.set(key, event);
      let row = rows.get(key);
      if (!row || row.event !== event) {
        row = { event, button: buildRow(event) };
        rows.set(key, row);
      }
      row.button.classList.toggle("selected", event.id === selectedEventId);
      options.decorate?.(row.button, event);
      fragment.append(row.button);
    }
    for (const id of rows.keys()) if (!eventsById.has(id)) rows.delete(id);
    list.replaceChildren(fragment);
    if (!follow || previousScroll > 10) list.scrollTop = previousScroll;
    el("timeline-count", "span").textContent = String(
      options.selectedSession()?.eventCount || 0,
    );
    el("timeline-display-count", "span").textContent =
      events.length < timelineTotal
        ? `${events.length} / ${timelineTotal} 条`
        : `${timelineTotal} 条事件`;
    el("load-more-button", "button").hidden = !hasEarlierEvents;
    el("load-more-button", "button").disabled = timelineLoading;
    el("timeline-display-count", "span").title =
      events.length >= timelineWindowLimit
        ? "当前保留最近查看的 2,000 条；加载更早事件会向前移动显示范围。"
        : "";
  }

  function timelineRequest(): TimelineQuery {
    if (!selectedSessionId) throw new Error("尚未选择采集记录");
    return {
      sessionId: selectedSessionId,
      ...(filter !== "all" ? { types: [filter] } : {}),
      ...(search ? { query: search } : {}),
    };
  }

  async function refreshTimeline(reset = false) {
    selectedSessionId = options.sessionId();
    if (reset) {
      requestVersion++;
      timelineInitialized = false;
      events = [];
      timelineTotal = 0;
      liveCursor = 0;
      timelineSnapshotSeq = 0;
      hasEarlierEvents = false;
      renderTimeline();
    }
    if (timelineLoading) {
      pendingRefresh = true;
      return;
    }
    const version = requestVersion;
    if (!selectedSessionId) {
      events = [];
      timelineTotal = 0;
      renderTimeline();
      return;
    }
    timelineLoading = true;
    const initial = !timelineInitialized;
    try {
      const result = await api.getTimeline({
        ...timelineRequest(),
        limit: initial ? 100 : 500,
        ...(initial ? {} : { afterSeq: liveCursor }),
      });
      if (version !== requestVersion) return;
      const incoming = result.events || [];
      const merged = [
        ...new Map(
          [...(initial ? [] : events), ...incoming].map((event) => [
            event.id,
            event,
          ]),
        ).values(),
      ].sort((a, b) => b.seq - a.seq);
      events = merged.slice(0, timelineWindowLimit);
      timelineTotal = result.total || 0;
      timelineSnapshotSeq = result.snapshotSeq || timelineSnapshotSeq;
      liveCursor = initial
        ? result.snapshotSeq || incoming[0]?.seq || 0
        : (result.scannedThroughSeq ?? liveCursor);
      hasEarlierEvents = initial
        ? Boolean(result.hasMore)
        : hasEarlierEvents || merged.length > timelineWindowLimit;
      timelineInitialized = true;
      if (!initial && result.hasMore && follow) pendingRefresh = true;
      renderTimeline();
    } catch (error) {
      if (version === requestVersion)
        options.notify("时间线读取失败", message(error), true);
    } finally {
      timelineLoading = false;
      el("load-more-button", "button").disabled = false;
      if (pendingRefresh) {
        pendingRefresh = false;
        scheduleRefresh();
      }
    }
  }

  async function loadEarlier() {
    if (!selectedSessionId || !hasEarlierEvents || timelineLoading) return;
    const version = requestVersion;
    timelineLoading = true;
    setFollow(false);
    el("load-more-button", "button").disabled = true;
    try {
      const page = await api.getTimeline({
        ...timelineRequest(),
        beforeSeq: events.at(-1)?.seq,
        snapshotSeq: timelineSnapshotSeq,
        limit: 100,
      });
      if (version !== requestVersion) return;
      const merged = [
        ...new Map(
          [...events, ...(page.events || [])].map((event) => [event.id, event]),
        ).values(),
      ].sort((a, b) => b.seq - a.seq);
      events = merged.slice(-timelineWindowLimit);
      timelineTotal = page.total || 0;
      hasEarlierEvents = Boolean(page.hasMore);
      renderTimeline();
    } catch (error) {
      if (version === requestVersion)
        options.notify("读取历史事件失败", message(error), true);
    } finally {
      timelineLoading = false;
      el("load-more-button", "button").disabled = false;
      if (pendingRefresh) {
        pendingRefresh = false;
        scheduleRefresh();
      }
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (follow || !timelineInitialized) refreshTimeline();
    }, 240);
  }

  function setFollow(value: boolean) {
    follow = value;
    el("follow-button", "button").classList.toggle("selected", follow);
    el("follow-button", "button").setAttribute("aria-pressed", String(follow));
    required(el("follow-button", "button").lastChild).textContent = follow
      ? "实时"
      : "已固定";
    el("follow-button", "button").title = follow
      ? "跟随最新事件"
      : "正在查看固定时间线，不影响录制；点击返回最新事件";
  }

  async function inspectEvent(event: EventPreview) {
    const eventId = event.id;
    if (!eventId || !selectedSessionId) return;
    selectedEventId = eventId;
    el("event-detail", "div").hidden = false;
    el("detail-kind", "span").textContent = event.type;
    el("detail-title", "strong").textContent = "事件详情";
    el("detail-meta", "div").textContent =
      `#${event.seq} · ${formatTime(event.timestamp)} · ${event.url || "本地记录"}`;
    el("detail-json", "pre").textContent = "正在读取事件…";
    options.inspected?.(event);
    renderTimeline();
    if (replay.active) replay.seek(undefined, event.seq);
    const full = await run(() =>
      api.getEvent({
        sessionId: required(selectedSessionId),
        eventId,
        preview: true,
        maxBytes: isNetworkEvent(event.type) ? NETWORK_DETAIL_BYTES : 100000,
      }),
    );
    if (selectedEventId !== eventId) return;
    const formatted = full && networkDetail(event.type, String(full.preview ?? ""), full.truncated === true);
    if (formatted) el("detail-json", "pre").textContent = formatted;
    else if (full) {
      let preview = typeof full.preview === "string" ? full.preview : "";
      if (!full.truncated) {
        try {
          preview = JSON.stringify(JSON.parse(preview), null, 2);
        } catch {}
      }
      el("detail-json", "pre").textContent = full.truncated
        ? `${preview}\n\n… 仅预览前 100 KB（原事件 ${Number(full.bytes).toLocaleString()} 字节）。完整内容保留在导出包中。`
        : preview;
    } else el("detail-json", "pre").textContent = "无法读取该事件。";
  }

  el("follow-button", "button").addEventListener("click", () => {
    setFollow(!follow);
    if (follow) {
      el("timeline-list", "div").scrollTop = 0;
      refreshTimeline(true);
    }
  });
  document.querySelectorAll<HTMLElement>("[data-filter]").forEach((button) =>
    button.addEventListener("click", () => {
      filter = button.dataset.filter ?? "all";
      document
        .querySelectorAll<HTMLElement>("[data-filter]")
        .forEach((b) => b.classList.toggle("selected", b === button));
      el("timeline-list", "div").scrollTop = 0;
      refreshTimeline(true);
    }),
  );
  el("search-input", "input").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      search = el("search-input", "input").value.trim();
      refreshTimeline(true);
    }, 200);
  });
  el("load-more-button", "button").addEventListener("click", loadEarlier);
  el("timeline-list", "div").addEventListener("click", (domEvent) => {
    const target = domEvent.target;
    if (!(target instanceof Element)) return;
    const id = target.closest<HTMLElement>(".timeline-event")?.dataset.eventId;
    const event = id ? eventsById.get(id) : undefined;
    if (event) void inspectEvent(event);
  });
  el("close-detail-button", "button").addEventListener("click", () => {
    selectedEventId = null;
    el("event-detail", "div").hidden = true;
    options.inspected?.(null);
    renderTimeline();
  });
  return {
    refresh: refreshTimeline,
    schedule: scheduleRefresh,
    render: renderTimeline,
    inspect: inspectEvent,
    get follow() {
      return follow;
    },
    clear() {
      selectedEventId = null;
      events = [];
      el("event-detail", "div").hidden = true;
    },
  };
}
