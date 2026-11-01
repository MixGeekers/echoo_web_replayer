(() => {
  'use strict';
  const blockedTags = new Set(['script', 'noscript', 'object', 'embed', 'applet', 'base', 'meta']);
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  class ReplayDOM {
    constructor(frame, onView, onPointer) {
      this.frame = frame; this.onView = onView; this.onPointer = onPointer;
      this.nodes = new Map(); this.bindings = new Map(); this.scrolls = new Map(); this.bases = new WeakMap();
      this.templateHosts = new WeakMap();
      this.ready = new Promise(resolve => {
        if (frame.contentDocument?.readyState === 'complete' && frame.contentDocument.URL.endsWith('replay-frame.html')) resolve();
        else frame.addEventListener('load', resolve, { once: true });
      });
    }
    async reset(sessionId, at = 0, endSeq = at) {
      await this.ready;
      this.sessionId = sessionId; this.at = at; this.endSeq = endSeq; this.documentId = null; this.gaps = 0;
      this.nodes.clear(); this.bindings.clear(); this.scrolls.clear();
      this.frame.contentDocument.body?.replaceChildren();
      this.onPointer(null);
      this.onView({ message: '等待页面快照', gaps: 0, url: '' });
    }
    base(node) { return this.bases.get(node.ownerDocument || node) || this.url; }
    resource(value, base) { return ReplayURLs.resourceURL(value, base || this.url, this.sessionId, this.at, this.endSeq); }
    css(value, base) { return ReplayURLs.cssText(value, base || this.url, this.sessionId, this.at, this.endSeq); }
    binding(node, name, value) {
      if (!this.bindings.has(node)) this.bindings.set(node, new Map());
      this.bindings.get(node).set(name, value);
    }
    attribute(node, name, value) {
      const lower = name.toLowerCase(), tag = node.localName?.toLowerCase();
      if (/^on/i.test(name) || ['srcdoc', 'is', 'nonce', 'integrity', 'autofocus', 'autoplay', 'formaction', 'action', 'target', 'ping', 'download'].includes(lower)) return;
      if (tag === 'iframe' && ['src', 'sandbox', 'allow'].includes(lower)) return;
      if (value === null || value === undefined) { node.removeAttribute(name); this.bindings.get(node)?.delete(name); return; }
      if (lower === 'style') { this.binding(node, name, value); value = this.css(value, this.base(node)); }
      else if (lower === 'srcset') {
        // New recordings include currentSrc, avoiding ambiguous comma/data-URL srcset parsing.
        return;
      } else if (['src', 'href', 'xlink:href', 'poster', 'background'].includes(lower)) {
        if (['a', 'area', 'form'].includes(tag)) return;
        this.binding(node, name, value); value = this.resource(value, this.base(node));
      }
      try { node.setAttribute(name, String(value)); } catch { this.gaps++; }
    }
    text(node, value) {
      if (node.parentElement?.localName === 'style') {
        this.binding(node, '#text', value); node.nodeValue = this.css(value, this.base(node));
      } else node.nodeValue = value;
    }
    build(data, doc, namespace = HTML_NS, reuse = false) {
      if (!data || typeof data.nodeType !== 'number') return doc.createComment('未记录的节点');
      if (reuse && this.nodes.has(data.nodeId)) return this.nodes.get(data.nodeId);
      let node;
      if (data.nodeType === 9) node = doc;
      else if (data.nodeType === 10) node = doc.implementation.createDocumentType(data.name || 'html', data.publicId || '', data.systemId || '');
      else if (data.nodeType === 3 || data.nodeType === 4) node = doc.createTextNode(data.text || '');
      else if (data.nodeType === 8) node = doc.createComment(data.text || '');
      else if (data.nodeType === 11) node = doc.createDocumentFragment();
      else if (data.nodeType === 1) {
        const tag = String(data.nodeName || 'div').toLowerCase();
        const ns = data.namespaceURI || (tag === 'svg' ? SVG_NS : namespace);
        if (blockedTags.has(tag) || (tag === 'link' && String(data.attributes?.rel).toLowerCase() !== 'stylesheet')) node = doc.createComment(`replay: ${tag}`);
        else {
          try { node = ns === HTML_NS ? doc.createElement(tag) : doc.createElementNS(ns, data.nodeName); }
          catch { node = doc.createElement('span'); this.gaps++; }
          for (const [name, value] of Object.entries(data.attributes || {})) this.attribute(node, name, value);
          if (tag === 'iframe') { node.setAttribute('sandbox', 'allow-same-origin'); node.src = 'about:blank'; }
          if (tag === 'img') { node.loading = 'eager'; if (data.currentSrc) this.attribute(node, 'src', data.currentSrc); }
          if (tag === 'link' || tag === 'img') node.addEventListener('load', () => this.restoreScroll());
        }
      } else node = doc.createComment('replay: unsupported node');
      if (data.nodeId) this.nodes.set(data.nodeId, node);
      if ([1, 9, 11].includes(node.nodeType)) {
        for (const child of data.children || []) {
          try {
            const nextNS = node.localName === 'foreignObject' ? HTML_NS : node.namespaceURI || namespace;
            const built = this.build(child, doc, nextNS, reuse); node.appendChild(built);
            if (node.localName === 'style' && built.nodeType === 3) this.text(built, child.text || '');
          } catch { this.gaps++; }
        }
        if (data.templateContent && node.content) {
          this.templateHosts.set(node.content, node);
          if (data.templateContent.nodeId) this.nodes.set(data.templateContent.nodeId, node.content);
          for (const child of data.templateContent.children || []) node.content.append(this.build(child, doc, namespace, reuse));
        }
        if (data.shadowRoot && node.attachShadow) {
          try {
            const shadow = node.attachShadow({ mode: 'open' });
            this.nodes.set(data.shadowRoot.nodeId, shadow);
            for (const child of data.shadowRoot.children || []) {
              const built = this.build(child, doc, HTML_NS, reuse); shadow.append(built);
              if (built.localName === 'style') for (const text of built.childNodes) if (text.nodeType === 3) this.text(text, this.bindings.get(text)?.get('#text') || text.nodeValue);
            }
          } catch { this.gaps++; }
        }
        if (data.state) this.form({ ...data.state, nodeId: data.nodeId });
      }
      return node;
    }
    rebuildDocument(doc, payload) {
      this.bases.set(doc, payload.baseUrl || payload.url || this.url);
      doc.replaceChildren();
      if (payload.tree?.nodeType === 9) this.build(payload.tree, doc);
      else throw new Error('此快照没有可回放的节点树，请重新录制');
      if (!doc.documentElement) { const html = doc.createElement('html'); html.append(doc.createElement('head'), doc.createElement('body')); doc.append(html); }
      // Disable page animation and user interaction. Recorded events alone drive the view.
      const style = doc.createElement('style');
      style.textContent = 'html{scroll-behavior:auto!important}*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}';
      (doc.head || doc.documentElement).append(style);
      for (const form of payload.forms || []) this.form(form);
      this.scrolls.set(doc, payload.scroll || { x: 0, y: 0 });
      for (const scroll of payload.scrolls || []) { const node = this.nodes.get(scroll.nodeId); if (node) this.scrolls.set(node, scroll); }
    }
    snapshot(event, at = event.seq) {
      this.nodes.clear(); this.bindings.clear(); this.scrolls.clear(); this.onPointer(null);
      this.documentId = event.documentId; this.at = at;
      const payload = event.payload; this.url = payload.url || event.url;
      this.onView({ viewport: payload.viewport, url: this.url, message: '', gaps: this.gaps });
      this.rebuildDocument(this.frame.contentDocument, payload);
      for (const frame of [...(payload.frames || [])].sort((a, b) => (a.scope?.frameContexts?.length || 0) - (b.scope?.frameContexts?.length || 0))) {
        const context = frame.scope?.frameContexts?.at(-1);
        const host = this.nodes.get(context?.nodeId);
        if (host?.contentDocument) this.rebuildDocument(host.contentDocument, frame);
        else this.gaps++;
      }
      for (const shadow of payload.shadowRoots || []) for (const form of shadow.forms || []) this.form(form);
      this.restoreScroll();
    }
    form(state) {
      const node = this.nodes.get(state.nodeId); if (!node) return;
      try {
        if ('value' in state && 'value' in node && node.type !== 'file') node.value = state.value;
        if ('checked' in state && 'checked' in node) node.checked = state.checked;
        if (node.localName === 'select') {
          if (state.selectedValues) for (const option of node.options) option.selected = state.selectedValues.includes(option.value);
          else if ('selectedIndex' in state) node.selectedIndex = state.selectedIndex;
        }
        if ('text' in state && node.isContentEditable && node.textContent !== state.text) node.textContent = state.text;
      } catch { this.gaps++; }
    }
    restoreScroll() {
      for (const [node, value] of this.scrolls) {
        if (node.nodeType === 9) node.defaultView?.scrollTo({ left: value.x || 0, top: value.y || 0, behavior: 'instant' });
        else { node.scrollLeft = value.x || 0; node.scrollTop = value.y || 0; }
      }
    }
    refreshResources(at) {
      this.at = at;
      for (const [node, attributes] of this.bindings) {
        if (!node.isConnected) continue;
        for (const [name, value] of attributes) {
          if (name === '#text') this.text(node, value);
          else this.attribute(node, name, value);
        }
      }
    }
    apply(event, seeking = false) {
      if (event.type === 'dom.snapshot') { this.snapshot(event, seeking ? this.at : event.seq); return; }
      if (event.type === 'session.pause') { this.onView({ message: '采集已暂停 · 此区间没有页面记录' }); return; }
      if (event.type === 'session.resume') { this.onView({ message: '等待恢复后的页面快照' }); return; }
      if (event.type === 'page.resource') { if (!seeking) this.refreshResources(event.seq); return; }
      if (event.type === 'page.navigation' && !event.payload?.sameDocument) {
        this.frame.contentDocument.body?.replaceChildren(); this.nodes.clear(); this.bindings.clear(); this.scrolls.clear(); this.documentId = null;
        this.onView({ message: '页面跳转中 · 等待页面快照', url: event.payload.url || event.url }); return;
      }
      if (!this.documentId || (event.documentId && event.documentId !== this.documentId)) return;
      const payload = event.payload || {};
      if (event.type === 'page.image' && payload.currentSrc) {
        const node = this.nodes.get(payload.target?.nodeId);
        if (node?.localName === 'img') this.attribute(node, 'src', payload.currentSrc);
      }
      if (event.type === 'dom.mutation') {
        for (const record of payload.records || []) {
          const node = this.nodes.get(record.targetId);
          if (!node || ![1, 3, 4, 9, 11].includes(node.nodeType)) { this.gaps++; continue; }
          try {
            if (record.type === 'attributes' && node.nodeType === 1) this.attribute(node, record.attributeName, record.newValue);
            else if (record.type === 'characterData') this.text(node, record.newValue || '');
            else if (record.type === 'childList') {
              for (const removed of record.removed || []) { const old = this.nodes.get(removed.nodeId); if (old?.parentNode === node) node.removeChild(old); }
              const next = this.nodes.get(record.nextSiblingId);
              let before = next?.parentNode === node ? next : null;
              if (!before && record.previousSiblingId) { const previous = this.nodes.get(record.previousSiblingId); if (previous?.parentNode === node) before = previous.nextSibling; }
              for (const added of record.added || []) {
                const built = this.build(added, node.ownerDocument || node, node.namespaceURI || HTML_NS, true);
                node.insertBefore(built, before);
                if (node.localName === 'style' && built.nodeType === 3) this.text(built, added.text || '');
              }
            }
          } catch { this.gaps++; }
        }
        for (const [id, node] of this.nodes) if (!node.isConnected && node.nodeType !== 9 && !this.templateHosts.get(node.getRootNode())?.isConnected) { this.nodes.delete(id); this.bindings.delete(node); this.scrolls.delete(node); }
      }
      if (['action.input', 'action.change'].includes(event.type) && payload.form) this.form(payload.form);
      if (event.type === 'action.submit') for (const form of payload.fields || []) this.form(form);
      if (event.type === 'action.scroll') { const node = this.nodes.get(payload.target?.nodeId); if (node) this.scrolls.set(node, payload); }
      if (event.type === 'action.focus') this.nodes.get(payload.target?.nodeId)?.focus?.({ preventScroll: true });
      if (['action.click', 'action.dblclick'].includes(event.type)) {
        let x = payload.position?.clientX, y = payload.position?.clientY;
        const target = this.nodes.get(payload.target?.nodeId);
        let doc = target?.ownerDocument;
        while (doc && doc !== this.frame.contentDocument) { const host = doc.defaultView?.frameElement; if (!host) break; const rect = host.getBoundingClientRect(); x += rect.left; y += rect.top; doc = host.ownerDocument; }
        if (Number.isFinite(x) && Number.isFinite(y)) this.onPointer({ x, y, seeking });
      }
      if (event.type === 'page.resize' && payload.viewport) this.onView({ viewport: payload.viewport });
      this.restoreScroll(); this.onView({ gaps: this.gaps });
    }
  }
  window.ReplayDOM = ReplayDOM;
})();
