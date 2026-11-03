import type { EventPreview } from "../../shared/contracts/ui";
import { formatNetworkDetail, isErrorEvent } from "../../shared/network-events";

/** Timeline label, icon and category for network / console events. */
export function networkPresentation(
  event: EventPreview,
): [string, string, string] | null {
  const issue = isErrorEvent(event.type, event.summary) ? " issue" : "";
  switch (event.type) {
    case "network.request":
      return ["网络请求", "route", "network"];
    case "network.response":
      return ["网络响应", "route", `network${issue}`];
    case "network.failed":
      return ["请求失败", "route", `network${issue}`];
    case "console.message":
      return ["控制台", "code", `console${issue}`];
    case "console.exception":
      return ["页面异常", "info", `console${issue}`];
    default:
      return null;
  }
}
export const isNetworkEvent = (type: string) =>
  type.startsWith("network.") || type.startsWith("console.");
/** Network bodies are larger than ordinary events; read up to the preview ceiling. */
export const NETWORK_DETAIL_BYTES = 1024 * 1024;
export function networkDetail(
  type: string,
  preview: string,
  truncated: boolean,
): string | null {
  if (truncated || !isNetworkEvent(type)) return null;
  try {
    const event = JSON.parse(preview) as { payload?: unknown };
    return formatNetworkDetail(type, event.payload);
  } catch {
    return null;
  }
}
