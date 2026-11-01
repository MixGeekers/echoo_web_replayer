export function resourceURL(
  value: string | null | undefined,
  base: string,
  sessionId: string,
  at: number,
  endSeq = at,
) {
  const text = String(value || "").trim();
  if (!text || text.startsWith("#")) return text;
  if (
    /^data:(image\/|font\/|application\/(?:font|x-font|vnd\.ms-fontobject))/i.test(
      text,
    )
  )
    return text;
  try {
    const url = base ? new URL(text, base) : new URL(text);
    if (!["http:", "https:", "file:", "blob:"].includes(url.protocol))
      return "";
    const hash = url.hash;
    url.hash = "";
    return `tracedock-resource://asset/${encodeURIComponent(sessionId)}?url=${encodeURIComponent(url.href)}&at=${Number(at) || 0}&end=${Number(endSeq) || 0}${hash}`;
  } catch {
    return "";
  }
}
export function cssText(
  text: string,
  base: string,
  sessionId: string,
  at: number,
  endSeq = at,
) {
  const unescape = (value: string) =>
    value.replace(
      /\\([a-f0-9]{1,6})\s?|\\(.)/gi,
      (_match: string, hex: string | undefined, char: string | undefined) =>
        hex ? String.fromCodePoint(parseInt(hex, 16) || 0xfffd) : (char ?? ""),
    );
  const quote = (value: string) =>
    `"${value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/[\n\r\f]/g, "")}"`;
  // Keep comments and ordinary strings intact. Only URL tokens and quoted imports resolve against the stylesheet's URL.
  return String(text || "").replace(
    /\/\*[\s\S]*?\*\/|@import\s+("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|((?:\\.|[^)\\])*))\s*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gi,
    (
      match: string,
      imported: string | undefined,
      double: string | undefined,
      single: string | undefined,
      bare: string | undefined,
    ) => {
      if (imported !== undefined)
        return `@import ${quote(resourceURL(unescape(imported.slice(1, -1)), base, sessionId, at, endSeq))}`;
      if (/^url\(/i.test(match))
        return `url(${quote(resourceURL(unescape(double ?? single ?? (bare ?? "").trim()), base, sessionId, at, endSeq))})`;
      return match;
    },
  );
}
