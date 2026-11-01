# TraceDock 导出格式 V2

生产契约：事实文件按字节保存和校验，派生阅读材料可重新生成。默认 `encoding=delta`、`compression=deflate`，两个字段独立接受 `delta/full` 和 `deflate/store`。

## manifest.json

固定大小的根对象：`format: "tracedock-session"`、`schemaVersion: 2`、`encoding`、`compression`、`appVersion`、`sessionId`、`exportedAt`、`startedAt`、`status`、`eventCount`、`lastSeq`、`timelineBytes`、`counts`、`redaction:false`。

`timeline` 为 `{path:"timeline.jsonl",bytes,sha256}`，描述恢复后事实字节。`files` 为固定少量物理文件的 `{path,bytes,sha256}` 数组，不含 manifest 自身；其中包括 session.json、AGENT_README.md、restore.py、files.jsonl。`files.jsonl` 每行同样为一个 `{path,bytes,sha256}`，列出所有物理文件（不包括 files.jsonl 和 manifest.json）；用于大规模 full 包的流式校验，避免 manifest 数组随快照数增长。两者有重复条目时必须一致。

delta 的物理文件为 `data.bin`、`index.jsonl`、`session.json`、`AGENT_README.md`、`restore.py`、`files.jsonl`、`manifest.json`；`derived` 标记 timeline.md/snapshots 在恢复时生成。full 包直接保存 timeline.jsonl、timeline.md、snapshots 和 snapshots.jsonl 索引，另含相同说明、脚本和校验文件。full 与 delta 都使用 V2 manifest；完整数据仍可直接解压阅读。

## 差分参数和索引

`delta` 对象：`codec:"copy-add-v1"`、`data:"data.bin"`、`index:"index.jsonl"`、`blockBytes:1048576`、`windowBytes:4194304`、`checkpointBlocks:16`、`blocks`。每块原始字节不超过 1 MiB；每 16 块开始独立检查点，窗口只含当前检查点内最多 4 MiB 的已恢复字节。检查点首块必为 raw，任何跨检查点引用都非法。

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
