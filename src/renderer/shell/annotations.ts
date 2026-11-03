import { element as el, message } from "./dom";
import { formatTime } from "./format";
import type {
  AppState,
  CollectorAPI,
  EventPreview,
  SessionMetadata,
} from "../../shared/contracts/ui";
import type {
  Annotation,
  AnnotationSet,
  ExportRange,
} from "../../shared/contracts/annotations";
import { ANNOTATION_TEXT_LIMIT, DEFAULT_MARK_TEXT } from "../../shared/contracts/annotations";

const BOOKMARK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4V3Z"/></svg>';
interface Options {
  /** Selected recording that may be read (null when none or in the trash). */
  sessionId(): string | null;
  selectedSession(): SessionMetadata | null | undefined;
  state(): AppState;
  active(): boolean | null;
  busy(): boolean;
  inspect(event: EventPreview): Promise<void>;
  repaintTimeline(): void;
  notify(title: string, message?: string, error?: boolean): void;
}
const elapsed = (ms: number) => {
  const total = Math.max(0, ms) / 1000;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${(total % 60).toFixed(1).padStart(4, "0")}`;
};
const author = (value: Annotation["author"]) => (value === "agent" ? "Agent" : "人工");
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text) value.textContent = text;
  return value;
}

/** Bookmarks, notes and range export controls; all DOM is added here to keep the shell markup stable. */
export function createAnnotationsUI(api: CollectorAPI, options: Options) {
  let set: AnnotationSet | null = null;
  let loadedFor: string | null = null;
  let loading = 0;
  let listMode = false;
  let inspected: EventPreview | null = null;
  let editingId: string | null = null;
  let saving = false;
  const bySeq = new Map<number, Annotation[]>();

  const stylesheet = node("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = "annotations.css";
  document.head.append(stylesheet);

  // Recording controls: quick mark.
  const markButton = node("button", "button mark-button");
  markButton.id = "mark-button";
  markButton.type = "button";
  markButton.hidden = true;
  markButton.innerHTML = `${BOOKMARK}<span>标记</span>`;
  markButton.title = "在最新事件处添加书签（Ctrl+Shift+M）";
  el("stop-button", "button").before(markButton);

  // Timeline filter row: bookmark list toggle.
  const listButton = node("button", "bookmark-filter");
  listButton.id = "bookmark-filter";
  listButton.type = "button";
  listButton.setAttribute("aria-pressed", "false");
  listButton.title = "只看书签和标注";
  const listCount = node("span", "bookmark-count", "0");
  listButton.append("书签", listCount);
  required(document.querySelector(".timeline-filters")).append(listButton);

  const list = node("div", "annotation-list");
  list.id = "annotation-list";
  list.hidden = true;
  list.setAttribute("aria-label", "书签与标注");
  el("timeline-list", "div").after(list);

  // Details panel: notes of the inspected event.
  const editor = node("section", "annotation-editor");
  editor.id = "annotation-editor";
  editor.hidden = true;
  editor.setAttribute("aria-label", "事件标注");
  const notes = node("div", "annotation-notes");
  const form = node("form", "annotation-form");
  const textarea = node("textarea");
  textarea.id = "annotation-text";
  textarea.rows = 2;
  textarea.maxLength = ANNOTATION_TEXT_LIMIT;
  textarea.placeholder = "为此事件添加标注，例如：这里有问题";
  const actions = node("div", "annotation-form-actions");
  const save = node("button", "button primary");
  save.id = "annotation-save";
  save.type = "submit";
  save.innerHTML = `${BOOKMARK}<span>添加书签</span>`;
  const cancel = node("button", "button", "取消");
  cancel.type = "button";
  cancel.hidden = true;
  actions.append(cancel, save);
  form.append(textarea, actions);
  editor.append(notes, form);
  el("detail-meta", "div").after(editor);

  // Export dialog: optional range.
  const rangeSet = node("fieldset", "export-range");
  rangeSet.innerHTML = `<legend>导出范围</legend>
    <div class="export-range-modes"><label><input type="radio" name="export-range" value="all" id="export-range-all" checked>完整记录</label><label><input type="radio" name="export-range" value="range" id="export-range-slice">片段</label></div>
    <div class="export-range-fields" id="export-range-fields" hidden>
      <label>起点书签<select id="export-range-start-bookmark"></select></label>
      <label>终点书签<select id="export-range-end-bookmark"></select></label>
      <label>起始 seq<input id="export-range-start" type="number" min="1" step="1" inputmode="numeric"></label>
      <label>结束 seq<input id="export-range-end" type="number" min="1" step="1" inputmode="numeric"></label>
      <p class="export-range-hint" id="export-range-hint">从起点前最近的快照开始，保证片段可阅读和回放；书签与资源按片段裁剪。</p>
    </div>`;
  el("export-form", "form").querySelector(".export-note")?.before(rangeSet);
  const rangeAll = el("export-range-all", "input"), rangeSlice = el("export-range-slice", "input");
  const rangeFields = el("export-range-fields", "div");
  const rangeStart = el("export-range-start", "input"), rangeEnd = el("export-range-end", "input");
  const startBookmark = el("export-range-start-bookmark", "select"), endBookmark = el("export-range-end-bookmark", "select");

  async function run<T>(task: () => Promise<T>): Promise<T | undefined> {
    try {
      return await task();
    } catch (error) {
      options.notify("标注未保存", message(error).replace(/^Error invoking remote method '[^']+': Error: /, ""), true);
      return undefined;
    }
  }
  function apply(next: AnnotationSet | null) {
    set = next;
    bySeq.clear();
    for (const item of next?.annotations ?? []) {
      const items = bySeq.get(item.seq) ?? [];
      items.push(item);
      bySeq.set(item.seq, items);
    }
    render();
    options.repaintTimeline();
  }
  async function load(force = false) {
    const id = options.sessionId();
    if (!force && id === loadedFor) return;
    loadedFor = id;
    const version = ++loading;
    if (!id) {
      apply(null);
      return;
    }
    try {
      const next = await api.listAnnotations(id);
      if (version === loading && loadedFor === id) apply(next);
    } catch (error) {
      if (version === loading) {
        apply(null);
        options.notify("标注读取失败", message(error), true);
      }
    }
  }
  function annotationsFor(seq: number) {
    return bySeq.get(seq) ?? [];
  }
  function renderList() {
    const items = set?.annotations ?? [];
    listCount.textContent = String(items.length);
    listButton.classList.toggle("selected", listMode);
    listButton.classList.toggle("has-bookmarks", items.length > 0);
    listButton.setAttribute("aria-pressed", String(listMode));
    list.hidden = !listMode;
    el("timeline-list", "div").hidden = listMode;
    list.closest(".timeline-card")?.classList.toggle("bookmark-mode", listMode);
    if (!listMode) return;
    const fragment = document.createDocumentFragment();
    if (!items.length) {
      const empty = node("div", "timeline-empty");
      empty.append(node("strong", "", "暂无书签"), node("p", "", options.sessionId() ? "录制时点击「标记」，或在事件详情中添加标注。" : "先选择一条采集记录。"));
      fragment.append(empty);
    }
    for (const item of items) {
      const row = node("button", `annotation-row${inspected?.seq === item.seq ? " selected" : ""}`);
      row.type = "button";
      row.dataset.seq = String(item.seq);
      const icon = node("span", `annotation-icon ${item.author}`);
      icon.innerHTML = BOOKMARK;
      const body = node("span", "annotation-body");
      const meta = node("span", "annotation-meta", `#${String(item.seq).padStart(4, "0")}${item.endSeq ? `–${item.endSeq}` : ""} · ${elapsed(item.elapsedMs)} · ${author(item.author)}`);
      const text = node("span", "annotation-text", item.text);
      text.title = item.text;
      const type = node("span", "annotation-type", item.eventType);
      body.append(meta, text, type);
      row.append(icon, body);
      row.addEventListener("click", () => void jump(item.seq));
      fragment.append(row);
    }
    list.replaceChildren(fragment);
  }
  function renderEditor() {
    const id = options.sessionId();
    editor.hidden = !inspected || !id;
    if (editor.hidden || !inspected) return;
    const items = annotationsFor(inspected.seq);
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const note = node("div", `annotation-note${editingId === item.id ? " editing" : ""}`);
      const icon = node("span", `annotation-icon ${item.author}`);
      icon.innerHTML = BOOKMARK;
      const body = node("div", "annotation-note-body");
      body.append(node("p", "", item.text), node("small", "", `${author(item.author)} · ${formatTime(item.updatedAt)}${item.endSeq ? ` · 至 #${item.endSeq}` : ""}`));
      const edit = node("button", "text-button", "编辑");
      edit.type = "button";
      edit.dataset.annotationEdit = item.id;
      edit.addEventListener("click", () => {
        editingId = item.id;
        textarea.value = item.text;
        renderEditor();
        textarea.focus();
      });
      const remove = node("button", "text-button annotation-delete", "删除");
      remove.type = "button";
      remove.dataset.annotationDelete = item.id;
      remove.addEventListener("click", () => void removeNote(item));
      note.append(icon, body, edit, remove);
      fragment.append(note);
    }
    notes.replaceChildren(fragment);
    notes.hidden = !items.length;
    const editing = Boolean(editingId && items.some((item) => item.id === editingId));
    if (!editing) editingId = null;
    required(save.lastElementChild).textContent = editing ? "保存修改" : items.length ? "再添加一条" : "添加书签";
    cancel.hidden = !editing;
    save.disabled = saving;
  }
  function renderControls() {
    const active = Boolean(options.active());
    markButton.hidden = !active;
    markButton.disabled = options.busy() || saving || !options.state().session?.lastSeq;
  }
  function render() {
    renderControls();
    renderList();
    renderEditor();
  }
  async function jump(seq: number) {
    const id = options.sessionId();
    if (!id) return;
    const page = await run(() => api.getTimeline({ sessionId: id, afterSeq: seq - 1, limit: 1 }));
    const event = page?.events[0];
    if (!event || event.seq !== seq) {
      options.notify("书签位置不可用", `找不到事件 #${seq}`, true);
      return;
    }
    await options.inspect(event);
  }
  async function mark() {
    if (!options.active() || saving) return;
    saving = true;
    renderControls();
    const result = await run(() => api.markAnnotation());
    saving = false;
    if (result?.annotation) {
      if (loadedFor === result.recordingId) apply(result);
      options.notify("已标记", `#${result.annotation.seq} · ${DEFAULT_MARK_TEXT}。结束后可在事件详情中修改标注。`);
    }
    renderControls();
  }
  async function removeNote(item: Annotation) {
    const id = options.sessionId();
    if (!id || saving || !set) return;
    saving = true;
    const result = await run(() => api.deleteAnnotation({ sessionId: id, annotationId: item.id, expectedRevision: set!.revision }));
    saving = false;
    if (editingId === item.id) {
      editingId = null;
      textarea.value = "";
    }
    if (result) {
      apply(result);
      options.notify("已删除标注", `#${item.seq}`);
    } else void load(true);
    renderEditor();
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = options.sessionId(), target = inspected;
    if (!id || !target || saving) return;
    const text = textarea.value.trim() || DEFAULT_MARK_TEXT;
    saving = true;
    renderEditor();
    const revision = set?.revision;
    const result = await run(() =>
      editingId
        ? api.updateAnnotation({ sessionId: id, annotationId: editingId, text, ...(revision === undefined ? {} : { expectedRevision: revision }) })
        : api.createAnnotation({ sessionId: id, seq: target.seq, text, ...(revision === undefined ? {} : { expectedRevision: revision }) }),
    );
    saving = false;
    if (result) {
      const updated = Boolean(editingId);
      editingId = null;
      textarea.value = "";
      apply(result);
      options.notify(updated ? "标注已更新" : "已添加书签", `#${target.seq} · ${text}`);
    } else void load(true);
    renderEditor();
  });
  cancel.addEventListener("click", () => {
    editingId = null;
    textarea.value = "";
    renderEditor();
  });
  markButton.addEventListener("click", () => void mark());
  listButton.addEventListener("click", () => {
    listMode = !listMode;
    if (listMode) void load(true);
    render();
    if (!listMode) options.repaintTimeline();
  });
  document.querySelectorAll<HTMLElement>("[data-filter]").forEach((button) =>
    button.addEventListener("click", () => {
      if (!listMode) return;
      listMode = false;
      render();
    }),
  );
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "m" && !document.querySelector("dialog[open]")) {
      event.preventDefault();
      void mark();
    }
  });
  api.onAnnotations?.((change) => {
    if (change.sessionId === loadedFor && change.revision !== set?.revision) void load(true);
  });

  // Range export.
  function fillBookmarks() {
    const items = set?.annotations ?? [];
    for (const select of [startBookmark, endBookmark]) {
      const placeholder = node("option", "", items.length ? "选择书签…" : "暂无书签");
      placeholder.value = "";
      select.replaceChildren(placeholder, ...items.map((item) => {
        const option = node("option", "", `#${item.seq}${item.endSeq ? `–${item.endSeq}` : ""} · ${item.text.slice(0, 24)}`);
        option.value = item.id;
        return option;
      }));
      select.disabled = !items.length;
    }
    const session = options.selectedSession();
    const first = items[0], last = items.at(-1);
    rangeStart.max = rangeEnd.max = String(session?.lastSeq || 1);
    rangeStart.value = String(inspected?.seq ?? first?.seq ?? 1);
    rangeEnd.value = String(Math.max(Number(rangeStart.value), last ? last.endSeq ?? last.seq : session?.lastSeq || 1));
  }
  function validateRange() {
    const slice = rangeSlice.checked, start = Number(rangeStart.value), end = Number(rangeEnd.value);
    rangeFields.hidden = !slice;
    rangeStart.required = rangeEnd.required = slice;
    let error = "";
    if (slice && (!Number.isSafeInteger(start) || start < 1)) error = "请输入有效的起始 seq";
    else if (slice && (!Number.isSafeInteger(end) || end < start)) error = "结束 seq 不能早于起始 seq";
    rangeEnd.setCustomValidity(error);
    el("export-range-hint", "p").textContent = error || "从起点前最近的快照开始，保证片段可阅读和回放；书签与资源按片段裁剪。";
    el("export-range-hint", "p").classList.toggle("error", Boolean(error));
  }
  startBookmark.addEventListener("change", () => {
    const item = set?.annotations.find((value) => value.id === startBookmark.value);
    if (item) rangeStart.value = String(item.seq);
    validateRange();
  });
  endBookmark.addEventListener("change", () => {
    const item = set?.annotations.find((value) => value.id === endBookmark.value);
    if (item) rangeEnd.value = String(item.endSeq ?? item.seq);
    validateRange();
  });
  for (const input of [rangeAll, rangeSlice, rangeStart, rangeEnd]) input.addEventListener("input", validateRange);
  el("export-button", "button").addEventListener("click", () => {
    rangeAll.checked = true;
    fillBookmarks();
    validateRange();
  });

  return {
    /** Mark timeline rows that carry notes. */
    decorate(button: HTMLButtonElement, event: EventPreview) {
      const items = annotationsFor(event.seq);
      const covered = set?.annotations.some((item) => item.endSeq !== null && event.seq > item.seq && event.seq <= item.endSeq);
      button.classList.toggle("in-annotation-range", Boolean(covered));
      // Rows are reused across renders, so clear any previous decoration first.
      button.querySelectorAll(".annotation-flag, .event-annotation").forEach((item) => item.remove());
      button.classList.remove("annotated");
      delete button.dataset.annotated;
      if (!items.length) return;
      button.classList.add("annotated");
      button.dataset.annotated = String(items.length);
      const flag = node("span", `annotation-flag ${items.some((item) => item.author === "user") ? "user" : "agent"}`);
      flag.innerHTML = BOOKMARK;
      flag.title = items.map((item) => `${author(item.author)}：${item.text}`).join("\n");
      const first = button.querySelector(".event-first-line .event-time");
      if (first) first.before(flag);
      else button.append(flag);
      const note = node("span", "event-annotation", items[0]!.text);
      note.title = flag.title;
      button.querySelector(".event-summary")?.after(note);
    },
    inspected(event: EventPreview | null) {
      if (inspected?.seq !== event?.seq) {
        editingId = null;
        textarea.value = "";
      }
      inspected = event;
      renderEditor();
      if (listMode) renderList();
    },
    range(): ExportRange | undefined {
      if (!rangeSlice.checked) return undefined;
      return { startSeq: Number(rangeStart.value), endSeq: Number(rangeEnd.value) };
    },
    sync() {
      if (options.sessionId() !== loadedFor) {
        inspected = null;
        editingId = null;
        void load();
      }
      renderControls();
      if (listMode) renderList();
    },
  };
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing annotation UI element");
  return value;
}
