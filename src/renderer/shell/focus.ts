import { element as el } from "./dom";

const STORAGE_KEY = "tracedock.focusMode";

/**
 * 专注模式：收起左侧 Session 栏和右侧时间线，只保留中央浏览器/回放区域。
 * 状态只影响布局（body.focus-mode），并记在本机，下次启动保持。
 */
export function createFocusMode(options: {
  boundsChanged: () => void;
  onToggleRequest?: (callback: () => void) => unknown;
}) {
  const button = el("focus-mode-button", "button");
  let enabled = false;

  function set(next: boolean, persist = true) {
    enabled = next;
    document.body.classList.toggle("focus-mode", next);
    button.setAttribute("aria-pressed", String(next));
    const label = next ? "退出专注模式 (Ctrl+Shift+F)" : "专注模式 (Ctrl+Shift+F)";
    button.title = label;
    button.setAttribute("aria-label", label);
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* 存储不可用时只在本次运行生效 */
      }
    }
    options.boundsChanged();
  }
  const toggle = () => set(!enabled);

  let saved = false;
  try {
    saved = localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    saved = false;
  }
  set(saved, false);

  button.addEventListener("click", toggle);
  document.addEventListener("keydown", (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      !event.altKey &&
      event.code === "KeyF" &&
      !document.querySelector("dialog[open]")
    ) {
      event.preventDefault();
      toggle();
    }
  });
  // 焦点在内嵌网页里时，快捷键由主进程拦截后转发过来。
  options.onToggleRequest?.(() => {
    if (!document.querySelector("dialog[open]")) toggle();
  });

  return {
    get enabled() {
      return enabled;
    },
    set,
    toggle,
  };
}
