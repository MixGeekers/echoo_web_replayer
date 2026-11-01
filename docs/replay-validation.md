# 会话回放验收

验证日期：2026-10-31（America/Caracas）。环境：macOS、Node.js 22.20.0、Electron 45.1.0。本次未构建 Windows 便携版。

## 可重复检查

```sh
TRACEDOCK_PYTHON=python3 npm test
PYTHON=python3 npm run test:smoke
npm run test:replay
```

Windows 已安装 `python` 命令时，可直接运行对应 npm 脚本。

- 64 项单元与存储/导出/还原检查通过，包括快照定位、完整事件分页、固定截点、CSS 相对引用与导入、资源版本、路径限制、损坏资源拒绝、full/delta ZIP 资源恢复和截点之后资源排除。
- 原有桌面验收的 10 个流程通过：采集、单实例、真实表单/DOM、暂停恢复、HTTP/SPA/刷新、结束、超过 500 条的时间线分页、差分导出、完整导出、重新启动。
- 新的真实 Electron 回放验收通过：先访问本机 HTTP 测试网站，录制操作并保存资源，然后关闭 HTTP 服务再回放。5 个资源（两份 CSS、两张 SVG 和一份字体）正常加载；嵌套 CSS、背景图、字体和动态 `srcset` 图片得到验证。回放期间原网站新增请求数为 0。
- 测试网站另有一个故意返回 404 的图片。资源状态准确显示缺失 1 项，并列出 URL。页面脚本没有在回放中执行，未出现未捕获的渲染异常。
- 播放/暂停时钟、全部倍速选项、DOM 增量定位、输入值、节点新增、滚动、进度条端点、快速拖动后立即重新开始、返回浏览器均通过专项脚本验证。

## 交互与视觉检查

通过持久 Playwright 会话在真实桌面窗口中操作，补充检查了同源 iframe、开放 Shadow DOM、勾选状态、事件详情、鼠标拖动、前后 5 秒、快速切换会话、暂停恢复与原网站关闭后的历史会话重开。默认窗口和 1100×720 最小窗口均检查了画面与控件，没有发现控件遮挡、主界面横向溢出或文字截断导致不可用的问题。

从界面导出的实际 ZIP 使用包内 `restore.py` 离线恢复成功，5 个资产逐项校验 SHA-256 一致。专项脚本把报告和回放截图写入 `output/replay-smoke-<时间戳>/`；日志保存在本次工作区的 `output/replay-tests.log`、`output/existing-smoke.log`、`output/replay-smoke.log`。

这些结果来自受控网站和项目演示页。旧会话没有归档的外部资源无法补回；Canvas/WebGL、视频、跨域 iframe、CSSOM/构造样式表修改和 CSS 动画不属于完整还原范围。ZIP 尚无独立播放器和桌面导入入口。详见 README 的回放边界。
