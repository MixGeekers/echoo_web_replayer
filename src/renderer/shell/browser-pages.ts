import { pageLabel, type AppState, type CollectorAPI } from "../../shared/contracts/ui";
import { element as el } from "./dom";
import { svg } from "./icons";

export function createBrowserPages(api: CollectorAPI, act: (task: () => Promise<AppState>) => void) {
  const list = el("browser-tab-list", "div");
  el("new-tab-button", "button").onclick = () => act(() => api.newPage("tab"));
  el("new-window-button", "button").onclick = () => act(() => api.newPage("window"));
  let signature = "";
  return (state: AppState, replay: boolean, disabled: boolean) => {
    el("browser-pages", "div").hidden = replay || !state.activeProfileId;
    el("new-tab-button", "button").disabled = el("new-window-button", "button").disabled = disabled;
    const next = JSON.stringify([state.pages, state.activePageId, disabled]);
    if (next === signature) return;
    signature = next;
    const focused = document.activeElement instanceof HTMLButtonElement && list.contains(document.activeElement)
      ? document.activeElement.dataset.action : undefined;
    const items = state.pages.map(page => {
      const active = page.id === state.activePageId;
      const row = document.createElement("div");
      row.className = "browser-tab" + (active ? " active" : "");
      const tab = document.createElement("button"), close = document.createElement("button");
      const label = pageLabel(page.id);
      const name = page.title || page.url || label;
      tab.type = close.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(active));
      tab.dataset.action = page.id;
      tab.textContent = page.kind === "window" ? `窗口 · ${name}` : name;
      tab.title = [label, page.title, page.url].filter(Boolean).join("\n");
      tab.onclick = () => act(() => api.selectPage(page.id));
      close.className = "icon-button";
      close.innerHTML = svg("close");
      close.dataset.action = "close-" + page.id;
      close.title = `关闭${label}`;
      close.setAttribute("aria-label", close.title);
      close.onclick = () => act(() => api.closePage(page.id));
      tab.disabled = close.disabled = disabled;
      row.append(tab, close);
      return row;
    });
    list.replaceChildren(...items);
    if (focused) [...list.querySelectorAll("button")].find(b => b.dataset.action === focused)?.focus({ preventScroll: true });
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
}
