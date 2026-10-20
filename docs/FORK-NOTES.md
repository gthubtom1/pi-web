# 这个仓库是怎么来的：上游基线 + 我们的改动 + 升级流程

> 一句话：这是 [`agegr/pi-web`](https://github.com/agegr/pi-web) 的 **fork**，基线是
> **0.12.2 / commit `df163cd`**，在上面加了 5 组功能。本文件是给"人"和"以后的智能体"看的
> 对照表与升级手册：**我们改了什么、改了哪些上游文件、上游更新时怎么安全跟进**。

---

## 1. 基线（写死在这里，升级时先看这一节）

| 项 | 值 |
| --- | --- |
| 自己的仓库（`origin`） | `https://github.com/gthubtom1/pi-web.git`（GitHub 上的 fork，我们的提交在这里） |
| 上游仓库（`upstream`） | `https://github.com/agegr/pi-web.git`（原作者仓库） |
| 上游版本 | `@agegr/pi-web` **0.12.2** |
| 基线 commit | **`df163cd`** — `feat(models): match provider ids in the model and Add provider searches (#1308)` |
| 本仓库版本 | `package.json` 已改为 **0.13.0**（我们的第一个成品版本号） |
| pi SDK | `@earendil-works/*` **1.2.0**（与上游 0.12.2 完全一致的精确 pin，**不要随手升级**） |
| Node | `>= 22.19.0`（开发机实测 Node 24.20） |

**为什么 SDK 钉死 1.2.0**：pi-web 的 `package.json` 用 `--save-exact` 钉住 `@earendil-works/pi-*`
的每一个包；这些包互相用 `^` 引用，npm 安装时会重新解析。任何一个没钉住的包都可能让
`pi-coding-agent 1.2.0` 和 `pi-codemode 1.3.0` 这类组合出现（上游曾经踩过）。
`lib/pi-packages.test.mjs` 会检查这件事。**升级 SDK 是一个独立任务**，要整包一起升 + 全量回归，
不能顺手改。

---

## 2. 我们加了什么（按功能分组）

每组都对应一篇设计笔记，改动理由和坑都在 `docs/agents/` 里，不要只看代码。

### 2.1 人设（Persona）与规则
> 设计笔记：[`docs/agents/personas.md`](agents/personas.md)

- 多个人设卡（"破甲词"），**按对话选择**、可随时切换、可编辑/改名/复制/删除/设默认/选"无人设"。
- 存储：`<agentDir>/personas/<id>.md`（一人设一文件）+ `<agentDir>/personas.json`（只有元数据）。
- 规则（`RULES.md`）仍是**全局唯一**，与人设解耦。
- 注入：`cached`（写结构化 section，省钱、走 prompt cache）与 `every-turn`（每轮强制）两种模式，
  设置里可切；**与 pi 原生提示词插件（`PERSONALITY.md`）共存不打架**（只留一个身份）。
- 新增文件：`lib/personas.ts`、`lib/session-persona.ts`、`lib/persona-inject-settings.ts`、
  `lib/system-prompt-service.ts`、`app/api/personas/`、`app/api/system-prompts/`、
  `app/api/persona-inject/`、`components/SystemPromptsConfig.tsx`、`components/PersonaSelector.tsx`。
- 改的上游文件：`lib/rpc-manager.ts`（extensionFactories + startRpcSession 的 personaId）、
  `app/api/agent/new/route.ts`、`hooks/useAgentSession.ts`、`components/ChatInput.tsx`、
  `components/ChatWindow.tsx`、`components/SettingsPanel.tsx`、`lib/settings-navigation.ts`。

### 2.2 远程访问（手机 / 二维码 / 公网隧道）
> 设计笔记：[`docs/agents/remote-access.md`](agents/remote-access.md)

- 默认绑 `0.0.0.0`；**本机什么都不用**（`Host` 是 `127.0.0.1`/`localhost` 时直接放行，CLI 打开这个地址）。
- 其他设备用**短配对码**配对，**局域网和公网各一套**（各有开关，可随机、可自定义 6-12 位），
  QR 把高熵 secret 放在 URL `#` 片段里，扫码即登录；`PI_WEB_PASSWORD` 只是可选的运维覆盖。
- 设置 › **远程访问**（独立 Tab）：局域网 / Tailscale 地址、一次性扫码登录（2 分钟 token，
  二维码里不含密码）、Cloudflare quick tunnel（自动下载 cloudflared、自动探测本机代理、可卸载）、
  「登录需要密码」开关（Windows 关鉴权只能靠它，写 `<agentDir>/pi-web-auth.json`）。
- 新增文件：`lib/web-secret.ts`、`lib/pairing.ts`、`lib/tunnel.ts`、`lib/local-proxy.ts`、
  `lib/dynamic-hosts.ts`、`lib/remote-access.ts`、`lib/agent-dir.ts`、`app/api/remote/`、
  `app/api/web-auth/pair/`、`components/RemoteAccessSection.tsx`、`components/QrCode.tsx`。
- 改的上游文件：`lib/web-auth.ts`、`proxy.ts`、`app/api/web-auth/route.ts`、`app/login/page.tsx`、
  `lib/request-security.ts`（动态 host）、`bin/pi-web.js`（打印密码 + 局域网地址）、
  `bin/pi-web-options.js`（默认 host 0.0.0.0）。

### 2.3 顾问（Advisor）
> 设计笔记：[`docs/agents/advisor.md`](agents/advisor.md)

- 一个独立的"第二意见"模型，回合结束后审查本轮（错误假设、死胡同、漏需求、危险操作）；
  默认关；`off / manual / auto` 三档；可配顾问模型、打断严重度、自动阈值、意见条数上限。
- 设置位置：**常规 ›（末尾）顾问**（不是一个独立 Tab：它就是一个开关加一个模型）。
- 入口：`/advisor` 手动触发；意见以卡片形式进上下文，严重时以 follow-up 打断主对话（有递归抑制）。

### 2.4 回退（Rewind）与"只删这条回复"
> 设计笔记：[`docs/agents/advisor.md`](agents/advisor.md)（同一篇）+ `docs/REWIND-VS-SEEP-COMPAT.md`

- **整轮回退**：挂在用户消息上，物理截断会话文件（该消息及其之后全部删除），把原文填回输入框。
  该轮**含工具结果时会二次确认**；纯文本（纯拒绝）轮直接执行。
- **只删这条回复**：挂在最后一条无工具调用的 assistant 回复上，只删这一条，问题和之前的工具结果全留，
  并把问题填回输入框 —— 用来"重刷一次拒绝"。
- 截断前校验 `parentId` / `firstKeptEntryId` 不会悬空，否则拒绝并保持文件原样。
- 回填草稿会剥掉 Seep 工作台加在用户输入前的横幅（`lib/engineered-prompt.ts`）。
- 新增文件：`lib/session-rewind.ts`、`app/api/sessions/[id]/rewind/`、`lib/engineered-prompt.ts`。

### 2.6 远程实时通道 / 隧道保活 / 固定域名
> 设计笔记：[`docs/agents/remote-stream-and-fixed-domain.md`](agents/remote-stream-and-fixed-domain.md)、
> [`docs/agents/remote-access.md`](agents/remote-access.md)、[`docs/agents/sessions.md`](agents/sessions.md)

- **实时通道**：`/api/agent/<id>/ws` 的 WebSocket（手机过隧道时 SSE 会被缓冲到回合结束）；
  失败自动退回 SSE，另可选「轮询」。设置 › 常规 › 实时连接（`auto|ws|poll`，默认 auto）。
  推送静默 3~5 秒即自动改为 1.5 秒读一次会话，一有事件立刻停。
- **自建 server**：`bin/pi-web-server.js` 接管 Node 的 `upgrade`（Next route handler 做不到），
  其余请求原样交给 Next；鉴权完全复用 `proxy.ts`（把浏览器的 Cookie + 原始 `Host` 以 127.0.0.1 回放），
  桥接进程内 SSE 的每条 `data:`。`bin/pi-web.js` 不再 spawn `next start`。
- **隧道保活（B1/B2）**：`cloudflared` 意外退出按指数退避自动重连（1s→30s），地址/白名单随之恢复；
  「随 pi-web 自启」开关默认关，开则由 `instrumentation-node.ts` 启动时拉起。
- **固定域名（C1–C4，已按用户要求整块移除）**：曾经的 `<agentDir>/pi-web-tunnel.json`
  （`{mode,token,hostname,autoStart}`）+ `cloudflared tunnel run`（token 走 `TUNNEL_TOKEN`）、
  打码输入框与二次确认，全部删除。原因：那条路在 Cloudflare 侧的 Public Hostname 被配成
  `service: https://<同一个域名>`，请求自己套自己，边缘回 `error 1000`；而"地址长期不变"由 Tailscale 提供。
  现在该文件只剩 `{ version, autoStart }`；旧文件读出来只认 `autoStart`，下次写入把残留 token 清掉。
- 新增文件：`bin/pi-web-server.js`、`lib/ws-protocol.cjs`、`lib/agent-event-transport.ts`、
  `lib/tunnel-config.ts`、`lib/realtime-settings.ts`、
  `app/api/realtime/`；测试：`lib/ws-protocol.test.mjs`、`lib/agent-event-transport.test.mjs`、
  `lib/tunnel-config.test.mjs`、`lib/tunnel-named.test.mjs`、`lib/realtime-settings.test.mjs`。
- 改的上游文件：`bin/pi-web.js`（改成 spawn 自建 server，传 `PI_WEB_PORT`）、`lib/tunnel.ts`（模式/保活/
  自启）、`app/api/remote/route.ts`、`components/RemoteAccessSection.tsx`、`components/SettingsPanel.tsx`、
  `hooks/useAgentSession.ts`（传输工厂 + 静默轮询）、`instrumentation-node.ts`（自启 + 退出清理）、
  `lib/i18n/messages/*`（约 40 条新键）、`package.json`（`files` 增加 `lib/ws-protocol.cjs`）。

### 2.5 界面适配与主题
- 暖沙/赤陶配色（`app/globals.css` 的 `:root` / `html.dark`），输入框单层卡片（`.chat-input-shell`），
  卡片宽度等于对话列（`--chat-content-max-width`）并与消息列对齐（右侧让出 minimap 宽度）。
- 额外两套主题 **OpenCode（纯白）/ OpenCode 暗色**：纯白底 + 结构用颜色区分（琥珀标题、玉绿色行内代码、
  钴蓝链接、青色序号），暗色为紫罗兰标题 + 薄荷代码（取自 `anomalyco/opencode` 调色板）。
- 人格选择器在手机上收进「更多控件」，窄桌面自动退成图标（容器测量 + 滞回）。
- 两语文案（en / zh-CN；`zh-TW` 按用户要求移除，任何 `zh-*` 浏览器语言归到 `zh-CN`），键集合零差异。

---

## 3. 我们动了哪些上游文件（升级冲突就出在这里）

| 上游文件 | 我们加了什么 | 冲突风险 |
| --- | --- | --- |
| `lib/rpc-manager.ts` | `extensionFactories` 里加人格注入扩展；`startRpcSession({ personaId })`；`set_persona` / `run_advisor` 命令；advisor 钩子 | **高**（上游常改这个文件） |
| `app/api/agent/new/route.ts` | 解析并转交 `personaId`，回传 `personaId` | 中 |
| `hooks/useAgentSession.ts` | persona 三态 ref、`/advisor` 命令、`handlePersonaChange` | 中 |
| `components/ChatInput.tsx` | 人格选择器 + 窄行测量 + 草稿回填剥横幅 | 中 |
| `components/ChatWindow.tsx` | persona 列表/默认、purge 按钮条件、会话重载事件 | 中 |
| `components/MessageView.tsx` | 回退按钮、只删这条回复、advisor 卡片标题 | 中 |
| `components/SettingsPanel.tsx` | 远程访问 Tab、顾问嵌入常规、人格与规则 Tab | **高**（导航表） |
| `lib/settings-navigation.ts` | 新增 `remote`、`prompts` | 高（枚举） |
| `lib/i18n/messages/{en,zh-CN}.ts` | 约 100 条新键 | 中（按键合并） |
| `lib/web-auth.ts` / `proxy.ts` / `app/api/web-auth/route.ts` | 密码来源改为 `getWebPassword()`；放行 `/api/web-auth/pair` | 中（安全相关，改完必测） |
| `lib/request-security.ts` | 动态 host 白名单（隧道） | 中（安全相关） |
| `bin/pi-web.js` / `bin/pi-web-options.js` | 打印密码/局域网地址；默认 `0.0.0.0` | 中 |
| `bin/pi-web.js` | 不再 spawn `next start`，改为 spawn `bin/pi-web-server.js`（自建 server + WS upgrade） | **高**（上游改启动方式必冲突） |
| `lib/tunnel.ts` | 指数退避保活、autoStart；状态里加了 `restarts/restarting/autoStart`（命名隧道模式已移除） | 中 |
| `app/api/remote/route.ts` | `tunnel-config-save/clear`、`tunnel-autostart`，`GET` 带 `tunnelConfig`（只含 `hasToken`） | 中 |
| `components/RemoteAccessSection.tsx` | 三张卡片（局域网 / Tailscale / 公网）、当前地址 + 复制、自启开关 | 中 |
| `hooks/useAgentSession.ts` | 事件源工厂（WS→SSE→poll）+ 推送静默时的 1.5s 会话重读 | 中 |
| `instrumentation-node.ts` | 启动时按配置拉起隧道 + 退出时杀掉 cloudflared | 低 |
| `app/globals.css` | 配色 + 输入框卡片 | 高（上游常调样式） |
| `package.json` / `package-lock.json` | `qrcode-generator`、`0.0.0.0` 脚本、版本号 | 低 |
| `app/login/page.tsx` | `?pair=` 扫码登录 | 低 |
| `README.md` / `docs/README.{zh-CN,ja,ru}.md` | 默认密码/远程访问/0.0.0.0 说明 | 低（文档） |

---

## 4. 升级上游（给以后的智能体照着做）

> 检测与决策的完整流程（两个上游的分工、四道闸门、验收清单）在
> [`docs/UPSTREAM-POLICY.md`](UPSTREAM-POLICY.md)；先跑 `node scripts/upstream-check.mjs` 拿事实。

### 4.1 先判断"要不要升"

```bash
# 两个 remote 已经配好：origin = 我们的 fork，upstream = 原作者仓库。
git remote -v
git fetch upstream
git log --oneline HEAD..upstream/main | head -30      # 上游新提交
git diff --stat HEAD...upstream/main | tail -20      # 影响面
```

看三件事：
1. 上游是否**升级了 pi SDK**（`package.json` 里 `@earendil-works/*` 版本）。升了就必须整包一起升。
2. 是否动了第 3 节表里的文件（尤其 `lib/rpc-manager.ts`、`components/SettingsPanel.tsx`、
   `lib/settings-navigation.ts`、`lib/i18n/messages/*`）。
3. 是否有新 i18n 键（合并后要保证两种语言的键数一致）。

### 4.2 合并

```bash
git switch -c upgrade/upstream-<新版本>
git merge upstream/main            # 或 git rebase -i upstream/main
```

冲突处理原则：
- **上游的安全/生命周期逻辑优先**（`request-security.ts`、`web-auth.ts`、`rpc-manager.ts` 的
  session 生命周期），我们的功能钩子挂回去，别覆盖。
- `lib/rpc-manager.ts`：我们的 `extensionFactories` 条目（人格注入）必须在 `builtin:` 之后、
  `preferUserBashExtension(...)` 之前那一组里；`startRpcSession` 的 `personaId` 分支要重新接上。
- `components/SettingsPanel.tsx` / `settings-navigation.ts`：导航项顺序保持
  `general → remote → prompts → models → skills → agents → plugins → mcp`（顾问在常规里，不是导航）。
- `lib/i18n/messages/*`：三个文件**一起改**，键集合必须完全相同（`lib/i18n/registry.test.mjs` 会抓）。
- `app/globals.css`：保留我们的配色变量与 `.chat-input-shell`，吸收上游新增规则。

### 4.3 改完必须跑（本机 Windows 也一样）

```bash
node_modules/.bin/tsc --noEmit        # 必须 0 error
npm run lint                          # 必须 0 error / 0 warning
node --experimental-strip-types --test lib/engineered-prompt.test.mjs lib/system-prompt-service.test.mjs \
  lib/personas.test.mjs lib/session-persona.test.mjs lib/persona-inject-settings.test.mjs \
  lib/advisor-runner.test.mjs lib/advisor-settings.test.mjs lib/session-rewind.test.mjs \
  lib/web-secret.test.mjs lib/pairing.test.mjs lib/remote-access.test.mjs lib/local-proxy.test.mjs \
  lib/dynamic-hosts.test.mjs lib/tunnel.test.mjs lib/i18n/registry.test.mjs     # 必须全绿
npm run dev                           # 手工过一遍下面的清单
```

**本机部署 / 更新一条命令**：

```bash
npm run deploy        # scripts/deploy.mjs：构建 + 全局安装 pi-web
pi-web                # 启动（控制台打印局域网地址和登录密码）
```

`npm run deploy` 处理了这台机器上会让普通 `next build` 失败的两件事：

1. **堆内存**：`next build --webpack` 在 16 GB 机器上按 Node 默认堆（~4 GB）会
   `JavaScript heap out of memory`。脚本用 `--max-old-space-size=9216`（可用 `PI_WEB_BUILD_HEAP_MB` 覆盖）。
2. **字体**：`app/layout.tsx` 用 `next/font/google` 拉 `Noto Sans Mono`，国内直连 `fonts.googleapis.com`
   会被重置。脚本自动探测本机代理（环境变量 → 7897/7890/1080…）并设 `NODE_USE_ENV_PROXY=1`，
   让构建期 fetch 走代理（已实测：直连失败、走代理 200、构建通过）。

只想构建不安装：`npm run deploy -- --skip-install`。构建产物 `.next` 会让 `npm run dev` 的图缓存失效，
需要回到开发时删掉 `.next` 再 `npm run dev`。

> **已知的环境性失败**（本机 Windows + Node 24，**与我们改动无关**，干净基线上同样失败）：
> `hooks/{useAudio,useGroupDrag,useResizablePanel,useSessionUiState,useSidebarMotion,new-session-switch}.test.mjs`
> 是绝对路径 `import("D:\…")` 在 Windows 上不支持；另有 `lib/http-dispatcher`、
> `app/api/mcp/sign-in`、`components/FileViewer`、`components/SettingsUi`、`lib/codemode-settings`、
> `lib/mcp-host.integration`、`lib/builtin-extensions.integration` 等环境/网络相关项。
> 判断标准：**先在干净的上游 worktree 复跑一遍**，同样的失败就不算回归。

### 4.4 手工验收清单（每次升级都要过）

1. 新建对话 → 输入框旁出现人格选择器 → 选非默认人格 → `get_state.personaId` 是它 →
   发一句话 → 会话文件里 `system.sections.personality` 是你选的那张卡（且只有一个）。
2. 设置 › 人设与规则：新建/改名/复制/删除/设默认/取消默认/导入 `PERSONALITY.md`。
3. 设置 › 远程访问：局域网地址列出、生成二维码、扫码登录（或 `?pair=` 直接打开）、
   「登录需要密码」开关（关掉后不带 cookie 直接能进，再打开恢复 307）。
4. 隧道：启动 → 出现 `*.trycloudflare.com` → 卸载后 `pi-web-bin` 为空。
5. 设置 › 常规 › 顾问：改模式/模型/阈值，保存后有回显。
6. 回退：在纯拒绝的回合点回退（无确认）→ 草稿回来；在有工具结果的回合点回退（有确认）。
7. 「只删这条回复」：最后一条回复悬停 → 删除 → 只有它消失、问题回到输入框。
8. 手机视口（390px）：输入框控件不重叠，人格选择器在「更多控件」里。

---

## 5. 和上游的关系（发布/部署）

- 部署方式与上游完全一致：`npm run dev` / `npm start` / `npx`（本仓库未发布到 npm；
  发布需要把 `package.json` 的 `name` 改掉，否则会和 `@agegr/pi-web` 撞名）。
- 我们不维护自己的 npm 包，也不改上游的 `.next` 构建流程。
- `bin/pi-web.js` 的行为差异只有两处：默认 `0.0.0.0`、启动时打印登录密码与局域网地址。
