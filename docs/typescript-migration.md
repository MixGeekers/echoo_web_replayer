# TS7 迁移与模块边界

本次采用 TypeScript 7.0.2、esbuild 和 electron-builder。单 npm 项目，多运行入口。

## 模块与状态所有权

- `main/index.ts` 组装依赖。录制命令队列、当前会话和采集确认由 `main/recording.ts` 唯一持有；浏览器事件由 `main/browser.ts` 接入，IPC 注册与参数校验位于 `main/ipc.ts`。
- `main/export-jobs.ts` 管理桌面导出任务。仅快照/截点进入录制命令队列，实际导出在 Worker 中进行，保留暂停、继续和取消能力。
- `main/storage/` 保留统一 SessionStore 门面及写入队列，内部拆分索引、流式 JSON token 解析和 TimelineReader。资源写入与捕获截点仍共享存储顺序。
- `main/resources/` 分为捕获（CDP 边界）、资源目录和离线协议。离线读取无需连接实时浏览器；资源版本选择受回放位置和冻结 endSeq 双重约束。
- `main/export/` 分为任务桥接、Worker、流水线、说明生成、派生材料、差分编码和 ZIP64。
- `preload/` 只处理桥接和初始化。采集器源码按 controller/context/nodes/guards/snapshot/actions/mutations/roots 拆分，构建时合并为单文件沙箱 preload，Electron 保持外部依赖。
- `replay/controller.ts` 仅依赖数据源、重建目标、状态观察者和时钟接口；`replay/model.ts` 校验事件；`replay/dom.ts` 重建页面。工作台按钮和进度条位于 `renderer/replay-panel.ts`。
- `renderer/shell/` 内 timeline 管理分页、过滤、游标与过期请求；export 管理导出交互；workbench 管理会话、导航和组装。

## 类型约束与兼容

共享契约不依赖 Electron、文件系统和真实 DOM。采集事件和序列化节点采用判别联合；主进程事件生产者与 IPC 两端都使用具体类型。完整持久化事件、UI 预览和回放模型分开。

磁盘和 IPC 输入按 `unknown` 接收并验证。历史未知事件和任意 JSON payload 在存储和导出中仍保留，回放只解释支持的事件。大快照节点树原地校验，不复制整棵树；时间线解析与导出继续采用有界流式处理。

三套运行环境配置及契约检查全部开启 strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes。业务源码不使用 any、ts-ignore、ts-nocheck 或双重 unknown 类型断言。测试仍直接验证生成的 JS；类型负例使用 ts-expect-error，若类型约束被放宽则检查失败。

## 构建和验收

`npm run compile` 生成 `out/`，复制 HTML/CSS/SVG 和 Python；`npm start` 自动构建。`npm run verify` 执行类型、单元、真实桌面、回放、导出和大记录验收。Windows 原生便携版验收单独通过 `npm run test:portable` 执行。

验收日期：2026-11-01（America/Caracas），macOS arm64 / Node 22.20.0 / Electron 45.1.0。

- 迁移前基线 64 项；迁移后 78 项，资源竞态修复再增加 23 项，累计 101 项 Node 回归全部通过（0 失败、0 跳过）。新增覆盖采集启停、回放异步失效、表单控件、历史原始 payload、Worker 协议及跨页面资源归属。
- 主进程、preload、renderer 和契约负例四套 TS7 检查全部通过。
- 开发构建真实桌面 10 个流程全部通过，未捕获异常为空；包含单实例、表单/DOM、暂停恢复、HTTP/SPA/刷新、分页、full/delta 导出及重启。
- 离线回放原站已关闭，额外原站请求 0；5 个资源可用，1 个故意缺失资源正确报告；字体、背景、嵌套 CSS、动态图片、DOM 和控件通过。
- 约 415 MB 后台导出时暂停响应 11 ms；取消保留已有目标、清理临时文件并可继续录制。
- 默认大记录：1,110,716,444 字节、16 个超过 64 MiB 的快照。事实文件逐字节一致，16 个派生 HTML 哈希全部一致。导出约 21.5 秒、峰值 RSS 219,348,992 字节；Python 恢复约 349.5 秒、峰值 RSS 39,534,592 字节。合成数据及并行验收环境，仅用于本次正确性与有界内存验收。
- Windows x64 portable EXE 构建成功，ASAR 的入口、两个 preload、Worker、页面、恢复工具和设计资源均与当前 out 文件逐字节匹配；应用内没有 TS 编译器或源代码目录。
- 另外生成未签名 macOS 应用验证实际 ASAR 加载，打包应用的同一套 10 项桌面流程、离线回放及后台导出取消全部通过。

日志保存在 `output/ts7-validation/`；大记录详细报告为 `output/large-recording-2026-11-01T04-04-12-646Z/report-delta-deflate.json`。

上述本机验收在 macOS 上执行，不能验证 portable EXE 的 Windows 原生运行。Windows 打包成功与 ASAR 检查不代表 Windows 启动验收通过。

Windows 原生验收配置在 `.github/workflows/windows-verify.yml`：Windows runner 安装固定锁文件依赖，执行完整 verify、portable 构建及原生启动验收。每次 push、PR 或手动触发都会运行；无论成功或失败均上传轻量报告、截图和日志，全部通过后上传 portable EXE。远端验收以相应提交的 [Windows verification 运行结果](https://github.com/MixGeekers/echoo_web_replayer/actions/workflows/windows-verify.yml) 为准。

## 跨页面资源归属竞态修复

原有实现会将旧页面的迟到资源计入新会话，表现为离线回放多出一条演示页主题 CSS 的缺失记录。实际 CDP 追踪进一步确认：新主页面请求发起后、文档提交前，旧演示页的 iframe 仍可能导航到 srcdoc 并请求样式；单纯把资源归属的赋值提前到请求开始仍不能解决这种情况。

`main/resources/capture.ts` 现在在 requestWillBeSent 冻结请求的页面和会话归属，并按 loaderId 识别文档。Page.frameAttached 和初始框架树记录子框架所属页面；主框架归属在文档提交时更新，因此旧 iframe 的后续导航不会继承新页面。重定向保留初始请求归属，已被替代的导航重定向不会清空新页面缓存。请求结束清理元数据，归属映射有容量上限；无法确定归属的响应不会被猜测为当前页面。

当前页面在录制前加载的资源仍会加入新录制；同一录制跨页面跳转时，其先前页面的资源仍合法保留。此次修复防止新记录混入旧页面资源，不重写历史录制。

- `test/resource-capture.test.cjs` 新增 23 项可重复的 CDP 事件序列回归，验证真实 SessionStore 的资源目录、成功/缺失计数和资源文件。覆盖迟到响应、失败响应、会话启停、重定向、异步响应体、iframe/srcdoc、主框架替换、归属淘汰和未知 loader；包含正常资源采集的对照测试。最初 15 项在修复前构建有 10 项失败，修复后全部通过。
- `npm run test:resource-navigation` 使用真实 Electron 和两个 HTTP 站点，验证 A 停录、跳转到 B 后开始新会话时没有旧 URL，B 的录制前资源保留；B 会话继续导航到 C 后保存两页的合法资源。索引 URL 和实际资源文件大小均核验。该脚本已加入 `npm run verify`，随 Windows CI 一起运行。
- 离线回放脚本改为精确断言缺失项只有测试站点的 missing.png，不再只检查缺失数量至少为一。
- 开发构建和更新后的 macOS ASAR 应用均通过完整桌面 10 项流程、离线回放和跨页面资源测试。两种构建的离线回放均为 saved=5、missing=1，缺失 URL 精确对应故意设置的 404；额外原站请求和渲染异常均为 0。跨页面测试的新会话 B 为 saved=2、missing=0，继续录制 C 后 saved=4、missing=0，目录中没有 A 页面 URL。
- 真实 Chromium 在导航时可能取消旧请求；测试报告用 closedBeforeRelease 区分此情况。强制迟到响应和异步响应体完成的时序由上述确定性回归覆盖。
- Windows portable 已包含本次修复并重新构建；macOS 与 Windows ASAR 各 37 个产物文件均与 out 逐字节相同。Windows 原生执行限制仍如上所述。

本轮验证日志保存在 `output/resource-race-validation/`。
