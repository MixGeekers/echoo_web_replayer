/** The tag check keeps DOM lookup types honest when HTML changes. */
export function element<K extends keyof HTMLElementTagNameMap>(
  id: string,
  tag: K,
): HTMLElementTagNameMap[K] {
  const node = document.getElementById(id);
  if (!node || node.localName !== tag)
    throw new Error(`Expected <${tag}> #${id}`);
  return node as HTMLElementTagNameMap[K];
}
export function required<T>(
  value: T | null | undefined,
  description = "DOM element",
): T {
  if (value === null || value === undefined)
    throw new Error(`Missing ${description}`);
  return value;
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
