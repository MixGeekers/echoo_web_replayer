import type { CollectorAPI } from "../shared/contracts/ui";
import type { StoredEvent } from "../shared/contracts/storage";
import type { ResourceSummary } from "../shared/contracts/resources";
import { decodeReplayEvent, type ReplayEvent, type ReplayView } from "./model";
/** Narrow source boundary: replay has no dependency on Electron or workbench controls. */
export type ReplaySource = Pick<
  CollectorAPI,
  "replaySeek" | "replayChunk" | "replayResources"
>;
export interface ReplayTarget {
  reset(sessionId: string, at: number, endSeq: number): Promise<void>;
  snapshot(
    event: Extract<ReplayEvent, { type: "dom.snapshot" }>,
    at: number,
  ): void;
  apply(event: ReplayEvent, seeking: boolean): void;
  restoreScroll(): void;
}
export interface ReplayObserver {
  render(): void;
  view(view: ReplayView): void;
  event(seq: number, type?: string): void;
  resources(status: ResourceSummary | null): void;
  error(error: Error): void;
}
export class ReplayController {
  active = false;
  playing = false;
  position = 0;
  duration = 0;
  speed = 1;
  loading = false;
  loaded = false;
  private version = 0;
  private playVersion = 0;
  private sessionId = "";
  private endSeq: number | undefined;
  private cursor = 0;
  private buffer: StoredEvent[] = [];
  private hasMore = false;
  private lastTick = 0;
  private animation = 0;
  private resourceTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private source: ReplaySource,
    private target: ReplayTarget,
    private observer: ReplayObserver,
  ) {}
  open(sessionId: string): Promise<void> {
    this.sessionId = sessionId;
    this.endSeq = undefined;
    this.active = true;
    this.loaded = false;
    return this.seek();
  }
  close(): void {
    this.pause();
    this.version++;
    this.active = false;
    clearTimeout(this.resourceTimer);
  }
  pause(): void {
    this.playing = false;
    this.playVersion++;
    cancelAnimationFrame(this.animation);
    this.observer.render();
  }
  private async resources(version = this.version): Promise<void> {
    try {
      const status = await this.source.replayResources({
        sessionId: this.sessionId,
        ...(this.endSeq === undefined ? {} : { endSeq: this.endSeq }),
      });
      if (version === this.version && this.active)
        this.observer.resources(status);
    } catch {
      if (version === this.version) this.observer.resources(null);
    }
  }
  async seek(timeMs?: number, targetSeq?: number): Promise<void> {
    if (!this.active) return;
    this.pause();
    this.loading = true;
    const version = ++this.version;
    this.observer.render();
    this.observer.view({ message: "正在还原页面…" });
    try {
      const data = await this.source.replaySeek({
        sessionId: this.sessionId,
        ...(this.endSeq === undefined ? {} : { endSeq: this.endSeq }),
        ...(timeMs === undefined ? {} : { timeMs }),
        ...(targetSeq === undefined ? {} : { targetSeq }),
      });
      if (version !== this.version) return;
      this.endSeq = data.endSeq;
      this.duration = data.durationMs;
      this.position = data.timeMs;
      this.cursor = data.afterSeq;
      this.buffer = [];
      this.hasMore = false;
      await this.target.reset(this.sessionId, data.targetSeq, data.endSeq);
      if (version !== this.version) return;
      if (data.snapshot) {
        const snapshot = decodeReplayEvent(data.snapshot);
        if (snapshot?.type !== "dom.snapshot")
          throw new Error("回放基线不是有效快照");
        this.target.snapshot(snapshot, data.targetSeq);
      }
      while (this.cursor < data.targetSeq) {
        const chunk = await this.source.replayChunk({
          sessionId: this.sessionId,
          afterSeq: this.cursor,
          endSeq: data.targetSeq,
        });
        if (version !== this.version) return;
        if (!chunk.events.length || chunk.afterSeq <= this.cursor)
          throw new Error("回放数据不完整");
        for (const event of chunk.events) this.apply(event, true);
        this.cursor = chunk.afterSeq;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        if (version !== this.version) return;
      }
      this.hasMore = this.cursor < this.endSeq;
      this.loaded = true;
      this.observer.event(this.cursor);
      this.target.restoreScroll();
      void this.resources(version);
      clearTimeout(this.resourceTimer);
      this.resourceTimer = setTimeout(() => {
        void this.resources(version);
      }, 600);
    } catch (error) {
      if (version !== this.version) return;
      this.loaded = false;
      this.observer.view({
        message: (error instanceof Error
          ? error.message
          : String(error)
        ).replace(/^Error invoking remote method '[^']+': Error: /, ""),
      });
    } finally {
      if (version === this.version) {
        this.loading = false;
        this.observer.render();
      }
    }
  }
  private apply(event: StoredEvent, seeking: boolean): void {
    const decoded = decodeReplayEvent(event);
    if (decoded) this.target.apply(decoded, seeking);
    this.observer.event(event.seq, event.type);
  }
  async play(): Promise<void> {
    if (!this.loaded || this.loading) return;
    if (this.position >= this.duration) await this.seek();
    if (!this.active || !this.loaded || this.loading) return;
    this.playing = true;
    this.lastTick = performance.now();
    this.observer.render();
    const version = this.version,
      playVersion = ++this.playVersion;
    const tick = async (now: number): Promise<void> => {
      if (
        !this.playing ||
        version !== this.version ||
        playVersion !== this.playVersion
      )
        return;
      const next = Math.min(
        this.duration,
        this.position + Math.min(250, now - this.lastTick) * this.speed,
      );
      this.lastTick = now;
      try {
        let applied = 0;
        while (applied < 400) {
          if (!this.buffer.length && this.hasMore) {
            const chunk = await this.source.replayChunk({
              sessionId: this.sessionId,
              afterSeq: this.cursor,
              endSeq: this.endSeq ?? 0,
            });
            if (
              !this.playing ||
              version !== this.version ||
              playVersion !== this.playVersion
            )
              return;
            this.buffer = chunk.events;
            this.hasMore = chunk.hasMore;
            if (!this.buffer.length && this.hasMore)
              throw new Error("回放读取未能前进");
          }
          const event = this.buffer[0];
          if (!event || event.elapsedMs > next) break;
          this.buffer.shift();
          this.apply(event, false);
          this.cursor = event.seq;
          applied++;
        }
        this.position =
          applied === 400
            ? Math.min(next, this.buffer[0]?.elapsedMs ?? next)
            : next;
        this.observer.render();
        if (
          this.position >= this.duration &&
          !this.buffer.length &&
          !this.hasMore
        ) {
          this.pause();
          void this.resources(version);
          return;
        }
        this.animation = requestAnimationFrame((now) => {
          void tick(now);
        });
      } catch (error) {
        if (version === this.version) {
          this.pause();
          const failure =
            error instanceof Error ? error : new Error(String(error));
          this.observer.view({ message: failure.message });
          this.observer.error(failure);
        }
      }
    };
    this.animation = requestAnimationFrame((now) => {
      void tick(now);
    });
  }
}
