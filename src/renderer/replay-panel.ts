import { ReplayController, type ReplaySource } from "../replay/controller";
import { ReplayDOM } from "../replay/dom";
import type { ReplayView, ReplayPointer } from "../replay/model";
import type { ResourceSummary } from "../shared/contracts/resources";
import { element as el } from "./shell/dom";
const time = (value: number): string => {
  const tenths = Math.floor(Math.max(0, value) / 100);
  return `${String(Math.floor(tenths / 600)).padStart(2, "0")}:${String(Math.floor(tenths / 10) % 60).padStart(2, "0")}.${tenths % 10}`;
};
export class ReplayPanel {
  private controller: ReplayController;
  private viewport = { width: 1000, height: 760 };
  private seekTimer: ReturnType<typeof setTimeout> | undefined;
  get active(): boolean {
    return this.controller.active;
  }
  constructor(
    source: ReplaySource,
    private onMode: (active: boolean) => void,
    onError: (error: Error) => void,
  ) {
    const dom = new ReplayDOM(
      el("replay-frame", "iframe"),
      (view) => this.view(view),
      (point) => this.pointer(point),
    );
    this.controller = new ReplayController(source, dom, {
      render: () => this.render(),
      view: (view) => this.view(view),
      event: (seq, type) => {
        el("replay-event-label", "span").textContent = type
          ? `#${seq} · ${type}`
          : `#${seq} · 点击时间线可定位画面`;
      },
      resources: (status) => this.resources(status),
      error: onError,
    });
    el("replay-close", "button").addEventListener("click", () => this.close());
    el("replay-play", "button").addEventListener("click", () =>
      this.controller.playing
        ? this.controller.pause()
        : void this.controller.play(),
    );
    el("replay-restart", "button").addEventListener("click", () => {
      void this.seek();
    });
    el("replay-back", "button").addEventListener("click", () => {
      void this.seek(Math.max(0, this.controller.position - 5000));
    });
    el("replay-forward", "button").addEventListener("click", () => {
      void this.seek(
        Math.min(this.controller.duration, this.controller.position + 5000),
      );
    });
    el("replay-speed", "select").addEventListener("change", () => {
      this.controller.speed = Number(el("replay-speed", "select").value);
    });
    const progress = el("replay-progress", "input");
    progress.addEventListener("input", () => {
      const position = Number(progress.value);
      this.controller.pause();
      clearTimeout(this.seekTimer);
      progress.value = String(position);
      el("replay-time", "span").textContent =
        `${time(position)} / ${time(this.controller.duration)}`;
      this.seekTimer = setTimeout(() => {
        void this.seek(position);
      }, 100);
    });
    progress.addEventListener("change", () => {
      void this.seek(Number(progress.value));
    });
    new ResizeObserver(() => this.fit()).observe(el("replay-stage", "div"));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.controller.pause();
    });
  }
  open(sessionId: string, name: string): Promise<void> {
    el("replay-title", "span").textContent = name || "会话回放";
    el("replay-resource-status", "span").textContent = "读取资源…";
    el("replay-panel", "section").hidden = false;
    el("replay-toolbar", "div").hidden = false;
    el("address-form", "form").hidden = true;
    const opening = this.controller.open(sessionId);
    this.onMode(true);
    return opening;
  }
  close(): void {
    clearTimeout(this.seekTimer);
    this.controller.close();
    el("replay-panel", "section").hidden = true;
    el("replay-toolbar", "div").hidden = true;
    el("address-form", "form").hidden = false;
    this.onMode(false);
  }
  seek(timeMs?: number, targetSeq?: number): Promise<void> {
    clearTimeout(this.seekTimer);
    return this.controller.seek(timeMs, targetSeq);
  }
  private view(view: ReplayView): void {
    if (view.viewport) {
      this.viewport = {
        width: Math.max(1, Math.min(12000, view.viewport.width || 1000)),
        height: Math.max(1, Math.min(12000, view.viewport.height || 760)),
      };
      this.fit();
    }
    if (view.url !== undefined) el("replay-title", "span").title = view.url;
    if (view.message !== undefined) {
      el("replay-message", "div").textContent = view.message;
      el("replay-message", "div").hidden = !view.message;
    }
    if (view.gaps !== undefined)
      el("replay-note", "span").textContent = view.gaps
        ? `${view.gaps} 处记录缺口`
        : "按录制视口显示";
  }
  private fit(): void {
    if (!this.active) return;
    const stage = el("replay-stage", "div"),
      viewport = el("replay-viewport", "div"),
      scale = Math.min(
        (stage.clientWidth - 24) / this.viewport.width,
        (stage.clientHeight - 24) / this.viewport.height,
        1,
      );
    viewport.style.width = `${this.viewport.width}px`;
    viewport.style.height = `${this.viewport.height}px`;
    viewport.style.transform = `translate(-50%, -50%) scale(${Math.max(0.05, scale)})`;
  }
  private pointer(point: ReplayPointer | null): void {
    const cursor = el("replay-cursor", "span");
    cursor.hidden = !point;
    if (!point) return;
    cursor.style.left = `${point.x}px`;
    cursor.style.top = `${point.y}px`;
    cursor.classList.remove("clicked");
    void cursor.offsetWidth;
    cursor.classList.add("clicked");
  }
  private render(): void {
    const c = this.controller,
      progress = el("replay-progress", "input");
    el("replay-time", "span").textContent =
      `${time(c.position)} / ${time(c.duration)}`;
    progress.max = String(Math.max(1, c.duration));
    progress.value = String(c.position);
    progress.setAttribute(
      "aria-valuetext",
      `${time(c.position)}，共 ${time(c.duration)}`,
    );
    el("replay-play", "button").textContent = c.playing
      ? "暂停"
      : c.position >= c.duration
        ? "重新播放"
        : "播放";
    el("replay-play", "button").disabled = c.loading || !c.loaded;
    progress.disabled = !c.loaded;
    for (const id of ["replay-restart", "replay-back", "replay-forward"])
      el(id, "button").disabled = !c.loaded;
  }
  private resources(status: ResourceSummary | null): void {
    const label = el("replay-resource-status", "span");
    if (!status) {
      label.textContent = "资源索引读取失败";
      return;
    }
    label.textContent = status.available
      ? `本地资源 ${status.saved}${status.missing ? ` · 缺失 ${status.missing}` : ""}`
      : `资源未归档${status.missing ? ` · 缺失 ${status.missing}` : ""}`;
    label.title =
      [status.captureError, ...status.missingURLs].filter(Boolean).join("\n") ||
      "样式、图片与字体从本地副本加载";
    label.classList.toggle(
      "incomplete",
      status.missing > 0 || !status.available,
    );
  }
}
