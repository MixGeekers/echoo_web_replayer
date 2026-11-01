export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
export function errorMessage(error: unknown): string {
  return typeof object(error).message === "string"
    ? String(object(error).message)
    : String(error);
}
export function errorCode(error: unknown): unknown {
  return object(error).code;
}
