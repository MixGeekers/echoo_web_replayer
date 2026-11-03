import type {
  Annotation,
  ResolvedExportRange,
} from "../../shared/contracts/annotations";

const cell = (value: unknown) =>
  String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const seconds = (ms: number) => `${(ms / 1000).toFixed(3)}s`;
const author = (value: Annotation["author"]) => (value === "agent" ? "Agent" : "人工");

function table(list: Annotation[]) {
  return `| 序号 | 结束序号 | 相对时间 | UTC 时间 | 事件类型 | 来源 | 标注 |\n| --- | --- | --- | --- | --- | --- | --- |\n${list
    .map(
      (item) =>
        `| ${item.seq} | ${item.endSeq ?? ""} | ${seconds(item.elapsedMs)} | ${cell(item.timestamp)} | ${cell(item.eventType)} | ${author(item.author)} | ${cell(item.text)} |`,
    )
    .join("\n")}\n`;
}

/** AGENT_README section: human bookmarks first, so analysis starts where the user saw the problem. */
export function annotationReadme(list: Annotation[], range?: ResolvedExportRange) {
  const parts: string[] = [];
  if (list.length)
    parts.push(
      `## 人工标注（优先阅读）\n\n用户在回放或录制中标记了以下位置（共 ${list.length} 条，完整内容见 \`annotations.json\`）。请优先分析这些 seq 附近的操作、DOM 变化和快照，再扩展到整条时间线。标注是人的判断或 Agent 的分析笔记，不是采集事实；来源列区分人工与 Agent。\n\n${table(list)}`,
    );
  if (range)
    parts.push(
      `## 片段导出\n\n本包只包含原记录的一个片段：请求范围 seq ${range.requestedStartSeq}–${range.requestedEndSeq}，为保证可读取和回放，从最近的${range.baselineSnapshotSeq === null ? "第一条事件" : "快照"} seq ${range.startSeq} 开始，至 seq ${range.endSeq}（${seconds(range.startElapsedMs)}–${seconds(range.endElapsedMs)}），共 ${range.eventCount} 条事件。timeline.jsonl 中每一行与原记录逐字节一致，但不包含片段之外的事件；session.json 仍是整条记录在导出截点的元数据（共 ${range.sourceEventCount} 条，序号至 ${range.sourceLastSeq}）。manifest.json 的 \`range\` 记录范围与原始字节位置。资源只包含 seq ${range.endSeq} 之前已采集的条目。片段之外没有记录不代表没有发生操作。\n`,
    );
  return parts.length ? `\n${parts.join("\n")}` : "";
}

/** timeline.md preface listing annotations before the event table. */
export function annotationMarkdown(list: Annotation[], range?: ResolvedExportRange) {
  let text = "";
  if (list.length) text += `## 人工标注\n\n${table(list)}\n`;
  if (range)
    text += `## 片段范围\n\n请求 seq ${range.requestedStartSeq}–${range.requestedEndSeq}；导出 seq ${range.startSeq}–${range.endSeq}（基线${range.baselineSnapshotSeq === null ? "为第一条事件" : `快照 #${range.baselineSnapshotSeq}`}）。\n\n`;
  return text ? `${text}## 事件\n\n` : "";
}
