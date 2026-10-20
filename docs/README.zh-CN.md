# Pi Web

[English](../README.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

> **本仓库是 [上游 Pi Web](https://github.com/agegr/pi-web) 的 fork**（基线 `0.12.2` / commit `df163cd`），在上面加了：
> **按对话切换的多个人设**（模型选择器旁边）、**全局规则**、**远程访问**（局域网/Tailscale 地址、一次性扫码登录、Cloudflare 公网隧道）、
> 可选的**顾问**审查模型，以及两种**回退**（整轮 / 只删最后一条回复）。
> 我们改了什么、动了哪些上游文件、上游发新版时怎么合并：**[docs/FORK-NOTES.md](./FORK-NOTES.md)**。

[pi 编程智能体](https://github.com/earendil-works/pi)的本地浏览器界面。Pi Web 与 pi 共用本机配置和会话文件，可在浏览器中查找和继续对话、运行智能体、配置模型与资源，并查看项目文件。

**[在线体验演示 →](https://agegr.github.io/pi-web/)**：真实的 Pi Web 界面直接在浏览器里运行，带有示例会话、文件和模型。无需安装；回复都是预设内容，不会调用任何模型。

中文微信群：请查看 [GitHub Discussions 帖子](https://github.com/agegr/pi-web/discussions/271)。

![Pi Web 展示包含结构化 Markdown、工具调用和项目导航的 pi 会话](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

## 功能

- **会话工作区**：按项目查找、继续、重命名、导出和删除对话，并查看运行状态、上下文占用、花费和压缩信息。
- **两种分支方式**：**新会话**会从较早的消息创建独立会话文件；**从此处编辑**会在当前会话内创建分支。
- **项目文件工具**：浏览和上传文件、查看 Git Diff，并预览源码、Markdown、图片、音频、PDF 和 DOCX；文件变化后会自动刷新。
- **Git worktree**：从侧边栏切换 checkout，同时把同一仓库不同 worktree 的会话归在一起。
- **网页配置**：无需离开 Pi Web，即可管理 Provider 登录和 API Key、模型、模型测试、插件包及技能。
- **英文、简体中文和繁体中文界面**：Pi Web 首次打开时跟随浏览器语言，也可从顶部栏切换语言。

## 快速开始

Pi Web 要求 Node.js 22.19.0 或更高版本。先用 `node --version` 检查版本，然后运行：

```bash
git clone https://github.com/gthubtom1/pi-web.git
cd pi-web
npm install
npm run deploy
pi-web
```

> **本项目是独立仓库**：npm 上没有它的包。`npx @agegr/pi-web` / `npm install -g @agegr/pi-web`
> 装的是**上游作者的项目**，不是这个。完整安装/更新/卸载流程见 [INSTALL.md](INSTALL.md)。

服务就绪后，命令行会尝试自动打开浏览器。如果没有打开，请访问 [http://127.0.0.1:30141](http://127.0.0.1:30141)。Pi Web 默认监听 `0.0.0.0`，因此同一局域网内的手机或其他设备也能访问（服务就绪后控制台会打印局域网地址，如 `http://192.168.1.20:30141`）。只想本机访问请加 `--hostname 127.0.0.1`。

如果尚未配置模型 Provider，请打开**模型（Models）**面板登录或添加 API Key。

如需全局安装 `pi-web` 命令：

```bash
npm run deploy   # 在克隆目录里，构建并装成全局命令
pi-web
```

命令：

```bash
pi-web version          # 打印已安装的版本
pi-web status           # 列出正在运行的服务
pi-web stop [--port N]  # 停止正在运行的服务
pi-web open [--port N]  # 在浏览器中打开正在运行的服务
pi-web update [--check] # 更新全局 npm 安装
```

更新时先运行 `pi-web stop`，再运行 `pi-web update`（也可以再次执行同一条安装命令）。卸载时运行 `npm uninstall -g @agegr/pi-web`。

## 配置

端口和主机名以命令行参数为准，优先于对应的环境变量。`--no-open` 与 `PI_WEB_NO_OPEN=1` 中任意一个都会关闭自动打开浏览器。运行 `pi-web --help`（或 `-h`）可打印启动选项并以退出码 0 结束，不会启动服务；未知参数会报错并以退出码 1 结束。

| 参数或环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `--help`、`-h` | 打印启动选项并退出 | — |
| `--port <端口>`、`-p <端口>` 或 `PORT` | 服务端口 | `30141` |
| `--hostname <主机>`、`-H <主机>` 或 `PI_WEB_HOSTNAME` | 监听主机名 | `0.0.0.0`（局域网可访问；本机专用用 `127.0.0.1`） |
| `--no-open` 或 `PI_WEB_NO_OPEN=1` | 不自动打开浏览器 | 自动打开 |
| `PI_WEB_APP_NAME` | PWA manifest 的 `name` 和 `short_name`；去除首尾空白，空值使用默认值 | `Pi Web` |
| `PI_WEB_ALLOWED_HOSTS` | 额外允许的代理或自定义主机名，多个值用逗号分隔，必须精确匹配 | 未设置 |
| `PI_WEB_PASSWORD` | **其他设备**的密码（本机永远不问）；API 客户端可用用户名 `pi` 的 Basic Auth。空值 = 远程也不要密码（POSIX；Windows 用设置里的开关） | 首次启动生成强随机密码，启动时打印，保存在 `~/.pi/agent/pi-web-secret` |

在启动服务前设置 `PI_WEB_APP_NAME`，例如 `PI_WEB_APP_NAME='工作 Pi' pi-web`。修改后重启服务即可提供新的 manifest，无需重新构建。已安装 PWA 的名称更新由浏览器管理，不保证立即生效；此设置不改变页面标题或图标。

例如：

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### 远程访问

**本机什么都不用。** Pi Web 绑定 `0.0.0.0` 是为了让手机能连进来，但本机浏览器（`http://127.0.0.1:30141`
或 `localhost`）永远直接放行；CLI 打开的就是这个地址——`http://0.0.0.0:30141` 不是能打开的地址
（浏览器拒绝，走代理会返回 502）。

**其他设备只需配对一次，用一串短码。** 设置 › 远程访问 里是两扇独立的门，上下排列，各有自己的配对码和开关：

- **局域网** —— 同一个 Wi-Fi 下的手机，这串码只在这个网络有效；
- **Tailscale** —— 电脑和手机各装一次、登同一个账号，这条地址在任何网络都能用、且永远不变；
- **公网隧道** —— 纯出站的 Cloudflare 快速隧道（`https://<随机名>.trycloudflare.com`），
  任何网络、不装 App 都能访问。**建议保持开启**，它是互联网和"能执行命令的智能体"之间唯一的一道门。

每扇门都显示一个 8 位配对码（在手机上输入）和一个二维码。**二维码把高熵 secret 放在 URL 的 `#` 片段里**，
扫码即登录、不用输入；片断不会发到服务器、不进日志、不进 Referer。配对码可以换随机、也可以自己设
（6-12 位字母或数字），三扇门都能单独关闭（只在完全可信的网络里关）。「测一下」会让服务器经 Cloudflare
绕一圈访问公网地址，打不开时能直接指出是哪一步。

`PI_WEB_PASSWORD` 仍可作为运维覆盖：设了它，远程浏览器还要再输这个密码（API 客户端可用用户名 `pi`
的 Basic Auth）。密码认证不加密连接——隧道是 HTTPS，局域网地址是明文 HTTP——所以不要用明文 HTTP
把 Pi Web 暴露到互联网。

### HTTP 代理

服务端的模型和 API 请求会读取标准的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 环境变量。

macOS 或 Linux：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
pi-web
```

Windows PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
pi-web
```

## 注意事项

- **智能体数据**：Pi Web 默认读取 `~/.pi/agent` 下的 pi 数据，包括 `sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl` 中的会话文件。可通过 `PI_CODING_AGENT_DIR` 指定其他 pi agent 目录。
- **文件系统访问**：Pi Web 必须能读取智能体数据目录及会话记录中的工作目录。与现有 pi 会话共用数据时，请让 Pi Web 运行在与 pi 相同的文件系统环境中。
- **共享配置**：模型面板使用 pi 的模型、设置和凭据存储，因此两种界面都能看到相关更改。
- **文件访问边界**：文件浏览器仅能访问在 Pi Web 中选择过的工作目录，以及它已识别的项目或会话根目录；它不是通用的文件系统浏览器。
- **Git worktree**：切换器何时显示、如何创建 worktree，以及删除会产生什么影响，见 [Pi Web 里的 Worktree](./worktrees.zh-CN.md)。

## 开发

```bash
npm install
npm run dev
```

开发服务器运行在 [http://127.0.0.1:30141](http://127.0.0.1:30141)。常用检查命令：

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

日常开发时不要运行 `next build` 或 `npm run build`。它们会写入 `.next/`，可能干扰开发服务器；仅在发布流程中执行构建。

开始做新功能之前，请先阅读[参与贡献](./CONTRIBUTING.zh-CN.md)，了解哪些改动在范围内以及提交 PR 前的检查项。

贡献者文档：[国际化](./i18n.md)和[发布流程](./release.md)。

## 仓库结构

```text
app/             Next.js 界面和 API 路由
components/      React 界面组件
hooks/           客户端状态和交互 hooks
lib/             会话、智能体、模型、文件、Git 和安全逻辑
public/          静态资源和 PWA 文件
bin/             npm CLI 入口及启动参数解析
docs/            面向用户和贡献者的专题文档
demo/            发布到 GitHub Pages 的静态演示站（见 demo/README.md）
```

架构说明和详细文件地图见 [AGENTS.md](../AGENTS.md)。

## 许可证

[MIT](../LICENSE)
