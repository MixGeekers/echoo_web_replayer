# Echoo 设计资源

按用户要求复用本机 `I:\dev\echoo\echoo_erp` 的设计系统，当前资源于 2026-10-29 同步。

| 本地文件 | ERP 权威来源（相对仓库根目录） |
| --- | --- |
| `echoo-theme-tokens.css` | `modules/ui/src/features/design-system/client/theme-tokens.css` |
| `echootek-logo.svg` | `modules/ui/src/features/design-system/client/assets/brand/echootek/logo-black.svg` |

两个文件保留原始内容。主题变量供工作台、演示页、演示页 iframe 与 Shadow DOM 使用；使用默认浅色主题，字标保留原始宽高比。宿主与演示页分别在各自样式中映射语义 token。字体栈由 token 提供，未附带或远程加载字体文件。

此目录随应用独立打包，无需在运行时访问 ERP 路径。后续同步时从权威源复制，并检查视觉、可读性与原有三栏布局；工作台尺寸和浏览器位置由自身布局变量控制。
