'use strict';

// This file is deliberately self-contained: sandboxed Electron preloads cannot
// load local modules, and no recording APIs are exposed to the website.
const { ipcRenderer } = require('electron');

(() => {
  const documentId = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const nodeIds = new WeakMap();
  const observedRoots = new Map();
  const observedDocuments = new Map();
  const seenEvents = new WeakSet();
  const watchedFrames = new WeakSet();
  const pendingScrolls = new Map();
  let nextNodeId = 1;
  let recording = false;
  let sessionId = null;
  let stateVersion = 0;
  let mutationQueue = [];
  let mutationTimer = null;
  let scrollTimer = null;
  let discoveryTimer = null;
  let initialSnapshotPending = false;
  let flushing = false;

  const coverage = {
    mainDocument: true,
    sameOriginFrames: true,
    openShadowRoots: true,
    shadowDiscoveryIntervalMs: 1000,
    crossOriginFrames: false,
    closedShadowRoots: false,
    canvasAndWebGLPixels: false,
    networkTraffic: false,
    javascriptHeap: false,
    dataRedaction: false,
    mutationSemantics: 'Mutation records preserve observer delivery order. Added/removed subtree state is sampled at observer delivery; this is evidence for analysis, not a guaranteed pixel-perfect replay.',
  };

  function nodeId(node) {
    if (!node) return null;
    if (!nodeIds.has(node)) nodeIds.set(node, `n${nextNodeId++}`);
    return nodeIds.get(node);
  }

  function safeUrl(doc = document) {
    try { return doc.location.href; } catch { return ''; }
  }

  function send(type, payload, timestamp = new Date().toISOString()) {
    if (!recording || !sessionId) return;
    ipcRenderer.send('recorder:event', {
      sessionId, type, timestamp, documentId,
      url: safeUrl(), title: document.title || '', payload,
    });
  }

  function reportError(operation, error) {
    try { send('recorder.error', { operation, message: String(error?.message || error) }); } catch { /* The frame may be going away. */ }
  }

  function cssEscape(value) {
    return CSS.escape(String(value));
  }

  function quoted(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ').replace(/\r/g, '\\d ')}"`;
  }

  function selectorFor(node) {
    let element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) return null;
    const root = element.getRootNode();
    try {
      if (element.id) {
        const candidate = `#${cssEscape(element.id)}`;
        if (root.querySelectorAll(candidate).length === 1) return candidate;
      }
      const testId = element.getAttribute('data-testid');
      if (testId !== null) {
        const candidate = `[data-testid=${quoted(testId)}]`;
        if (root.querySelectorAll(candidate).length === 1) return candidate;
      }
    } catch { /* Fall back to a structural selector. */ }
    const parts = [];
    while (element) {
      let part = cssEscape(element.localName || element.nodeName.toLowerCase());
      const parent = element.parentElement;
      // A ShadowRoot's direct children have no parentElement. Count siblings
      // through parentNode as well so their selectors remain unambiguous.
      const siblingContainer = parent || element.parentNode;
      if (siblingContainer?.children) {
        const siblings = Array.from(siblingContainer.children).filter(sibling => sibling.localName === element.localName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(element) + 1})`;
      }
      parts.unshift(part);
      element = parent;
    }
    return parts.join(' > ');
  }

  function scopeFor(node) {
    const doc = node?.nodeType === 9 ? node : node?.ownerDocument || document;
    const framePath = [];
    const frameContexts = [];
    try {
      let win = doc.defaultView;
      while (win && win !== window && win.frameElement) {
        const frame = win.frameElement;
        const selector = selectorFor(frame);
        framePath.unshift(selector);
        frameContexts.unshift({ selector, nodeId: nodeId(frame), shadowPath: shadowPathFor(frame) });
        win = win.parent;
      }
    } catch { /* A navigation may detach a frame while an event is delivered. */ }
    return { framePath, frameContexts, frameUrl: safeUrl(doc), shadowPath: shadowPathFor(node), rootId: nodeId(node?.getRootNode?.() || doc) };
  }

  function shadowPathFor(node) {
    const shadowPath = [];
    let root = node?.getRootNode?.();
    while (root?.host) {
      shadowPath.unshift(selectorFor(root.host));
      root = root.host.getRootNode();
    }
    return shadowPath;
  }

  function attributesFor(element) {
    return Object.fromEntries(Array.from(element.attributes || [], attribute => [attribute.name, attribute.value]));
  }

  function locatorsFor(element, selector) {
    const candidates = [];
    const testId = element.getAttribute('data-testid');
    if (testId !== null) candidates.push({ strategy: 'testId', value: testId });
    if (element.id) candidates.push({ strategy: 'id', value: element.id });
    const labels = Array.from(element.labels || [], label => label.textContent.trim()).filter(Boolean);
    for (const label of labels) candidates.push({ strategy: 'label', value: label });
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) candidates.push({ strategy: 'label', value: ariaLabel });
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) candidates.push({ strategy: 'placeholder', value: placeholder });
    const role = element.getAttribute('role') || ({ button: 'button', a: element.hasAttribute('href') ? 'link' : undefined, select: 'combobox', textarea: 'textbox' })[element.localName];
    const text = (element.textContent || '').trim();
    if (role) candidates.push({ strategy: 'role', value: role, name: ariaLabel || text || labels[0] || '' });
    if (text) candidates.push({ strategy: 'text', value: text });
    if (selector) candidates.push({ strategy: 'css', value: selector });
    return candidates;
  }

  function describe(node) {
    if (!node) return null;
    const element = node.nodeType === 1 ? node : node.parentElement;
    const selector = selectorFor(node);
    const result = { nodeId: nodeId(node), nodeType: node.nodeType, nodeName: node.nodeName, selector, scope: scopeFor(node) };
    if (element) {
      result.tagName = element.localName;
      result.text = element.textContent || '';
      result.attributes = attributesFor(element);
      result.locators = locatorsFor(element, selector);
    }
    return result;
  }

  function serializeNode(node) {
    const result = { nodeId: nodeId(node), nodeType: node.nodeType, nodeName: node.nodeName };
    if (node.nodeType === 1) {
      result.attributes = attributesFor(node);
      if (node.localName === 'template' && node.content) result.templateContent = serializeNode(node.content);
      if (node.shadowRoot) result.shadowRoot = serializeNode(node.shadowRoot);
    } else if (node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 8) {
      result.text = node.nodeValue;
    } else if (node.nodeType === 10) {
      result.name = node.name;
      result.publicId = node.publicId;
      result.systemId = node.systemId;
    }
    if (node.childNodes.length) result.children = Array.from(node.childNodes, serializeNode);
    return result;
  }

  function formState(element) {
    const result = { nodeId: nodeId(element), selector: selectorFor(element), scope: scopeFor(element), tagName: element.localName, name: element.getAttribute('name'), type: element.getAttribute('type') };
    if ('value' in element) result.value = element.value;
    if ('checked' in element) result.checked = element.checked;
    if (element.localName === 'select') {
      result.selectedIndex = element.selectedIndex;
      result.selectedValues = Array.from(element.selectedOptions, option => option.value);
    }
    if (element.isContentEditable) result.text = element.textContent;
    if (element.files) result.files = Array.from(element.files, file => ({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified }));
    return result;
  }

  function collectForms(root) {
    return Array.from(root.querySelectorAll('input, textarea, select, [contenteditable]'), formState);
  }

  function doctypeFor(doc) {
    const value = doc.doctype;
    if (!value) return '';
    const publicPart = value.publicId ? ` PUBLIC "${value.publicId}"` : '';
    const systemPart = value.systemId ? `${value.publicId ? '' : ' SYSTEM'} "${value.systemId}"` : '';
    return `<!DOCTYPE ${value.name}${publicPart}${systemPart}>`;
  }

  function viewportFor(doc) {
    const win = doc.defaultView;
    return { width: win?.innerWidth || 0, height: win?.innerHeight || 0, devicePixelRatio: win?.devicePixelRatio || 1 };
  }

  function documentSnapshot(doc) {
    const win = doc.defaultView;
    const doctype = doctypeFor(doc);
    return {
      nodeId: nodeId(doc), url: safeUrl(doc), title: doc.title || '', scope: scopeFor(doc),
      html: `${doctype}${doctype ? '\n' : ''}${doc.documentElement?.outerHTML || ''}`,
      tree: serializeNode(doc), forms: collectForms(doc),
      scroll: { x: win?.scrollX || 0, y: win?.scrollY || 0 }, viewport: viewportFor(doc),
    };
  }

  function snapshot(reason = 'manual') {
    if (!recording) return { ok: false, error: 'Recorder is not recording' };
    try {
      discover(document, false);
      flushMutations();
      flushScrolls();
      const main = documentSnapshot(document);
      const frames = [];
      const shadowRoots = [];
      for (const [root] of observedRoots) {
        if (!isRootAttached(root)) continue;
        if (root.nodeType === 9 && root !== document) frames.push(documentSnapshot(root));
        if (root.host) shadowRoots.push({ nodeId: nodeId(root), host: describe(root.host), html: root.innerHTML, forms: collectForms(root) });
      }
      const inaccessibleFrames = [];
      for (const [root] of observedRoots) {
        if (!isRootAttached(root)) continue;
        for (const frame of root.querySelectorAll('iframe, frame')) {
          try {
            if (!frame.contentDocument?.documentElement) inaccessibleFrames.push({ target: describe(frame), src: frame.getAttribute('src'), reason: 'cross-origin, sandboxed, or not yet loaded' });
          } catch { inaccessibleFrames.push({ target: describe(frame), src: frame.getAttribute('src'), reason: 'cross-origin or sandboxed' }); }
        }
      }
      send('dom.snapshot', { reason, ...main, frames, shadowRoots, inaccessibleFrames, coverage });
      return { ok: true };
    } catch (error) {
      reportError('snapshot', error);
      return { ok: false, error: String(error?.message || error) };
    }
  }

  function serializeMutations(records) {
    if (!recording || !records.length) return;
    const observedAt = new Date().toISOString();
    // MutationRecord has the old value, not the value at the exact mutation.
    // A later record's oldValue reconstructs intermediate attribute/text values
    // within this callback; the last record uses the current value.
    const laterValues = new Map();
    const output = new Array(records.length);
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      const targetId = nodeId(record.target);
      const result = { type: record.type, targetId, target: { nodeId: targetId, nodeName: record.target.nodeName, selector: selectorFor(record.target) }, scope: scopeFor(record.target), observedAt };
      if (record.type === 'attributes') {
        const key = `${targetId}:attribute:${record.attributeNamespace || ''}:${record.attributeName}`;
        result.attributeName = record.attributeName;
        result.attributeNamespace = record.attributeNamespace;
        result.oldValue = record.oldValue;
        result.newValue = laterValues.has(key) ? laterValues.get(key) : record.target.getAttributeNS(record.attributeNamespace, record.attributeName);
        laterValues.set(key, record.oldValue);
      } else if (record.type === 'characterData') {
        const key = `${targetId}:text`;
        result.oldValue = record.oldValue;
        result.newValue = laterValues.has(key) ? laterValues.get(key) : record.target.nodeValue;
        laterValues.set(key, record.oldValue);
      } else {
        result.previousSiblingId = nodeId(record.previousSibling);
        result.nextSiblingId = nodeId(record.nextSibling);
        result.added = Array.from(record.addedNodes, serializeNode);
        result.removed = Array.from(record.removedNodes, serializeNode);
      }
      output[index] = result;
    }
    // Avoid the engine's argument-count limit on very large mutation batches.
    for (const record of output) mutationQueue.push(record);
    if (!mutationTimer) mutationTimer = setTimeout(flushMutations, 150);
  }

  function takeMutationRecords() {
    for (const { observer } of observedRoots.values()) serializeMutations(observer.takeRecords());
  }

  function flushMutations() {
    if (flushing) return;
    flushing = true;
    try {
      if (mutationTimer) clearTimeout(mutationTimer);
      mutationTimer = null;
      takeMutationRecords();
      if (mutationTimer) clearTimeout(mutationTimer);
      mutationTimer = null;
      if (mutationQueue.length) {
        const records = mutationQueue;
        mutationQueue = [];
        send('dom.mutation', { records, recordCount: records.length, batchIntervalMs: 150 }, records[0].observedAt);
      }
    } catch (error) { reportError('flush-mutations', error); }
    finally { flushing = false; }
  }

  function flushScrolls() {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = null;
    for (const entry of pendingScrolls.values()) send('action.scroll', entry.payload, entry.timestamp);
    pendingScrolls.clear();
  }

  function actionHandler(event) {
    if (!recording || seenEvents.has(event)) return;
    seenEvents.add(event);
    try {
      const target = event.composedPath?.()[0] || event.target;
      const timestamp = new Date().toISOString();
      if (event.type === 'scroll') {
        const doc = target.nodeType === 9 ? target : target.ownerDocument;
        const win = doc?.defaultView;
        const payload = {
          target: describe(target), trusted: event.isTrusted,
          x: target.nodeType === 9 ? win?.scrollX || 0 : target.scrollLeft || 0,
          y: target.nodeType === 9 ? win?.scrollY || 0 : target.scrollTop || 0,
          coalesced: true,
        };
        pendingScrolls.set(nodeId(target), { payload, timestamp });
        if (!scrollTimer) scrollTimer = setTimeout(flushScrolls, 150);
        return;
      }
      flushMutations();
      flushScrolls();
      const payload = { target: describe(target), trusted: event.isTrusted, modifiers: { alt: !!event.altKey, ctrl: !!event.ctrlKey, meta: !!event.metaKey, shift: !!event.shiftKey } };
      if (event.type === 'click' || event.type === 'dblclick') {
        payload.position = { clientX: event.clientX, clientY: event.clientY, pageX: event.pageX, pageY: event.pageY, screenX: event.screenX, screenY: event.screenY };
        payload.button = event.button;
        payload.detail = event.detail;
      }
      if (event.type === 'input' || event.type === 'change') {
        payload.form = formState(target);
        if (event.inputType !== undefined) payload.inputType = event.inputType;
        if (event.data !== undefined) payload.data = event.data;
        payload.isComposing = !!event.isComposing;
      }
      if (event.type === 'keydown') {
        payload.key = event.key;
        payload.code = event.code;
        payload.repeat = event.repeat;
        payload.isComposing = event.isComposing;
      }
      if (event.type === 'submit') {
        payload.submitter = describe(event.submitter);
        payload.fields = Array.from(target.elements || [], formState);
        payload.action = target.action;
        payload.method = target.method;
      }
      send(`action.${event.type === 'focusin' ? 'focus' : event.type}`, payload, timestamp);
    } catch (error) { reportError(`action-${event.type}`, error); }
  }

  const actionTypes = ['click', 'dblclick', 'input', 'change', 'keydown', 'submit', 'focusin', 'scroll'];

  function isRootAttached(root) {
    if (root === document) return true;
    if (root.host) return root.host.isConnected && isRootAttached(root.host.ownerDocument);
    try { return !!root.defaultView?.frameElement?.isConnected && root.defaultView.frameElement.contentDocument === root; } catch { return false; }
  }

  function registerRoot(root) {
    if (observedRoots.has(root)) return false;
    const observer = new MutationObserver(records => {
      try {
        serializeMutations(records);
        for (const record of records) {
          for (const added of record.addedNodes || []) {
            if (added.nodeType === 1) discover(added, true);
          }
        }
      } catch (error) { reportError('mutation-observer', error); }
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true });
    for (const type of actionTypes) root.addEventListener(type, actionHandler, { capture: true, passive: type === 'scroll' });
    observedRoots.set(root, { observer });
    nodeId(root);
    if (root.nodeType === 9 && root !== document && !observedDocuments.has(root)) {
      const onPageHide = () => {
        flushMutations();
        flushScrolls();
        send('page.lifecycle', { event: 'frame-pagehide', scope: scopeFor(root) });
      };
      root.defaultView?.addEventListener('pagehide', onPageHide);
      observedDocuments.set(root, onPageHide);
    }
    return true;
  }

  function discover(root, announce = false) {
    if (!recording || !root?.querySelectorAll) return false;
    let discovered = (root.nodeType === 9 || root.host) ? registerRoot(root) : false;
    const elements = root.nodeType === 1 ? [root, ...root.querySelectorAll('*')] : Array.from(root.querySelectorAll('*'));
    for (const element of elements) {
      if (element.shadowRoot) {
        const isNew = !observedRoots.has(element.shadowRoot);
        registerRoot(element.shadowRoot);
        const nestedDiscovered = discover(element.shadowRoot, false);
        discovered = discovered || isNew || nestedDiscovered;
      }
      if (element.localName === 'iframe' || element.localName === 'frame') {
        if (!watchedFrames.has(element)) {
          element.addEventListener('load', () => {
            if (!recording) return;
            discover(element, false);
            snapshot('frame-load');
          });
          watchedFrames.add(element);
        }
        try {
          const childDoc = element.contentDocument;
          if (childDoc) {
            const isNew = !observedRoots.has(childDoc);
            registerRoot(childDoc);
            const nestedDiscovered = discover(childDoc, false);
            discovered = discovered || isNew || nestedDiscovered;
          }
        } catch { /* Cross-origin and sandboxed frames are listed in snapshot coverage. */ }
      }
    }
    if (discovered && announce) snapshot('scope-discovered');
    return discovered;
  }

  function cleanupDetachedRoots() {
    for (const [root, { observer }] of observedRoots) {
      if (isRootAttached(root)) continue;
      serializeMutations(observer.takeRecords());
      observer.disconnect();
      for (const type of actionTypes) root.removeEventListener(type, actionHandler, true);
      observedRoots.delete(root);
      const onPageHide = observedDocuments.get(root);
      if (onPageHide) root.defaultView?.removeEventListener('pagehide', onPageHide);
      observedDocuments.delete(root);
    }
  }

  function deactivate() {
    if (mutationTimer) clearTimeout(mutationTimer);
    if (scrollTimer) clearTimeout(scrollTimer);
    if (discoveryTimer) clearInterval(discoveryTimer);
    mutationTimer = scrollTimer = discoveryTimer = null;
    for (const [root, { observer }] of observedRoots) {
      observer.disconnect();
      for (const type of actionTypes) root.removeEventListener(type, actionHandler, true);
    }
    for (const [doc, onPageHide] of observedDocuments) doc.defaultView?.removeEventListener('pagehide', onPageHide);
    observedRoots.clear();
    observedDocuments.clear();
    mutationQueue = [];
    pendingScrolls.clear();
    initialSnapshotPending = false;
    recording = false;
  }

  function activate(nextSessionId) {
    sessionId = nextSessionId;
    recording = true;
    registerRoot(document);
    discover(document, false);
    send('page.lifecycle', { event: 'recording-start', readyState: document.readyState, coverage });
    if (document.documentElement) snapshot('recording-start');
    else initialSnapshotPending = true;
    discoveryTimer = setInterval(() => {
      try { cleanupDetachedRoots(); discover(document, true); } catch (error) { reportError('scope-discovery', error); }
    }, 1000);
  }

  function applyState(state) {
    const shouldRecord = !!state?.recording && typeof state.sessionId === 'string';
    if (recording && (!shouldRecord || state.sessionId !== sessionId)) {
      flushMutations();
      flushScrolls();
      deactivate();
    }
    if (shouldRecord && !recording) activate(state.sessionId);
    else if (!shouldRecord) sessionId = state?.sessionId || null;
  }

  ipcRenderer.on('recorder:state', (_event, state) => {
    stateVersion++;
    try { applyState(state); } catch (error) { reportError('apply-state', error); }
  });

  ipcRenderer.on('recorder:command', (_event, message) => {
    let result = { ok: true };
    try {
      if (message?.command === 'snapshot') result = snapshot(message.reason || 'manual');
      else if (message?.command === 'flush' || message?.command === 'stop') {
        flushMutations();
        flushScrolls();
        if (message.command === 'stop') deactivate();
      } else result = { ok: false, error: 'Unsupported recorder command' };
    } catch (error) {
      reportError('command', error);
      result = { ok: false, error: String(error?.message || error) };
    }
    finally { ipcRenderer.send('recorder:ack', { requestId: message?.requestId, ...result }); }
  });

  document.addEventListener('DOMContentLoaded', () => {
    if (!recording) return;
    discover(document, false);
    send('page.lifecycle', { event: 'dom-content-loaded', readyState: document.readyState });
    snapshot(initialSnapshotPending ? 'initial-document' : 'dom-content-loaded');
    initialSnapshotPending = false;
  }, { once: true });

  window.addEventListener('load', () => {
    if (!recording) return;
    discover(document, false);
    send('page.lifecycle', { event: 'load', readyState: document.readyState });
    snapshot('page-load');
  }, { once: true });

  window.addEventListener('pagehide', event => {
    flushMutations();
    flushScrolls();
    send('page.lifecycle', { event: 'pagehide', persisted: event.persisted });
  });

  window.addEventListener('pageshow', event => {
    if (recording && event.persisted) snapshot('bfcache-restore');
  });

  const readyVersion = stateVersion;
  ipcRenderer.invoke('recorder:ready').then(state => {
    if (readyVersion === stateVersion) applyState(state);
  }).catch(error => reportError('recorder-ready', error));
})();
