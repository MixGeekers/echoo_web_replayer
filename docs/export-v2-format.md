# TraceDock 导出格式 V2

生产契约：事实文件按字节保存和校验，派生阅读材料可重新生成。默认 `encoding=delta`、`compression=deflate`，两个字段独立接受 `delta/full` 和 `deflate/store`。

## manifest.json

固定大小的根对象：`format: "tracedock-session"`、`schemaVersion: 2`、`encoding`、`compression`、`appVersion`、`sessionId`、`exportedAt`、`startedAt`、`status`、`eventCount`、`lastSeq`、`timelineBytes`、`counts`、`redaction:false`。

`timeline` 为 `{path:"timeline.jsonl",bytes,sha256}`，描述恢复后事实字节。`files` 为固定少量物理文件的 `{path,bytes,sha256}` 数组，不含 manifest 自身；其中包括 session.json、AGENT_README.md、restore.py、files.jsonl。`files.jsonl` 每行同样为一个 `{path,bytes,sha256}`，列出所有物理文件（不包括 files.jsonl 和 manifest.json）；用于大规模 full 包的流式校验，避免 manifest 数组随快照数增长。两者有重复条目时必须一致。

delta 的物理文件为 `data.bin`、`index.jsonl`、`session.json`、`AGENT_README.md`、`restore.py`、`files.jsonl`、`manifest.json`；`derived` 标记 timeline.md/snapshots 在恢复时生成。full 包直接保存 timeline.jsonl、timeline.md、snapshots 和 snapshots.jsonl 索引，另含相同说明、脚本和校验文件。full 与 delta 都使用 V2 manifest；完整数据仍可直接解压阅读。

## 可选静态资源

回放资源扩展：新包可额外包含 `resources.jsonl` 和 `assets/<64 位小写 SHA-256>`。资源索引在 `manifest.files` 中列一次，资源内容只逐项列在 `files.jsonl`，避免根清单随资源数增长。资源行记录 `seq`、`elapsedMs`、`url`、`mimeType`、`status`，保存成功时附 `sha256`/`bytes`，失败时附 `error`。资产先落盘，再与时间线中的 `page.resource` 事件和索引串行提交；导出固定索引字节边界且拒绝超出截点的资源事件。相同内容可由多个 URL/版本引用，资源字节不参与时间线的 COPY/ADD 编码。请使用新包随附的还原脚本；旧版严格限制 delta 文件数量的还原器不支持扩展。`--timeline-only` 恢复资源索引但不复制资产到结果目录。

## 可选标注与片段范围

**annotations.json**：记录有书签或注释时，包内附带 `annotations.json`，在 `manifest.files` 与 `files.jsonl` 中各列一次并校验 SHA-256；manifest 另有 `annotations:{path:"annotations.json",count}`。没有标注时不生成该文件，也没有该字段。文件为 `{format:"tracedock-annotations",schemaVersion:1,recordingId,revision,annotations:[...]}`，每项含 `id`（`annotation-<uuid>`）、`seq`、`endSeq`（null 或不小于 seq 的包含式结束序号）、`text`、`author`（`user`/`agent`）、`createdAt`、`updatedAt`、`elapsedMs`、`timestamp`、`eventType`。标注是采集记录目录中的独立元数据，不写入时间线；导出时只保留锚点位于导出事件范围内的项，`endSeq` 截到范围末尾。restore.py 校验格式、ID、作者、序号范围及 manifest 计数，在 delta/full 和 `--timeline-only` 下都复制该文件并写入 restored-files.jsonl；派生 `timeline.md` 顶部列出“人工标注”。AGENT_README.md 在恢复说明之前列出“人工标注（优先阅读）”。

**range**：片段导出的 manifest 增加 `range` 对象：`requestedStartSeq`、`requestedEndSeq`、`startSeq`、`endSeq`、`baselineSnapshotSeq`（无更早快照时为 null，从第一条事件开始）、`startByte`/`endByte`（原 timeline.jsonl 的字节区间）、`startElapsedMs`/`endElapsedMs`、`sourceEventCount`/`sourceLastSeq`/`sourceTimelineBytes`，以及片段内 `eventCount`/`actionCount`/`mutationCount`/`snapshotCount`。片段从请求起点处或之前最近的 `dom.snapshot` 开始，到请求终点为止；timeline.jsonl 是原文件的连续字节区间，每行逐字节一致。根字段 `eventCount`、`lastSeq`、`timelineBytes`、`timeline`、`counts` 描述片段本身；`session.json` 仍是整条记录在截点的元数据。resources.jsonl 只保留 `seq <= range.endSeq` 的行及其资产。差分编码作用于片段字节，检查点和窗口规则不变。restore.py 校验首条与末条 seq、事件数与 `range` 一致。按时间请求（startMs/endMs，基于 elapsedMs）解析为同样的 seq 字段。
## 可选 Playwright 脚本

导出时勾选「附带 Playwright 脚本」（`ExportOptions.script=true`，默认关闭）会在包根目录增加 `script.spec.ts`：由同一导出截点的时间线操作事件生成的 Playwright Test（TypeScript）草稿，生成时间固定为 `exportedAt`。它与 session.json 等入口文件一样同时列在 `manifest.files` 和 `files.jsonl`（含 bytes/sha256），manifest 另有 `playwrightScript:"script.spec.ts"`；未勾选时这两个字段和文件都不存在，V2 其他结构不变。脚本是派生阅读材料，不参与 COPY/ADD 编码，也不替代 timeline.jsonl。随包 restore.py 在 delta/full 两种模式下校验并把它复制到恢复目录、写入 restored-files.jsonl；旧版还原器不认识这个文件，会按“未知 delta 文件”拒绝。

## 差分参数和索引

`delta` 对象：`codec:"copy-add-v1"`、`data:"data.bin"`、`index:"index.jsonl"`、`blockBytes:1048576`、`windowBytes:4194304`、`checkpointBlocks:16`、`blocks`。每块原始字节不超过 1 MiB；每 16 块开始独立检查点，窗口只含当前检查点内前序字节最多 4 MiB 的已恢复字节。检查点首块必为 raw，任何跨检查点引用都非法。

index.jsonl 每行：

```json
{"index":0,"offset":0,"bytes":1048576,"sha256":"...","mode":"raw","dataOffset":0,"dataBytes":1048576,"dataSha256":"...","windowStart":0,"windowBytes":0,"checkpoint":true}
```

`index` 从 0 连续递增；`offset`/`dataOffset` 为原始 timeline/data.bin 的连续绝对字节偏移；`bytes` 是恢复长度；`dataBytes` 是该编码块长度。`mode` 仅 raw 或 delta。`windowStart`/`windowBytes` 必须与当前检查点内前序字节尾部窗口严格一致，即 `max(checkpointOffset, offset-4194304)` 与差值；raw 模式也记录此窗口。`checkpoint` 必须在 index%16==0 时为 true，其他为 false。最终块允许不足1MiB；非末块必须完整。零字节时间线没有块，data.bin和index.jsonl均为空。

所有数字必须为非负安全整数（小于等于 2^53-1）；块局部长度/偏移使用 uint32。每块编码和原字节分别验证 dataSha256/sha256；结束验证 timeline 总长度、SHA256，以及 data/index 物理文件哈希和流无多余尾字节。

## COPY/ADD 二进制操作

raw 块直接保存原字节，`dataBytes == bytes`。delta 块无头部，按序读取以下指令，整数为 little-endian：

- `0x00` ADD：uint32 长度 N，紧接 N 字节新增内容。
- `0x01` COPY：uint32 窗口内相对偏移 O，uint32 长度 N。从已验证的窗口读取 `[O,O+N)`，不允许引用当前块输出。

每条指令长度必须大于0。未知操作码、截断、超出窗口、输出超过预期长度或最终长度不等均失败。恢复无需理解 UTF-8/JSON，故跨字符、跨事件、换行和转义都原样保留。块差分无收益时存 raw；编码器匹配指纹后逐字节复核，不依赖弱哈希决定数据等价。

## 恢复

随包 restore.py 使用 Python 标准库，从ZIP或展开目录恢复到新目录。先验证 manifest 与物理文件，按序还原并流式校验 timeline，完成后原子提交输出目录；已存在目标不覆盖。事实 timeline/session 保证字节一致，派生 timeline.md/snapshots 保证内容等价并独立计算恢复哈希，不能冒用旧文件字节哈希。`--timeline-only` 仅恢复事实及说明，可避免派生文件开销。full 模式应支持验证并复制事实/已存在派生文件，不重新编码事实。

输入损坏或取消必须失败而非静默跳过；不执行 HTML 或网页脚本。哈希检测损坏，不是来源认证。
