import { element as el, message } from "./dom";
import type { CollectorAPI, SessionMetadata } from "../../shared/contracts/ui";
import type { CodegenLanguage, CodegenResult } from "../../shared/contracts/codegen";

interface Options {
  /** The selected recording, or null when it cannot be read (none selected / in trash). */
  sessionId(): string | null;
  selectedSession(): SessionMetadata | null | undefined;
  showDialog(dialog: HTMLDialogElement): void;
  closeDialog(dialog: HTMLDialogElement): void;
  notify(title: string, message?: string, error?: boolean): void;
}
const LANGUAGE_KEY = "tracedock.codegenLanguage";
const omittedLabels: Record<string, string> = {
  scroll: "滚动",
  focus: "焦点",
  typing: "字符按键",
  "editing-key": "编辑按键",
  "select-click": "下拉框点击",
};
const clean = (text: string) => text.replace(/^Error invoking remote method '[^']+': Error: /, "");

/** 「生成脚本」: shows the Playwright script for the selected recording with copy/save actions. */
export function createCodegenUI(api: CollectorAPI, options: Options) {
  const dialog = el("codegen-dialog", "dialog");
  const code = el("codegen-code", "pre");
  let language: CodegenLanguage = "typescript";
  try {
    if (localStorage.getItem(LANGUAGE_KEY) === "python") language = "python";
  } catch {}
  let sessionId: string | null = null;
  let current: CodegenResult | null = null;
  let request = 0;

  function paint(result: CodegenResult) {
    const comment = result.language === "python" ? "#" : "//";
    const fragment = document.createDocumentFragment();
    const lines = result.code.split("\n");
    lines.forEach((line, index) => {
      const row = document.createElement("span");
      const trimmed = line.trimStart();
      row.className = trimmed.startsWith(`${comment} TODO`)
        ? "codegen-line todo"
        : trimmed.startsWith(`${comment} seq `)
          ? "codegen-line seq"
          : trimmed.startsWith(comment)
            ? "codegen-line comment"
            : "codegen-line";
      row.textContent = index < lines.length - 1 ? `${line}\n` : line;
      fragment.append(row);
    });
    code.replaceChildren(fragment);
    const { stats } = result;
    const omitted = Object.entries(stats.omitted)
      .filter(([kind]) => kind in omittedLabels)
      .map(([kind, n]) => `${omittedLabels[kind]} ${n}`)
      .join("、");
    el("codegen-stats", "span").textContent =
      `${stats.steps} 个步骤 · ${stats.todos} 个 TODO${omitted ? ` · 已省略 ${omitted}` : ""}`;
    el("codegen-note", "p").textContent = result.warnings.length
      ? result.warnings.join(" ")
      : `由 ${stats.actions} 个操作事件推断，未执行验证。每步的 seq 对应时间线序号；定位器取自录制时的候选项，运行前请复核。`;
  }
  function setBusy(busy: boolean, text = "正在生成脚本…") {
    el("codegen-copy", "button").disabled = busy || !current;
    el("codegen-save", "button").disabled = busy || !current;
    if (busy) {
      code.replaceChildren(text);
      el("codegen-stats", "span").textContent = "";
    }
  }
  function syncLanguage() {
    dialog.querySelectorAll<HTMLButtonElement>("[data-language]").forEach((button) => {
      const selected = button.dataset.language === language;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }
  async function load() {
    if (!sessionId) return;
    const id = sessionId,
      ticket = ++request;
    current = null;
    setBusy(true);
    syncLanguage();
    try {
      const result = await api.generateScript({
        sessionId: id,
        language,
        includeScroll: el("codegen-scroll", "input").checked,
      });
      if (ticket !== request) return;
      current = result;
      paint(result);
    } catch (error) {
      if (ticket !== request) return;
      code.replaceChildren(`脚本生成失败：${clean(message(error))}`);
    } finally {
      if (ticket === request) setBusy(false);
    }
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {}
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    dialog.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("剪贴板不可用");
  }

  el("codegen-button", "button").addEventListener("click", () => {
    const id = options.sessionId();
    if (!id) return;
    sessionId = id;
    el("codegen-session-name", "p").textContent = options.selectedSession()?.name || "";
    options.showDialog(dialog);
    void load();
  });
  dialog.querySelectorAll<HTMLButtonElement>("[data-language]").forEach((button) =>
    button.addEventListener("click", () => {
      const next: CodegenLanguage = button.dataset.language === "python" ? "python" : "typescript";
      if (next === language && current) return;
      language = next;
      try {
        localStorage.setItem(LANGUAGE_KEY, language);
      } catch {}
      void load();
    }),
  );
  el("codegen-scroll", "input").addEventListener("change", () => void load());
  el("codegen-copy", "button").addEventListener("click", async () => {
    if (!current) return;
    try {
      await copy(current.code);
      options.notify("脚本已复制", `${current.filename} · ${current.stats.steps} 个步骤`);
    } catch (error) {
      options.notify("复制失败", message(error), true);
    }
  });
  el("codegen-save", "button").addEventListener("click", async () => {
    if (!current || !sessionId) return;
    const result = current;
    try {
      const saved = await api.saveScript({ sessionId, language: result.language, code: result.code });
      if (!saved.canceled) options.notify("脚本已保存", saved.path);
    } catch (error) {
      options.notify("保存失败", clean(message(error)), true);
    }
  });
  const close = () => {
    request++;
    options.closeDialog(dialog);
  };
  el("close-codegen-dialog", "button").addEventListener("click", close);
  el("codegen-done", "button").addEventListener("click", close);
  dialog.addEventListener("close", () => {
    request++;
  });
  return {
    /** Keep the entry point in step with the selected recording. */
    render(disabled: boolean) {
      const button = el("codegen-button", "button");
      button.disabled = disabled || !options.sessionId();
      button.title = options.selectedSession()
        ? `从「${options.selectedSession()?.name}」生成 Playwright 脚本`
        : "先选择一条采集记录";
    },
  };
}
