import { isIssueEvent } from "../../shared/network-events";

const cell = (value: unknown) =>
  String(value ?? "")
    .slice(0, 1024)
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** Bounded list of failed requests and uncaught page errors for timeline.md. */
export function createIssueCollector(limit = 200) {
  const rows: string[] = [];
  let total = 0;
  return {
    add(values: Record<string, unknown>) {
      if (!isIssueEvent(values.type, values.summary)) return;
      if (++total <= limit)
        rows.push(
          `| ${String(values.seq)} | ${(Number(values.elapsedMs || 0) / 1000).toFixed(3)}s | ${cell(values.type)} | ${cell(values.summary)} |\n`,
        );
    },
    get total() {
      return total;
    },
    markdown(): string {
      if (!total) return "";
      return `\n## 失败请求与页面错误\n\n共 ${total} 条：HTTP 状态 ≥ 400 的 network.response、network.failed 与 console.exception。${total > limit ? `仅列前 ${limit} 条，` : ""}完整内容见 timeline.jsonl 对应 seq。\n\n| 序号 | 相对时间 | 类型 | 摘要 |\n| --- | --- | --- | --- |\n${rows.join("")}`;
    },
  };
}
