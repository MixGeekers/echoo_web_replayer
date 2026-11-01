(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const time = value => { const tenths = Math.floor(Math.max(0, value) / 100); return `${String(Math.floor(tenths / 600)).padStart(2, '0')}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`; };
  class ReplayPlayer {
    constructor(api, onMode, onError) {
      this.api = api; this.onMode = onMode; this.onError = onError;
      this.active = false; this.playing = false; this.version = 0; this.position = 0; this.duration = 0; this.speed = 1;
      this.viewport = { width: 1000, height: 760 };
      this.dom = new ReplayDOM($('replay-frame'), view => this.view(view), pointer => this.pointer(pointer));
      $('replay-close').addEventListener('click', () => this.close());
      $('replay-play').addEventListener('click', () => this.playing ? this.pause() : this.play());
      $('replay-restart').addEventListener('click', () => this.seek());
      $('replay-back').addEventListener('click', () => this.seek(Math.max(0, this.position - 5000)));
      $('replay-forward').addEventListener('click', () => this.seek(Math.min(this.duration, this.position + 5000)));
      $('replay-speed').addEventListener('change', event => { this.speed = Number(event.target.value); });
      $('replay-progress').addEventListener('input', event => {
        const position = Number(event.target.value);
        this.pause(); clearTimeout(this.seekTimer);
        $('replay-progress').value = String(position);
        $('replay-time').textContent = `${time(position)} / ${time(this.duration)}`;
        this.seekTimer = setTimeout(() => this.seek(position), 100);
      });
      $('replay-progress').addEventListener('change', event => { clearTimeout(this.seekTimer); this.seek(Number(event.target.value)); });
      new ResizeObserver(() => this.fit()).observe($('replay-stage'));
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); });
    }
    open(sessionId, name) {
      this.sessionId = sessionId; this.endSeq = undefined; this.active = true;
      $('replay-title').textContent = name || '会话回放';
      $('replay-resource-status').textContent = '读取资源…';
      $('replay-panel').hidden = false; $('replay-toolbar').hidden = false; $('address-form').hidden = true;
      this.onMode(true); return this.seek();
    }
    close() {
      this.pause(); this.version++; this.active = false; clearTimeout(this.seekTimer); clearTimeout(this.resourceTimer);
      $('replay-panel').hidden = true; $('replay-toolbar').hidden = true; $('address-form').hidden = false;
      this.onMode(false);
    }
    view(view) {
      if (view.viewport) {
        this.viewport = { width: Math.max(1, Math.min(12000, view.viewport.width || 1000)), height: Math.max(1, Math.min(12000, view.viewport.height || 760)) };
        this.fit();
      }
      if (view.url !== undefined) { $('replay-title').title = view.url; }
      if (view.message !== undefined) { $('replay-message').textContent = view.message; $('replay-message').hidden = !view.message; }
      if (view.gaps !== undefined) $('replay-note').textContent = view.gaps ? `${view.gaps} 处记录缺口` : '按录制视口显示';
    }
    fit() {
      if (!this.active) return;
      const stage = $('replay-stage'), viewport = $('replay-viewport');
      const scale = Math.min((stage.clientWidth - 24) / this.viewport.width, (stage.clientHeight - 24) / this.viewport.height, 1);
      viewport.style.width = `${this.viewport.width}px`; viewport.style.height = `${this.viewport.height}px`;
      viewport.style.transform = `translate(-50%, -50%) scale(${Math.max(0.05, scale)})`;
    }
    pointer(point) {
      const cursor = $('replay-cursor'); cursor.hidden = !point;
      if (!point) return;
      cursor.style.left = `${point.x}px`; cursor.style.top = `${point.y}px`;
      cursor.classList.remove('clicked'); void cursor.offsetWidth; cursor.classList.add('clicked');
    }
    render() {
      $('replay-time').textContent = `${time(this.position)} / ${time(this.duration)}`;
      $('replay-progress').max = String(Math.max(1, this.duration)); $('replay-progress').value = String(this.position);
      $('replay-progress').setAttribute('aria-valuetext', `${time(this.position)}，共 ${time(this.duration)}`);
      $('replay-play').textContent = this.playing ? '暂停' : this.position >= this.duration ? '重新播放' : '播放';
      $('replay-play').disabled = this.loading || !this.loaded;
      $('replay-progress').disabled = !this.loaded;
      for (const id of ['replay-restart', 'replay-back', 'replay-forward']) $(id).disabled = !this.loaded;
    }
    pause() { this.playing = false; this.playVersion = (this.playVersion || 0) + 1; cancelAnimationFrame(this.animation); this.render(); }
    async resources(version = this.version) {
      try {
        const status = await this.api.replayResources({ sessionId: this.sessionId, endSeq: this.endSeq });
        if (version !== this.version || !this.active) return;
        $('replay-resource-status').textContent = status.available ? `本地资源 ${status.saved}${status.missing ? ` · 缺失 ${status.missing}` : ''}` : `资源未归档${status.missing ? ` · 缺失 ${status.missing}` : ''}`;
        $('replay-resource-status').title = [status.captureError, ...status.missingURLs].filter(Boolean).join('\n') || '样式、图片与字体从本地副本加载';
        $('replay-resource-status').classList.toggle('incomplete', status.missing > 0 || !status.available);
      } catch (error) { if (version === this.version) $('replay-resource-status').textContent = '资源索引读取失败'; }
    }
    async seek(timeMs, targetSeq) {
      if (!this.active) return;
      clearTimeout(this.seekTimer);
      this.pause(); this.loading = true; const version = ++this.version; this.render();
      this.view({ message: '正在还原页面…' });
      try {
        const data = await this.api.replaySeek({ sessionId: this.sessionId, endSeq: this.endSeq, timeMs, targetSeq });
        if (version !== this.version) return;
        this.endSeq = data.endSeq; this.duration = data.durationMs; this.position = data.timeMs;
        this.cursor = data.afterSeq; this.buffer = []; this.hasMore = false;
        await this.dom.reset(this.sessionId, data.targetSeq, data.endSeq);
        if (version !== this.version) return;
        if (data.snapshot) this.dom.snapshot(data.snapshot, data.targetSeq);
        while (this.cursor < data.targetSeq) {
          const chunk = await this.api.replayChunk({ sessionId: this.sessionId, afterSeq: this.cursor, endSeq: data.targetSeq });
          if (version !== this.version) return;
          if (!chunk.events.length) throw new Error('回放数据不完整');
          for (const event of chunk.events) this.apply(event, true);
          this.cursor = chunk.afterSeq;
          await new Promise(resolve => requestAnimationFrame(resolve));
          if (version !== this.version) return;
        }
        this.hasMore = this.cursor < this.endSeq; this.loaded = true;
        $('replay-event-label').textContent = `#${this.cursor} · 点击时间线可定位画面`;
        this.dom.restoreScroll();
        this.resources(version);
        clearTimeout(this.resourceTimer); this.resourceTimer = setTimeout(() => this.resources(version), 600);
      } catch (error) {
        if (version !== this.version) return;
        this.loaded = false; this.view({ message: String(error.message).replace(/^Error invoking remote method '[^']+': Error: /, '') });
      } finally { if (version === this.version) { this.loading = false; this.render(); } }
    }
    apply(event, seeking) {
      this.dom.apply(event, seeking);
      $('replay-event-label').textContent = `#${event.seq} · ${event.type}`;
    }
    async play() {
      if (!this.loaded || this.loading) return;
      if (this.position >= this.duration) await this.seek();
      if (!this.active || !this.loaded || this.loading) return;
      this.playing = true; this.lastTick = performance.now(); this.render();
      const version = this.version, playVersion = ++this.playVersion;
      const tick = async now => {
        if (!this.playing || version !== this.version || playVersion !== this.playVersion) return;
        const next = Math.min(this.duration, this.position + Math.min(250, now - this.lastTick) * this.speed);
        this.lastTick = now;
        try {
          let applied = 0;
          while (applied < 400) {
            if (!this.buffer.length && this.hasMore) {
              const chunk = await this.api.replayChunk({ sessionId: this.sessionId, afterSeq: this.cursor, endSeq: this.endSeq });
              if (!this.playing || version !== this.version || playVersion !== this.playVersion) return;
              this.buffer = chunk.events; this.hasMore = chunk.hasMore;
              if (!this.buffer.length && this.hasMore) throw new Error('回放读取未能前进');
            }
            const event = this.buffer[0];
            if (!event || event.elapsedMs > next) break;
            this.buffer.shift(); this.apply(event, false); this.cursor = event.seq; applied++;
          }
          this.position = applied === 400 ? Math.min(next, this.buffer[0]?.elapsedMs ?? next) : next;
          this.render();
          if (this.position >= this.duration && !this.buffer.length && !this.hasMore) { this.pause(); this.resources(version); return; }
          this.animation = requestAnimationFrame(tick);
        } catch (error) { if (version === this.version) { this.pause(); this.view({ message: error.message }); this.onError(error); } }
      };
      this.animation = requestAnimationFrame(tick);
    }
  }
  window.ReplayPlayer = ReplayPlayer;
})();
