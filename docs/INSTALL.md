# 安装 / 更新 / 卸载（这个仓库的完整流程）

> 这个仓库是**独立项目**：npm 上没有它的包，任何 `npx @agegr/pi-web` / `npm i -g @agegr/pi-web`
> 装的都是**别人的项目**。只从你的 git 仓库装。
>
> 给智能体的一句话：**照本文件第 1 节执行即可**，不要引用上游 README 的安装方式。

- 仓库：`https://github.com/gthubtom1/pi-web`
- 上游 pi SDK：`@earendil-works/pi-*`（钉死版本，见 `package.json`）
- 基于：`agegr/pi-web`（只作参考，不作为安装/更新来源）

---

## 0. 前置条件

| 项 | 要求 | 检查 |
| --- | --- | --- |
| Node.js | **>= 22.19**（开发机实测 24.x） | `node -v` |
| npm | 随 Node 提供 | `npm -v` |
| git | 任意近期版本 | `git --version` |
| pi（CLI） | 建议已装，用于生成会话/模型配置 | `pi --version` |
| 网络 | 构建时 `next/font` 会访问 `fonts.googleapis.com`；国内需代理（`HTTPS_PROXY` 或本机梯子，脚本会自动探测） | — |

Windows 上**不要**用 `npx`，也不要装成别的名字：全局命令就叫 `pi-web`。

## 1. 安装（一条命令）

```bash
git clone https://github.com/gthubtom1/pi-web.git
cd pi-web
npm install
npm run deploy
```

`npm run deploy` 会：

1. `next build`（这台机器上需要大堆：构建脚本默认 9 GB，内存不足时用
   `PI_WEB_BUILD_HEAP_MB=14336 npm run deploy`）；
2. 把构建产物装成全局命令 `pi-web`；
3. 在 `~/.pi/agent/pi-web-source.json` 记下**这个克隆的位置**（`pi-web update` 要靠它）。

装完启动：

```bash
pi-web                 # 默认 http://127.0.0.1:30141，会自己开浏览器
pi-web --no-open       # 不想开浏览器
pi-web -p 3200         # 换端口
```

首次启动会生成登录用的密码/配对码，终端里会打印本机地址与局域网地址。
**本机 `127.0.0.1` 永远不需要配对码**；手机等其他设备用 设置 › 远程访问 里的三扇门（局域网 / Tailscale / 公网）。

## 2. 更新（跟自己的仓库走）

```bash
pi-web update            # 只读：fetch 后报告落后几个提交、并打印该执行的命令
pi-web update --check    # 连 fetch 都不做，只看本地记录
```

真正更新（在**克隆目录**里）：

```bash
pi-web stop                      # 服务在跑就先停：构建会替换 .next
git -C <你的克隆> pull --ff-only
npm -C <你的克隆> run deploy
```

> 为什么不是 `npm install -g …@latest`：那个包是上游作者的；跟着它更新等于把本项目换掉。

## 3. 卸载（不留垃圾）

```bash
pi-web stop
npm uninstall -g pi-web-fork        # 移除全局命令
```

用户数据（会话、配置、凭据）都在 `~/.pi/agent/`，**卸载不会删**。确认不需要了再手动清理：

| 路径 | 内容 |
| --- | --- |
| `~/.pi/agent/sessions/` | 所有会话记录 |
| `~/.pi/agent/settings.json`、`models.json`、`auth.json` | pi 的配置与凭据 |
| `~/.pi/agent/pi-web-remote-pairing.json` | 远程访问的三套配对码（敏感） |
| `~/.pi/agent/pi-web-tunnel.json` | 公网隧道自启开关 |
| `~/.pi/agent/pi-web-source.json` | 上次 deploy 记录的克隆位置 |
| `~/.pi/agent/pi-web-bin/` | 下载的 cloudflared（约 50 MB） |

## 4. 升级 pi SDK（跟上游 pi 走）

pi 更新后要不要跟、怎么验证，见 **[`UPSTREAM-POLICY.md`](UPSTREAM-POLICY.md)**。要点：
7 个 `@earendil-works/*` 包**一起**用 `--save-exact` 升，然后走 `tsc` / `lint` / 全量测试 /
`npm run deploy` / 10 分钟运行时验收。

## 5. 常见问题

| 现象 | 处理 |
| --- | --- |
| 构建 `FATAL ERROR: … heap out of memory` | `PI_WEB_BUILD_HEAP_MB=14336 npm run deploy` |
| 构建卡在 `next/font` | 配代理：`HTTPS_PROXY=http://127.0.0.1:7890 npm run deploy` |
| `pi-web: command not found` | 全局 bin 目录不在 `PATH`；或重新 `npm run deploy` |
| 手机上打不开公网地址 | 地址每次重启都会变：在 设置 › 远程访问 里复制**当前地址**，别用历史记录 |
| 想用固定地址 | 用 Tailscale（面板第二张卡），不要往 Cloudflare 命名隧道上折腾 |
| MCP 面板显示"被某扩展接管" | 有第三方扩展注册了 `/mcp`，pi 会丢掉内置的；跑一次 `python Tool/scripts/check-extension-conflicts.py`（若装了 Seep 工作台）或看 `docs/agents/mcp-runtime.md` |
