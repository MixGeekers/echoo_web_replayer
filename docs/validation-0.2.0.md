# 0.2.0 验证记录

日期：2026-10-29。Windows x64，Node 24.22.1，Python 3.13.7，Electron 45.1.0。

## 自动与桌面验证

- `npm test`：59 项通过。覆盖四种导出组合、随包 Python 恢复、Unicode/NUL/孤立代理项、原始值、截点、损坏包、越界差分、检查点、取消与失败原子提交、索引游标、精确尾部恢复、短写和 65,536 条 ZIP64 条目。
- `npm run test:smoke`：10 项真实 Electron 流程通过，含默认差分 UI、随包脚本原样恢复、完整不压缩 UI 与选项记忆。
- 目录版 `dist/win-unpacked/TraceDock.exe` 的同一组 10 项桌面流程通过；21 个打包源码/资源文件与工作区逐字节一致。
- 最终单文件 `TraceDock-0.2.0-Windows-x64.exe` 的 6 项便携验收通过，包括临时解压路径中的 worker 差分导出与随包 Python 原样恢复。
- `npm run test:export-desktop`：414,771,002 字节历史会话导出期间，新录制暂停耗时 6 ms；取消后原目标文件保持原样、暂存文件清理、新录制可恢复并正常停止。
- 64 MiB 单事件在 48 MiB V8 堆限制下完成索引、全文搜索与有界详情预览。
- 105 MiB 单事件包含 40 MiB HTML、64 MiB tree 字符串和 1 MiB URL，在 64 MiB V8 堆限制下完整派生；HTML/state 独立哈希一致，峰值 RSS 83.2 MB。

## 超过 1 GiB 的端到端验收

输入是合成数据，约 90% 重复 DOM、10% 随机内容；用于验证流式处理和一致性，不代表真实网页压缩率。

| 指标 | 实测 |
| --- | --- |
| 原始时间线 | 1,110,716,444 字节，32 个事件 |
| 快照 | 16 份 HTML，每份至少 64 MiB |
| 默认差分压缩包 | 58,685,838 字节（包含脚本和说明） |
| 索引、搜索、巨型详情预览 | 11.94 秒，峰值 RSS 252.1 MB |
| 后台差分导出 | 28.68 秒，峰值 RSS 261.9 MB（含 worker） |
| Python 恢复及完整快照派生 | 217.49 秒，峰值 RSS 35.3 MB |
| 原始时间线核验 | 独立分块逐字节对比和 SHA-256 全部一致 |
| 会话元数据核验 | 与包内事实字节一致 |
| 派生 HTML 核验 | 16 份独立 SHA-256 全部一致 |

各阶段在独立进程运行。Node 采用 OS maxRSS（可用时）与 20 ms RSS 采样；Python 在 Windows 读取 PeakWorkingSetSize。MB 为十进制；单次机器实测耗时不作为所有设备的性能保证。

本机证据：

- `output/large-recording-2026-10-29T18-37-25-258Z/report-delta-deflate.json`
- `output/export-desktop-1793299334397/summary.json`
- `output/derived-stream-check/result.json`
- `output/playwright/smoke-summary.json`

验证范围是存储读取、导出和恢复。浏览器采集器一次构建完整快照的上游内存开销仍存在。MCP/Playwright 仅完成独立隔离原型，尚未接入正式软件。
