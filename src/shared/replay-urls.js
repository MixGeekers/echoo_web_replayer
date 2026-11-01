(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReplayURLs = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function resourceURL(value, base, sessionId, at, endSeq = at) {
    const text = String(value || '').trim();
    if (!text || text.startsWith('#')) return text;
    if (/^data:(image\/|font\/|application\/(?:font|x-font|vnd\.ms-fontobject))/i.test(text)) return text;
    try {
      const url = base ? new URL(text, base) : new URL(text);
      if (!['http:', 'https:', 'file:', 'blob:'].includes(url.protocol)) return '';
      const hash = url.hash; url.hash = '';
      return `tracedock-resource://asset/${encodeURIComponent(sessionId)}?url=${encodeURIComponent(url.href)}&at=${Number(at) || 0}&end=${Number(endSeq) || 0}${hash}`;
    } catch { return ''; }
  }
  function cssText(text, base, sessionId, at, endSeq = at) {
    const unescape = value => value.replace(/\\([a-f0-9]{1,6})\s?|\\(.)/gi, (_match, hex, char) => hex ? String.fromCodePoint(parseInt(hex, 16) || 0xfffd) : char);
    const quote = value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\f]/g, '')}"`;
    // Keep comments and ordinary strings intact. Only URL tokens and quoted imports resolve against the stylesheet's URL.
    return String(text || '').replace(/\/\*[\s\S]*?\*\/|@import\s+("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|((?:\\.|[^)\\])*))\s*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gi, (match, imported, double, single, bare) => {
      if (imported !== undefined) return `@import ${quote(resourceURL(unescape(imported.slice(1, -1)), base, sessionId, at, endSeq))}`;
      if (/^url\(/i.test(match)) return `url(${quote(resourceURL(unescape(double ?? single ?? bare.trim()), base, sessionId, at, endSeq))})`;
      return match;
    });
  }
  return { resourceURL, cssText };
});
