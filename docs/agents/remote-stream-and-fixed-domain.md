# 远程三条：实时流 / 保活 / 固定域名

> 状态：**A1–A5、B1–B3、C1–C4 全部实现并本机验证完毕**。手机实测只剩两件事卡在仓库之外：
> ① Cloudflare 那边的 DNS 记录类型（见文末「实测结果」）；② 手机端打开确认实时。
> 设计说明已并入 [`remote-access.md`](remote-access.md) 与 [`sessions.md`](sessions.md)，本文件是**验收清单 + 结论**。

## 已确认过的结论（别再重测）

1. 同一个公网隧道，**桌面浏览器**里发消息能看到「正在等待模型…」+ 停止按钮；纯 Node 的 SSE 探针挂隧道，浏览器能实时逐条收到。
2. curl / node fetch 走隧道取 SSE 是 0 字节 —— Cloudflare 只对非浏览器客户端缓冲 chunked 响应。**假线索**，不要据此改代码。
3. 手机走公网隧道收不到事件流（页面能开、能发消息，直到回合结束才出现整段结果）；局域网同一手机很快 → 卡点在长连接。
4. 已修：发送不再等事件流（`connectEventsForSend`）；`next.config.ts` 关掉 `compress`。

## 实施结果（勾选式）

- [x] **C1** `lib/tunnel.ts`：`mode: "quick" | "named"`；命名隧道跑
      `cloudflared tunnel --no-autoupdate run`，**token 走 `TUNNEL_TOKEN` 环境变量**（不上命令行，
      不进 `ps`、不进日志）；主机名从配置读，运行时只把这一个域名加进 `lib/dynamic-hosts.ts` 白名单
- [x] **C2** `~/.pi/agent/pi-web-tunnel.json`（0600，`{ version, mode, token, hostname, autoStart }`）
      读写：`lib/tunnel-config.ts`（落盘）+ `lib/tunnel-config-view.ts`（纯校验，客户端可 import）。
      token 不落日志、不回前端（只回 `hasToken`）；文件损坏/无凭据一律退回 `quick`
- [x] **C3** `/api/remote`：`tunnel-config-save` / `tunnel-config-clear` / `tunnel-autostart` 三个动作；
      会替换凭据或改动在线隧道公网地址的写入**必须 `confirm: true`**，否则 `409 { needsConfirm }`；
      `GET` 只回 `tunnelConfig.hasToken`；保存后在线隧道按新模式重启，旧域名立即从白名单移除
- [x] **C4** 设置 › 远程访问 ›「公网隧道（Cloudflare）」：当前地址 + 复制 + 「别用浏览器历史」提示；
      快速隧道 / 固定域名二选一；token（`type=password`，留空=不改）+ 域名 + 保存（二次确认）/ 清空（二次确认）；
      启停/测一下/卸载；「随 pi-web 自启」开关。三语文案已补齐（`lib/i18n/registry.test.mjs` 键集合校验通过）
- [x] **B1** 隧道保活：**曾经跑起来**的 tunnel 退出后按指数退避重启（1s 起翻倍，封顶 30s，
      `restarts` 计数），地址与白名单随之恢复；从未成功的失败留在 `error` 不空转；
      `stopTunnel()` 清「想让它跑」的意图，`installTunnelShutdownHook()` 随进程退出杀掉子进程
- [x] **B2** 自启开关（默认关）：`instrumentation-node.ts` 在服务进程启动时按配置拉起（端口来自
      `PI_WEB_PORT`，由 `bin/pi-web.js` 传入）；开了自启但没凭据 → 面板报错，不每次开机空撞
- [x] **B3** 面板显示「当前地址 + 复制」与历史地址提醒（见 C4）
- [x] **A1** `bin/pi-web-server.js`：自建 HTTP server —— 普通请求交给 Next（`next({ dev: false })`），
      `/api/agent/:id/ws` 的 `upgrade` 自己处理；`bin/pi-web.js` 改为拉起它（不再是 `next start`）；
      `package.json` 的 `files` 增加 `lib/ws-protocol.cjs`（启动脚本唯一需要的运行时文件）
- [x] **A2** WS 鉴权不走第二套逻辑：用浏览器带来的 `Cookie` + **原始 `Host`** 以 127.0.0.1 打一发
      `GET /api/sessions`，由 `proxy.ts` 自己判定（本机放行 / `PI_WEB_PASSWORD` / 配对码 scope /
      隧道域名白名单全不变）；随后在进程内开一路现有 `GET /api/agent/:id/events`，每条 `data:` 转一帧，
      客户端断开即 abort 那路 SSE；额外拒绝非同源 `Origin`（和 API 请求一致的 CSRF 立场）
- [x] **A3** `lib/agent-event-transport.ts`：`createAgentEventSourceFactory()` —— `auto` 先 WS，
      失败一次即记住并退回 SSE；`ws` 只走 WS；`poll` 不开推送通道。`AgentEventConnection` 一行没改，
      **没有给扩展 API 加任何字段/选项**
- [x] **A4** 轮询兜底：`agentRunning` 且 5s（`poll` 模式 3s）没有事件 → 每 1.5s 重读会话把增长的对话渲染出来，
      每 3 拍问一次 `/api/agent/:id` 让回合能真正收尾；一有事件立刻停止轮询
- [x] **A5** `realtime: auto | ws | poll`（默认 `auto`），`<agentDir>/pi-web-realtime.json`，
      `GET/PUT /api/realtime`，设置在**设置 › 常规 › 实时连接**（下次连接/刷新生效，界面已写明）
- [x] **V1** `tsc --noEmit` / `npm run lint` 全过；新增 4 个测试文件共 24 例全过；
      `npm run deploy`（build 236s + 全局安装）后按下面逐条验证

## 验收清单（本机可验的已验，剩下的需要手机）

1. ⏳ **手机打开 `https://pi.downloading.ccwu.cc` → 配对 → 发消息实时** — 需要你在手机上做。
   服务端已验：手机那一侧要走的每一步都在本机用隧道域名复现过（见「实测结果」）。
2. ✅ **关掉浏览器再开同一地址不用扫码** — 会话 cookie 是 `httpOnly` + `SameSite=Lax` +
   `maxAge` 30 天（`PI_WEB_SESSION_MAX_AGE`），配对成功一次即复用。
3. ✅ **cloudflared 被杀 → 自动恢复、地址不变** — 见「实测结果」第 3 条。
4. ✅ **改主机名要先确认、旧地址失效新地址生效、代码里没有域名/token 字面量** — 见第 4 条。
5. ✅ **`tsc` / `lint` / 测试 / `npm run deploy` 后由全局 `pi-web` 验证** — 见下。

## 实测结果（本机，2026-10-20）

| 项 | 结果 |
| --- | --- |
| 全局 `pi-web` 启动 | `▲ Next.js (custom server: live events on /api/agent/:id/ws)` + `✓ Ready in 1.0s`；`/`、`/api/remote`、`/api/realtime` 均 200 |
| 命名隧道启动 | `cloudflared tunnel run` 收到 `Registered tunnel connection` → `status: running`，`url: https://<固定域名>`，无 token 出现在命令行/日志 |
| 开机自启（B2） | 重启 `pi-web` 后无人点按，隧道按 `mode: named` 自己起来，地址不变 |
| 保活（B1） | `taskkill /F` 掉 cloudflared → 1s 内自动重连，`status` 仍 running、`url` 不变、`restarts: 1` |
| WS 握手（本机 loopback） | `101 Switching Protocols`，首帧 `{"type":"connected",…}` |
| WS 鉴权 | 未知 `Host` → `401`；隧道域名但无 cookie → `401`；配对拿到 cookie + 隧道 `Host` → `101` + 首帧；跨站 `Origin` → `403` |
| 浏览器内 WebSocket | 真实 Chromium 页面里 `new WebSocket(wss://…/api/agent/<id>/ws)` 收到 `connected` 帧 |
| 保存需确认（C3） | 无 `confirm` 的保存 → `409 {"needsConfirm":true}`；带 `confirm` → 隧道按新域名重启 |
| 换域名（C4） | 改成 `pi2.example.com` 保存 → `url` 变新域名、新域名 `Host` 200、旧域名 `Host` **403**；改回后恢复 |
| 面板（C4/B3） | 截图确认：当前地址 + Copy + 历史警告、状态/启停/测一下/卸载、快速/固定二选一、token 打码框（空值 + 「已保存，留空不改」）、域名框、保存/清空、自启开关 |
| 设置 › 常规（A5） | 「实时连接」三档（自动 / 只用 WebSocket / 轮询）渲染正常，无控制台报错 |
| 代码里的域名/token 字面量 | `grep` 全仓库（排除 `node_modules`/`.next`）**零命中** |
| 旧测试回归 | 与本次改动相关的 `lib/tunnel*.test.mjs`、`lib/http-dispatcher`、`lib/i18n/*`、`components/SettingsPanel` 全过；仓库里另有 23 例**改动前就失败**的 Windows 环境问题（`fileURLToPath` 在 `D:\` 上抛 `ERR_INVALID_FILE_URL_PATH`、`hooks/*` 用例以裸路径加载 ESM），与本改动无关 |

### ⚠️ 还卡在仓库之外的一件事：Cloudflare 的 DNS 记录

`curl https://<固定域名>/api/web-auth` 返回的不是应用，而是 Cloudflare 自己的错误页：

```
<title>DNS points to prohibited IP | <固定域名> | Cloudflare</title>
```

= Cloudflare **error 1000**。连接器侧是健康的（`Registered tunnel connection`、本机 `Host: <固定域名>`
访问应用 200），所以问题在**那条 DNS 记录本身**：该主机名指向了一个 Cloudflare 不许代理的地址
（最常见：把它建成了指向局域网 IP 的 **A 记录**，或建成了指向 Cloudflare 自己的 IP 的记录），
而不是命名隧道的 CNAME。

修法（Cloudflare 控制台，你来做）：

1. 打开该域名 → DNS，删掉 `pi.downloading.ccwu.cc` 下所有 **A / AAAA** 记录；
2. 新建 **CNAME**：名称 `pi`，目标 `<隧道 ID>.cfargotunnel.com`（就是建命名隧道时给的那个，也是 token
   里 `t` 字段的值），**代理状态必须是「已代理」**（橙色云）；
3. 同一条隧道的 Public hostname 必须是 `pi.downloading.ccwu.cc` → 服务 `http://127.0.0.1:30141`
   （端口要和 `pi-web` 实际监听端口一致）；
4. 回来点面板里的「测一下」：通了它会显示毫秒数。然后再用手机打开 → 输 8 位配对码 / 扫码。

DNS 改好后不需要重装、不需要重启，隧道和面板都是现成的。
