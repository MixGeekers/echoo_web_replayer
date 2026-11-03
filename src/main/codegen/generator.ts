/**
 * Pure Playwright script generator. Events are pushed one at a time so that
 * callers can stream huge timelines; only the (small) step list is retained.
 */
import type {
  CodegenLanguage,
  CodegenOptions,
  CodegenResult,
  CodegenStats,
} from "../../shared/contracts/codegen";

export interface CodegenRecording {
  id: string;
  name: string;
  url?: string | undefined;
  startedAt?: string | undefined;
}
/** The subset of a stored timeline event the generator reads. */
export interface CodegenEvent {
  seq?: unknown;
  type?: unknown;
  url?: unknown;
  timestamp?: unknown;
  elapsedMs?: unknown;
  documentId?: unknown;
  payload?: unknown;
}

type Rec = Record<string, unknown>;
const obj = (value: unknown): Rec =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : {};
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

/** Short labels from the recorder are reliable locators; long text is not. */
const MAX_LOCATOR_TEXT = 80;
const LABEL_CLICK_WINDOW_MS = 120;
const SUBMIT_WINDOW_MS = 2000;
const REDIRECT_WINDOW_MS = 3000;
const TEXT_INPUT_TYPES = new Set([
  "", "text", "email", "password", "search", "tel", "url", "number",
  "date", "datetime-local", "month", "time", "week", "color", "range",
]);
const ARIA_ROLES = new Set([
  "alert", "alertdialog", "application", "article", "banner", "blockquote", "button", "caption", "cell",
  "checkbox", "code", "columnheader", "combobox", "complementary", "contentinfo", "definition", "deletion",
  "dialog", "directory", "document", "emphasis", "feed", "figure", "form", "generic", "grid", "gridcell",
  "group", "heading", "img", "insertion", "link", "list", "listbox", "listitem", "log", "main", "marquee",
  "math", "meter", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "navigation", "none",
  "note", "option", "paragraph", "presentation", "progressbar", "radio", "radiogroup", "region", "row",
  "rowgroup", "rowheader", "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton", "status",
  "strong", "subscript", "superscript", "switch", "tab", "table", "tablist", "tabpanel", "term", "textbox",
  "time", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
]);
const MODIFIER_KEYS = new Set([
  "Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "NumLock", "ScrollLock", "Fn", "FnLock", "OS", "Hyper", "Super",
]);
const IGNORED_KEYS = new Set(["Process", "Unidentified", "Dead", ""]);
const CARET_KEYS = new Set([
  "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown",
]);
const EDIT_SHORTCUT_LETTERS = new Set(["a", "c", "v", "x", "z", "y"]);

/** Port of CSS.escape for identifiers (https://drafts.csswg.org/cssom/#serialize-an-identifier). */
export function cssEscape(value: string): string {
  let result = "";
  const length = value.length;
  const first = value.charCodeAt(0);
  for (let index = 0; index < length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0) result += "\uFFFD";
    else if (
      (code >= 0x1 && code <= 0x1f) ||
      code === 0x7f ||
      (index === 0 && code >= 0x30 && code <= 0x39) ||
      (index === 1 && code >= 0x30 && code <= 0x39 && first === 0x2d)
    )
      result += `\\${code.toString(16)} `;
    else if (index === 0 && length === 1 && code === 0x2d) result += `\\${value.charAt(index)}`;
    else if (
      code >= 0x80 ||
      code === 0x2d ||
      code === 0x5f ||
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a)
    )
      result += value.charAt(index);
    else result += `\\${value.charAt(index)}`;
  }
  return result;
}

function escapeControl(code: number, python: boolean): string {
  if (code <= 0xff) return `\\x${code.toString(16).padStart(2, "0")}`;
  return python ? `\\u${code.toString(16).padStart(4, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
}
/** Single-quoted TypeScript/JavaScript string literal. */
export function tsString(value: string): string {
  let out = "'";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "\\") out += "\\\\";
    else if (char === "'") out += "\\'";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 || (code >= 0xd800 && code <= 0xdfff))
      out += escapeControl(code, false);
    else out += char;
  }
  return `${out}'`;
}
/** Double-quoted Python 3 string literal (UTF-8 source). */
export function pyString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 || (code >= 0xd800 && code <= 0xdfff))
      out += escapeControl(code, true);
    else out += char;
  }
  return `${out}"`;
}
/** Comments must stay on one line whatever the recorded page text contains. */
const commentText = (value: string, max = 160) => {
  const clean = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

export type LocatorChoice =
  | { kind: "testId"; value: string }
  | { kind: "role"; role: string; name: string; exact: boolean }
  | { kind: "label"; value: string }
  | { kind: "placeholder"; value: string }
  | { kind: "css"; value: string }
  | { kind: "text"; value: string };
interface FrameHop {
  selector: string;
  shadowHosts: string[];
}
export interface CodegenTarget {
  key: string;
  tag: string;
  type: string;
  editable: boolean;
  /** null when a same-origin frame on the path has no usable selector. */
  frames: FrameHop[] | null;
  shadowHosts: string[];
  locator: LocatorChoice | null;
  documentTarget: boolean;
}

function inputType(tag: string, attributes: Rec): string {
  return tag === "input" ? str(attributes.type).toLowerCase() : "";
}
/** Choose one locator: testId > role/name > label > placeholder > #id > text > css. */
export function chooseLocator(target: Rec): LocatorChoice | null {
  const tag = str(target.tagName).toLowerCase();
  const attributes = obj(target.attributes);
  const text = normalize(str(target.text));
  const candidates = Array.isArray(target.locators) ? target.locators.map(obj) : [];
  const of = (strategy: string) => candidates.filter((c) => c.strategy === strategy && typeof c.value === "string");
  const formControl = tag === "input" || tag === "select" || tag === "textarea";
  for (const c of of("testId")) {
    const value = str(c.value);
    if (value) return { kind: "testId", value };
  }
  if (!formControl)
    for (const c of of("role")) {
      const role = str(c.value).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      const name = normalize(str(c.name));
      if (!ARIA_ROLES.has(role) || role === "none" || role === "presentation" || role === "generic") continue;
      if (!name || name.length > MAX_LOCATOR_TEXT) continue;
      const ariaLabel = normalize(str(attributes["aria-label"]));
      return { kind: "role", role, name, exact: ariaLabel !== "" && ariaLabel === name };
    }
  // aria-label replaces <label> text as the accessible name, which is what getByLabel matches.
  const ariaLabel = str(attributes["aria-label"]);
  const labels = of("label").sort((a, b) => Number(str(b.value) === ariaLabel) - Number(str(a.value) === ariaLabel));
  for (const c of labels) {
    let value = normalize(str(c.value));
    // A <label> wrapping a <select> also contains every option's text.
    if (text && (tag === "select" || tag === "textarea") && value.includes(text)) value = normalize(value.replace(text, ""));
    if (value && value.length <= MAX_LOCATOR_TEXT) return { kind: "label", value };
  }
  for (const c of of("placeholder")) {
    const value = str(c.value);
    if (value.trim() && value.length <= MAX_LOCATOR_TEXT) return { kind: "placeholder", value };
  }
  for (const c of of("id")) {
    const value = str(c.value);
    if (value) return { kind: "css", value: `#${cssEscape(value)}` };
  }
  if (!formControl && tag !== "html" && tag !== "body")
    for (const c of of("text")) {
      const value = normalize(str(c.value));
      if (value && value.length <= MAX_LOCATOR_TEXT) return { kind: "text", value };
    }
  for (const c of of("css")) {
    const value = str(c.value);
    if (value) return { kind: "css", value };
  }
  const selector = str(target.selector);
  return selector ? { kind: "css", value: selector } : null;
}

export function describeTarget(rawTarget: unknown, documentId: string): CodegenTarget | null {
  const target = obj(rawTarget);
  const nodeId = str(target.nodeId);
  if (!nodeId) return null;
  const scope = obj(target.scope);
  const tag = str(target.tagName).toLowerCase() || str(target.nodeName).toLowerCase();
  const attributes = obj(target.attributes);
  const type = inputType(tag, attributes);
  const contentEditable = "contenteditable" in attributes && str(attributes.contenteditable).toLowerCase() !== "false";
  const editable =
    tag === "textarea" || (tag === "input" && TEXT_INPUT_TYPES.has(type)) || contentEditable;
  let frames: FrameHop[] | null = [];
  const contexts = Array.isArray(scope.frameContexts) ? scope.frameContexts.map(obj) : [];
  for (const context of contexts) {
    const selector = str(context.selector);
    const hosts = Array.isArray(context.shadowPath) ? context.shadowPath : [];
    if (!selector || hosts.some((host) => typeof host !== "string" || !host)) {
      frames = null;
      break;
    }
    frames.push({ selector, shadowHosts: hosts as string[] });
  }
  if (frames && !contexts.length && Array.isArray(scope.framePath) && scope.framePath.length) {
    // Older captures only carried framePath.
    for (const selector of scope.framePath) {
      if (typeof selector !== "string" || !selector) {
        frames = null;
        break;
      }
      frames.push({ selector, shadowHosts: [] });
    }
  }
  const shadowPath = Array.isArray(scope.shadowPath) ? scope.shadowPath : [];
  const shadowHosts = shadowPath.every((host) => typeof host === "string" && host)
    ? (shadowPath as string[])
    : [];
  const nodeType = num(target.nodeType);
  return {
    key: `${documentId}|${str(scope.rootId)}|${nodeId}`,
    tag,
    type,
    editable,
    frames,
    shadowHosts,
    locator: nodeType === 9 ? null : chooseLocator(target),
    documentTarget: nodeType === 9 || tag === "#document",
  };
}

type StepBase = { seqs: number[]; at: number };
export type Step = StepBase &
  (
    | { op: "goto"; url: string; note?: string }
    | { op: "reload" }
    | { op: "click"; target: CodegenTarget; button: string | null; modifiers: string[]; detail: number; x: number | null; y: number | null }
    | { op: "dblclick"; target: CodegenTarget; modifiers: string[] }
    | { op: "fill"; target: CodegenTarget; value: string }
    | { op: "check" | "uncheck"; target: CodegenTarget }
    | { op: "select"; target: CodegenTarget; values: string[] }
    | { op: "press"; target: CodegenTarget | null; key: string }
    | { op: "submit"; target: CodegenTarget }
    | { op: "files"; target: CodegenTarget; names: string[] }
    | { op: "scroll"; target: CodegenTarget | null; x: number; y: number }
    | { op: "expectUrl"; url: string }
    | { op: "comment"; text: string; todo: boolean }
  );
type TargetStep = Step & { target: CodegenTarget };
const ACTION_OPS = new Set(["click", "dblclick", "fill", "check", "uncheck", "select", "press", "submit", "files"]);

function modifierList(payload: Rec): string[] {
  const m = obj(payload.modifiers);
  const list: string[] = [];
  if (m.alt === true) list.push("Alt");
  if (m.ctrl === true) list.push("Control");
  if (m.meta === true) list.push("Meta");
  if (m.shift === true) list.push("Shift");
  return list;
}
function sameTarget(step: Step | undefined, target: CodegenTarget): step is TargetStep {
  return !!step && "target" in step && !!step.target && step.target.key === target.key;
}
const hasTarget = (step: Step): step is TargetStep => "target" in step && !!step.target;

export class ScriptBuilder {
  private readonly steps: Step[] = [];
  private readonly fills = new Map<string, Extract<Step, { op: "fill" }>>();
  private readonly omitted: Record<string, number> = {};
  private readonly warnings = new Set<string>();
  private readonly options: { includeScroll: boolean; maxSteps: number };
  private events = 0;
  private actions = 0;
  private navigations = 0;
  private firstSeq: number | null = null;
  private lastSeq: number | null = null;
  private startUrl = "";
  private currentUrl = "";
  private started = false;
  private paused = false;
  private actionSinceNavigation = false;
  private lastNavigation: { at: number; asserted: boolean } | null = null;
  private truncated = 0;
  private passwords = false;
  constructor(private readonly recording: CodegenRecording, options: CodegenOptions = {}) {
    this.options = {
      includeScroll: options.includeScroll === true,
      maxSteps: options.maxSteps && options.maxSteps > 0 ? Math.floor(options.maxSteps) : 20000,
    };
  }
  private omit(kind: string) {
    this.omitted[kind] = (this.omitted[kind] ?? 0) + 1;
  }
  private push(step: Step) {
    if (this.steps.length >= this.options.maxSteps) {
      this.truncated++;
      return;
    }
    this.steps.push(step);
    if (ACTION_OPS.has(step.op)) this.actionSinceNavigation = true;
  }
  private last(): Step | undefined {
    return this.steps.at(-1);
  }
  private ensureStart(url: string, seq: number, at: number) {
    if (this.started) return;
    this.started = true;
    this.startUrl = url || this.recording.url || "about:blank";
    this.currentUrl = this.startUrl;
    this.steps.push({ op: "goto", url: this.startUrl, seqs: seq ? [seq] : [], at });
  }
  /** Feed one timeline event in seq order. */
  add(event: CodegenEvent): void {
    this.events++;
    const type = str(event.type);
    const seq = num(event.seq) ?? 0;
    if (seq) {
      this.firstSeq ??= seq;
      this.lastSeq = seq;
    }
    const payload = obj(event.payload);
    const url = str(event.url);
    const at = num(event.elapsedMs) ?? 0;
    const stamp = Date.parse(str(event.timestamp));
    const time = Number.isFinite(stamp) ? stamp : at;
    if (type === "session.start") {
      this.ensureStart(url, seq, at);
      return;
    }
    if (type.startsWith("dom.") || type === "page.resource" || type === "page.image" || type === "page.lifecycle" || type === "page.resize")
      return;
    if (!this.started) this.ensureStart(url, 0, at);
    if (type.startsWith("action.")) this.actions++;
    switch (type) {
      case "session.pause":
        this.paused = true;
        this.push({ op: "comment", text: `seq ${seq} 采集已暂停：暂停期间的操作没有记录，下面的步骤可能缺少中间操作。`, todo: false, seqs: [], at });
        return;
      case "session.resume": {
        this.paused = false;
        const resumeUrl = url;
        if (resumeUrl && resumeUrl !== this.currentUrl && /^(https?|file):/i.test(resumeUrl)) {
          this.push({ op: "comment", text: `暂停期间页面从 ${commentText(this.currentUrl, 120)} 变为 ${commentText(resumeUrl, 120)}，以下直接打开恢复时的页面；请补充暂停期间的操作。`, todo: true, seqs: [], at });
          this.push({ op: "goto", url: resumeUrl, seqs: [seq], at, note: "恢复采集" });
          this.currentUrl = resumeUrl;
          this.actionSinceNavigation = false;
        } else this.push({ op: "comment", text: `seq ${seq} 恢复采集`, todo: false, seqs: [], at });
        return;
      }
      case "session.stop":
        return;
      case "session.interrupted":
        this.push({ op: "comment", text: `seq ${seq} 采集曾被中断，之后的操作可能缺失。`, todo: true, seqs: [], at });
        return;
      case "recorder.error":
        if (payload.possibleGap === true || payload.operation || payload.message)
          this.push({ op: "comment", text: `seq ${seq} 采集错误${payload.possibleGap === true ? "（可能存在采集空白）" : ""}：${commentText(str(payload.message) || str(payload.operation), 120)}`, todo: true, seqs: [], at });
        return;
      case "page.error":
        this.push({ op: "comment", text: `seq ${seq} 页面加载失败 ${commentText(str(payload.url), 120)}：${commentText(str(payload.errorDescription), 80)}`, todo: true, seqs: [], at });
        return;
      case "page.popup":
        this.push({ op: "comment", text: `seq ${seq} 网页请求打开新窗口（${commentText(str(payload.url), 120)}）；TraceDock 在当前页加载，真实浏览器中可能需要 page.waitForEvent('popup')。`, todo: true, seqs: [], at });
        return;
      case "page.navigation":
        this.navigation(payload, seq, at);
        return;
      case "action.focus":
        this.omit("focus");
        return;
      case "action.scroll":
        this.scroll(event, payload, seq, at);
        return;
    }
    if (!type.startsWith("action.")) {
      this.omit(type || "unknown");
      return;
    }
    const documentId = str(event.documentId);
    const target = describeTarget(payload.target, documentId);
    switch (type) {
      case "action.click":
      case "action.dblclick":
        this.click(type, target, payload, seq, at, time);
        return;
      case "action.input":
      case "action.change":
        this.input(target, payload, seq, at, time, type === "action.change");
        return;
      case "action.keydown":
        this.key(target, payload, seq, time);
        return;
      case "action.submit":
        this.submit(target, payload, seq, at, time);
        return;
      default:
        this.push({ op: "comment", text: `seq ${seq} 暂不支持的操作类型 ${commentText(type, 60)}`, todo: true, seqs: [], at });
    }
  }
  private navigation(payload: Rec, seq: number, at: number) {
    const url = str(payload.url);
    if (!url || url === "about:blank") return;
    const sameDocument = payload.sameDocument === true;
    if (url === this.currentUrl && sameDocument) return;
    const redirect =
      !this.actionSinceNavigation &&
      !!this.lastNavigation?.asserted &&
      at - this.lastNavigation.at <= REDIRECT_WINDOW_MS;
    const caused = this.actionSinceNavigation || redirect;
    this.navigations++;
    if (caused) {
      const last = this.last();
      if (last?.op === "expectUrl" && redirect) {
        last.url = url;
        last.seqs.push(seq);
      } else this.push({ op: "expectUrl", url, seqs: [seq], at });
    } else if (sameDocument) {
      this.push({ op: "comment", text: `seq ${seq} 页面脚本将地址改为 ${commentText(url, 160)}`, todo: false, seqs: [], at });
    } else if (url === this.currentUrl) {
      const first = this.steps[0];
      if (this.steps.length === 1 && first?.op === "goto") first.seqs.push(seq);
      else this.push({ op: "reload", seqs: [seq], at });
    } else this.push({ op: "goto", url, seqs: [seq], at });
    this.currentUrl = url;
    this.actionSinceNavigation = false;
    this.lastNavigation = { at, asserted: caused };
  }
  private scroll(event: CodegenEvent, payload: Rec, seq: number, at: number) {
    if (!this.options.includeScroll) {
      this.omit("scroll");
      return;
    }
    const target = describeTarget(payload.target, str(event.documentId));
    const x = Math.round(num(payload.x) ?? 0),
      y = Math.round(num(payload.y) ?? 0);
    const main = !target || target.documentTarget || target.tag === "html" || target.tag === "body";
    const scrollTarget = main && (!target || !target.frames?.length) ? null : target;
    const last = this.last();
    if (last?.op === "scroll" && (last.target?.key ?? null) === (scrollTarget?.key ?? null)) {
      last.x = x;
      last.y = y;
      last.seqs.push(seq);
      return;
    }
    this.push({ op: "scroll", target: scrollTarget, x, y, seqs: [seq], at });
  }
  private click(type: string, target: CodegenTarget | null, payload: Rec, seq: number, at: number, time: number) {
    if (!target) {
      this.push({ op: "comment", text: `seq ${seq} ${type} 没有目标节点，无法生成定位器`, todo: true, seqs: [], at });
      return;
    }
    if (target.tag === "select" || target.tag === "option" || target.tag === "optgroup") {
      this.omit("select-click");
      return;
    }
    const modifiers = modifierList(payload);
    if (type === "action.dblclick") {
      const seqs: number[] = [];
      for (let n = 0; n < 2; n++) {
        const last = this.last();
        if (last?.op === "click" && sameTarget(last, target)) {
          seqs.unshift(...last.seqs);
          this.steps.pop();
        } else break;
      }
      this.push({ op: "dblclick", target, modifiers, seqs: [...seqs, seq], at: time });
      return;
    }
    const detail = num(payload.detail) ?? 1;
    const last = this.last();
    // Keyboard activation (Enter/Space on a button) and implicit form submission (Enter in a
    // field clicks the default button) dispatch a click with detail 0 that the press already causes.
    if (detail === 0 && last?.op === "press" && ((last.target && last.target.key === target.key) || /(^|\+)Enter$/.test(last.key))) {
      last.seqs.push(seq);
      return;
    }
    const position = obj(payload.position);
    const buttonValue = num(payload.button) ?? 0;
    this.push({
      op: "click",
      target,
      button: buttonValue === 2 ? "right" : buttonValue === 1 ? "middle" : null,
      modifiers,
      detail,
      x: num(position.clientX),
      y: num(position.clientY),
      seqs: [seq],
      at: time,
    });
  }
  /** Merge a preceding label click that merely forwarded activation to a checkbox. */
  private absorbLabelClick(step: TargetStep, time: number) {
    const index = this.steps.indexOf(step) - 1;
    const previous = this.steps[index];
    if (previous?.op === "click" && previous.target.key !== step.target.key && Math.abs(time - previous.at) <= LABEL_CLICK_WINDOW_MS && !previous.modifiers.length && !previous.button) {
      this.steps.splice(index, 1);
      step.seqs.unshift(...previous.seqs);
    }
  }
  private input(target: CodegenTarget | null, payload: Rec, seq: number, at: number, time: number, commit = false) {
    const form = obj(payload.form);
    if (!target) {
      this.push({ op: "comment", text: `seq ${seq} 输入事件没有目标节点`, todo: true, seqs: [], at });
      return;
    }
    const last = this.last();
    const formType = str(form.type).toLowerCase() || target.type;
    if (target.tag === "input" && (formType === "checkbox" || formType === "radio")) {
      const checked = form.checked === true;
      const op = checked ? "check" : "uncheck";
      if ((last?.op === "check" || last?.op === "uncheck") && sameTarget(last, target)) {
        last.op = op;
        last.seqs.push(seq);
        return;
      }
      let step: TargetStep;
      if (last?.op === "click" && sameTarget(last, target) && !last.modifiers.length && !last.button) {
        step = { op, target, seqs: [...last.seqs, seq], at: last.at };
        this.steps[this.steps.length - 1] = step;
      } else {
        step = { op, target, seqs: [seq], at: time };
        this.push(step);
      }
      this.absorbLabelClick(step, step.at);
      return;
    }
    if (target.tag === "select") {
      const values = Array.isArray(form.selectedValues)
        ? form.selectedValues.filter((v): v is string => typeof v === "string")
        : typeof form.value === "string"
          ? [form.value]
          : [];
      if (last?.op === "select" && sameTarget(last, target)) {
        last.values = values;
        last.seqs.push(seq);
        return;
      }
      this.push({ op: "select", target, values, seqs: [seq], at: time });
      return;
    }
    if (formType === "file") {
      const names = Array.isArray(form.files) ? form.files.map((f) => str(obj(f).name)).filter(Boolean) : [];
      if (last?.op === "files" && sameTarget(last, target)) {
        last.names = names;
        last.seqs.push(seq);
        return;
      }
      this.push({ op: "files", target, names, seqs: [seq], at: time });
      return;
    }
    const value =
      typeof form.text === "string" && target.tag !== "input" && target.tag !== "textarea"
        ? form.text
        : typeof form.value === "string"
          ? form.value
          : typeof form.value === "number"
            ? String(form.value)
            : typeof form.text === "string"
              ? form.text
              : "";
    if (formType === "password") this.passwords = true;
    if (last?.op === "fill" && sameTarget(last, target)) {
      last.value = value;
      last.seqs.push(seq);
      return;
    }
    // A blur-time change that only commits an already filled value is not a new step.
    const previous = this.fills.get(target.key);
    if (commit && previous && previous.value === value) {
      previous.seqs.push(seq);
      return;
    }
    let step: Extract<Step, { op: "fill" }>;
    // Playwright's fill focuses the field itself; a plain click into it is redundant.
    if (last?.op === "click" && sameTarget(last, target) && !last.modifiers.length && !last.button && last.detail <= 1) {
      step = { op: "fill", target, value, seqs: [...last.seqs, seq], at: last.at };
      this.steps[this.steps.length - 1] = step;
    } else {
      step = { op: "fill", target, value, seqs: [seq], at: time };
      this.push(step);
    }
    this.fills.set(target.key, step);
  }
  private key(target: CodegenTarget | null, payload: Rec, seq: number, time: number) {
    const key = str(payload.key);
    if (payload.isComposing === true || IGNORED_KEYS.has(key) || MODIFIER_KEYS.has(key)) {
      this.omit("key");
      return;
    }
    if (payload.repeat === true) {
      this.omit("key-repeat");
      return;
    }
    const modifiers = modifierList(payload);
    const command = modifiers.includes("Control") || modifiers.includes("Meta") || modifiers.includes("Alt");
    const printable = [...key].length === 1;
    // Keys already reflected in a fill/select on the same element keep their seq on that step.
    const absorb = (kind: string) => {
      this.omit(kind);
      const last = this.last();
      if (target && last && sameTarget(last, target) && (last.op === "fill" || last.op === "select" || (last.op === "click" && target.editable))) last.seqs.push(seq);
    };
    if (printable && !command) {
      absorb("typing");
      return;
    }
    const editable = !!target?.editable;
    if (editable && (CARET_KEYS.has(key) || (command && printable && EDIT_SHORTCUT_LETTERS.has(key.toLowerCase())))) {
      absorb("editing-key");
      return;
    }
    if (editable && key === "Enter" && !command && target && target.tag !== "input") {
      absorb("typing");
      return;
    }
    if (target?.tag === "select" && (CARET_KEYS.has(key) || printable)) {
      absorb("editing-key");
      return;
    }
    const combo = [...modifiers, key === " " ? "Space" : key].join("+");
    const pageLevel = !target || target.documentTarget || target.tag === "body" || target.tag === "html";
    this.push({ op: "press", target: pageLevel ? null : target, key: combo, seqs: [seq], at: time });
  }
  private submit(target: CodegenTarget | null, payload: Rec, seq: number, at: number, time: number) {
    const last = this.last();
    const submitter = describeTarget(payload.submitter, target?.key.split("|")[0] ?? "");
    if (
      last &&
      ((last.op === "click" && (!submitter || last.target.key === submitter.key || time - last.at <= SUBMIT_WINDOW_MS)) ||
        (last.op === "press" && /(^|\+)Enter$/.test(last.key)))
    ) {
      last.seqs.push(seq);
      return;
    }
    if (!target) {
      this.push({ op: "comment", text: `seq ${seq} 表单提交没有目标节点`, todo: true, seqs: [], at });
      return;
    }
    this.push({ op: "submit", target, seqs: [seq], at: time });
  }
  finish(): Omit<CodegenStats, "steps" | "todos"> & { steps: Step[]; warnings: string[]; startUrl: string; truncated: number; passwords: boolean } {
    if (!this.started) this.ensureStart(this.recording.url || "", 0, 0);
    if (this.paused) this.warnings.add("记录在暂停状态结束，暂停之后的操作没有采集。");
    if (this.truncated) this.warnings.add(`步骤超过 ${this.options.maxSteps} 条，其后的 ${this.truncated} 条已省略。`);
    return {
      steps: this.steps,
      warnings: [...this.warnings],
      startUrl: this.startUrl,
      truncated: this.truncated,
      passwords: this.passwords,
      events: this.events,
      actions: this.actions,
      navigations: this.navigations,
      omitted: { ...this.omitted },
      firstSeq: this.firstSeq,
      lastSeq: this.lastSeq,
    };
  }
}

/** Render "3-5, 9" from merged step sequence numbers. */
export function seqLabel(seqs: number[]): string {
  const sorted = [...new Set(seqs)].filter((n) => n > 0).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length; ) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end++;
    parts.push(end > index ? `${sorted[index]}-${sorted[end]}` : String(sorted[index]));
    index = end + 1;
  }
  return parts.join(", ");
}

interface Dialect {
  python: boolean;
  quote(value: string): string;
  comment: string;
  await: string;
  end: string;
  method(name: string): string;
}
const PY_METHODS: Record<string, string> = {
  frameLocator: "frame_locator",
  getByTestId: "get_by_test_id",
  getByRole: "get_by_role",
  getByLabel: "get_by_label",
  getByPlaceholder: "get_by_placeholder",
  getByText: "get_by_text",
  selectOption: "select_option",
  setInputFiles: "set_input_files",
  toHaveURL: "to_have_url",
};
const TS: Dialect = { python: false, quote: tsString, comment: "//", await: "await ", end: ";", method: (n) => n };
const PY: Dialect = {
  python: true,
  quote: pyString,
  comment: "#",
  await: "",
  end: "",
  method: (n) => PY_METHODS[n] ?? n,
};

function renderLocator(d: Dialect, target: CodegenTarget): string | null {
  if (!target.frames || !target.locator) return null;
  let expr = "page";
  for (const hop of target.frames) {
    for (const host of hop.shadowHosts) expr += `.locator(${d.quote(host)})`;
    expr += `.${d.method("frameLocator")}(${d.quote(hop.selector)})`;
  }
  for (const host of target.shadowHosts) expr += `.locator(${d.quote(host)})`;
  const l = target.locator;
  switch (l.kind) {
    case "testId":
      return `${expr}.${d.method("getByTestId")}(${d.quote(l.value)})`;
    case "role": {
      const options = d.python
        ? `, name=${d.quote(l.name)}${l.exact ? ", exact=True" : ""}`
        : `, { name: ${d.quote(l.name)}${l.exact ? ", exact: true" : ""} }`;
      return `${expr}.${d.method("getByRole")}(${d.quote(l.role)}${options})`;
    }
    case "label":
      return `${expr}.${d.method("getByLabel")}(${d.quote(l.value)})`;
    case "placeholder":
      return `${expr}.${d.method("getByPlaceholder")}(${d.quote(l.value)})`;
    case "text":
      return `${expr}.${d.method("getByText")}(${d.quote(l.value)})`;
    case "css":
      return `${expr}.locator(${d.quote(l.value)})`;
  }
}
function list(d: Dialect, values: string[]): string {
  return `[${values.map((v) => d.quote(v)).join(", ")}]`;
}
function options(d: Dialect, entries: [string, string][]): string {
  if (!entries.length) return "";
  return d.python
    ? entries.map(([k, v]) => `${k}=${v}`).join(", ")
    : `{ ${entries.map(([k, v]) => `${k}: ${v}`).join(", ")} }`;
}
function why(target: CodegenTarget): string {
  if (!target.frames) return "目标位于无法用选择器定位的 iframe 中";
  return "录制时没有可用的定位器";
}

/** Render steps into statement lines (without indentation) and count TODOs. */
function renderSteps(d: Dialect, steps: Step[]): { lines: string[]; todos: number } {
  const lines: string[] = [];
  let todos = 0;
  const c = d.comment;
  const todo = (text: string) => {
    todos++;
    lines.push(`${c} TODO: ${commentText(text, 240)}`);
  };
  for (const step of steps) {
    if (step.op === "comment") {
      if (step.todo) todo(step.text);
      else lines.push(`${c} ${commentText(step.text, 240)}`);
      continue;
    }
    const label = seqLabel(step.seqs);
    if (label) lines.push(`${c} seq ${label}${step.op === "goto" && step.note ? ` · ${step.note}` : ""}`);
    if (hasTarget(step)) {
      const locator = renderLocator(d, step.target);
      if (!locator) {
        if (step.op === "click" && step.target.frames?.length === 0 && step.x !== null && step.y !== null) {
          todo(`${why(step.target)}，按录制时的视口坐标点击；请改为稳定的定位器。`);
          lines.push(`${d.await}page.mouse.click(${Math.round(step.x)}, ${Math.round(step.y)})${d.end}`);
        } else todo(`${why(step.target)}，已跳过 ${step.op} 步骤。`);
        continue;
      }
      switch (step.op) {
        case "click": {
          const entries: [string, string][] = [];
          if (step.button) entries.push(["button", d.quote(step.button)]);
          if (step.modifiers.length) entries.push(["modifiers", list(d, step.modifiers)]);
          lines.push(`${d.await}${locator}.click(${options(d, entries)})${d.end}`);
          break;
        }
        case "dblclick": {
          const entries: [string, string][] = step.modifiers.length ? [["modifiers", list(d, step.modifiers)]] : [];
          lines.push(`${d.await}${locator}.dblclick(${options(d, entries)})${d.end}`);
          break;
        }
        case "fill":
          lines.push(`${d.await}${locator}.fill(${d.quote(step.value)})${d.end}`);
          break;
        case "check":
        case "uncheck":
          lines.push(`${d.await}${locator}.${step.op}()${d.end}`);
          break;
        case "select":
          lines.push(`${d.await}${locator}.${d.method("selectOption")}(${step.values.length === 1 ? d.quote(step.values[0]!) : list(d, step.values)})${d.end}`);
          break;
        case "press":
          lines.push(`${d.await}${locator}.press(${d.quote(step.key)})${d.end}`);
          break;
        case "submit":
          todo("表单提交不是由已记录的点击或回车触发，以下直接调用 requestSubmit()。");
          lines.push(
            d.python
              ? `${locator}.evaluate("form => form.requestSubmit()")`
              : `await ${locator}.evaluate((form) => (form as HTMLFormElement).requestSubmit());`,
          );
          break;
        case "files":
          todo(`文件上传需要本地文件：${commentText(step.names.join(", ") || "（未记录文件名）", 160)}`);
          lines.push(`${c} ${d.await}${locator}.${d.method("setInputFiles")}(${list(d, step.names)})${d.end}`);
          break;
        case "scroll":
          lines.push(
            d.python
              ? `${locator}.evaluate("el => el.scrollTo(${step.x}, ${step.y})")`
              : `await ${locator}.evaluate((el) => el.scrollTo(${step.x}, ${step.y}));`,
          );
          break;
      }
      continue;
    }
    switch (step.op) {
      case "goto":
        lines.push(`${d.await}page.goto(${d.quote(step.url)})${d.end}`);
        break;
      case "reload":
        lines.push(`${d.await}page.reload()${d.end}`);
        break;
      case "expectUrl":
        lines.push(`${d.await}expect(page).${d.method("toHaveURL")}(${d.quote(step.url)})${d.end}`);
        break;
      case "press":
        lines.push(`${d.await}page.keyboard.press(${d.quote(step.key)})${d.end}`);
        break;
      case "scroll":
        lines.push(
          d.python
            ? `page.evaluate("() => window.scrollTo(${step.x}, ${step.y})")`
            : `await page.evaluate(() => window.scrollTo(${step.x}, ${step.y}));`,
        );
        break;
    }
  }
  return { lines, todos };
}

export function scriptFilename(language: CodegenLanguage): string {
  return language === "python" ? "test_script.py" : "script.spec.ts";
}

/** Render a finished builder into a complete Playwright Test / pytest file. */
export function renderScript(
  recording: CodegenRecording,
  builder: ScriptBuilder,
  options: CodegenOptions = {},
): CodegenResult {
  const language: CodegenLanguage = options.language === "python" ? "python" : "typescript";
  const d = language === "python" ? PY : TS;
  const result = builder.finish();
  const generatedAt = options.generatedAt || new Date().toISOString();
  const { lines, todos } = renderSteps(d, result.steps);
  const c = d.comment;
  const filename = scriptFilename(language);
  const header = [
    `${c} TraceDock · Playwright 自动化脚本（由采集记录生成）`,
    `${c} 采集记录：${commentText(recording.name, 200)}`,
    `${c} 记录 ID：${commentText(recording.id, 120)}`,
    `${c} 起始地址：${commentText(result.startUrl, 400)}`,
    ...(recording.startedAt ? [`${c} 录制开始：${commentText(recording.startedAt, 60)}`] : []),
    `${c} 生成时间：${commentText(generatedAt, 60)}`,
    `${c} 运行：${language === "python" ? `pytest ${filename}（需要 pytest-playwright）` : `npx playwright test ${filename}`}`,
    `${c} 每个步骤上方的 seq 对应 timeline.jsonl 中的事件序号；定位器取自录制时的候选项，运行前请复核断言和等待条件。`,
    ...(result.passwords ? [`${c} 注意：脚本保留录制时的原始输入值（包括密码字段），分享前请自行处理。`] : []),
    ...result.warnings.map((w) => `${c} 注意：${commentText(w, 200)}`),
  ];
  if (!result.steps.some((s) => s.op !== "goto" && s.op !== "comment"))
    lines.push(`${c} 记录中没有可转换的操作。`);
  if (result.truncated) {
    lines.push(`${c} TODO: 其余 ${result.truncated} 个步骤因数量上限被省略。`);
  }
  const todoCount = todos + (result.truncated ? 1 : 0);
  let code: string;
  if (language === "python") {
    code = [
      ...header,
      "from playwright.sync_api import Page, expect",
      "",
      "",
      `def test_tracedock_recording(page: Page) -> None:`,
      `    ${pyString(`TraceDock: ${recording.name}`)}`,
      ...lines.map((line) => `    ${line}`),
      "",
    ].join("\n");
  } else {
    code = [
      ...header,
      "import { test, expect } from '@playwright/test';",
      "",
      `test(${tsString(recording.name || recording.id)}, async ({ page }) => {`,
      ...lines.map((line) => `  ${line}`),
      "});",
      "",
    ].join("\n");
  }
  const stats: CodegenStats = {
    events: result.events,
    actions: result.actions,
    steps: result.steps.filter((s) => s.op !== "comment").length,
    navigations: result.navigations,
    todos: todoCount,
    omitted: result.omitted,
    firstSeq: result.firstSeq,
    lastSeq: result.lastSeq,
  };
  return { language, filename, code, stats, warnings: result.warnings };
}

/** Convenience for in-memory event lists (tests, small recordings). */
export function generateScript(
  recording: CodegenRecording,
  events: Iterable<CodegenEvent>,
  options: CodegenOptions = {},
): CodegenResult {
  const builder = new ScriptBuilder(recording, options);
  for (const event of events) builder.add(event);
  return renderScript(recording, builder, options);
}
