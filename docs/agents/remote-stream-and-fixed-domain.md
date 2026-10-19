# 待办：远程三条（实时流 / 保活 / 固定域名）

> 状态：**诊断已完成、方案已定、代码未写**。下一个会话从这里开始，读完直接做。
> 用户已提供（不进仓库）：Cloudflare **命名隧道 token**；固定主机名 **`pi.downloading.ccwu.cc`**（CNAME 已建好 → `0c792aa4-….cfargotunnel.com`）。

## 已完成、已验证的结论（别再重测）

1. **服务器与隧道都没有问题**：同一个公网隧道，**桌面浏览器**里打开应用发消息，能看到「正在等待模型…」+ 停止按钮；纯 Node 的 SSE 探针挂隧道，**浏览器**能实时逐条收到。
2. **curl / node fetch 走隧道取 SSE 是 0 字节** —— Cloudflare 只对非浏览器客户端缓冲 chunked 响应。**这是假线索**，不要据此改代码。
3. **手机走公网隧道时收不到事件流**（页面能开、能发消息、电脑在跑，手机直到回合结束才出现整段结果）。局域网同一手机**很快** → 卡点在"隧道/运营商 → 手机"这段长连接。
4. 已修：发送不再等事件流（`connectEventsForSend`，超时也照发）；`next.config.ts` 关掉 `compress`（gzip 会攒小 chunk）。
5. DSH 那两个插件的实时通道是 **WebSocket**（`ws://host/api/events.mux`），AercherC 的 gateway 专门转发 upgrade —— 这是它们"手机零延迟"的原因；我们目前是 SSE。

## A. 手机实时（三件，按顺序）

1. **WebSocket 通道**：Next 的 route handler 不支持 upgrade，所以要在启动层做：
   - `bin/pi-web.js` 不再 spawn `next start`，改为 spawn 一个自建 node server（`bin/pi-web-server.js`）：普通请求转给 Next 的 request handler（`next({ dev:false })`），`/api/agent/:id/ws` 的 `upgrade` 自己处理。
   - WS 侧：校验 session cookie / 配对（复用 `lib/web-auth` + `lib/remote-pairing`，**Host 决定 scope**），然后**在进程内以 127.0.0.1 开一路现有 SSE** `GET /api/agent/:id/events`，把每条 `data:` 转成一帧 WS 文本推给客户端；客户端断开就 abort 那路 SSE。
   - 前端：`lib/agent-event-connection.ts` 增加 WS 模式（优先 WS，失败退回 SSE）。**不要新加 pi-web 专属的扩展字段/选项**（见 AGENTS.md 的兼容原则）。
2. **SSE 保留**：本机与支持它的网络继续用；WS 只是更好的通道。
3. **轮询兜底**：3~5s 无事件 → 每 1.5s 拉 `/api/sessions/:id/context` 渲染增长中的对话；恢复后回到推送。
4. **设置开关**：`realtime` ∈ `auto | ws | poll`，写在 `settings.json` 或 agent dir 的小文件里；默认 `auto`。

## B. 隧道保活 / 自启 / 当前地址

- `lib/tunnel.ts`：cloudflared 退出时**指数退避自动重启**（保留当前状态与 URL，重连后更新 host 白名单）；进程关闭时清理。
- 自启开关（默认关）：`pi-web` 启动后自动拉起隧道；状态写进 run record。
- 面板：**当前地址 + 复制按钮**（提醒用户"只复制面板里的地址，别用浏览器历史"）。

## C. 固定域名（命名隧道）——**两个输入框 + 显式保存，禁止写死**

- 存储：`~/.pi/agent/pi-web-tunnel.json`（0600）：`{ mode: "quick" | "named", token, hostname, autoStart }`。**token 不进代码、不进 git、不进日志**。
- 启动：`cloudflared tunnel run --token <token>`（**不是** `service install`）；**主机名从配置读**，运行时注册进 `lib/dynamic-hosts.ts` 白名单（只信这一个域名，不做通配）。
- UI（设置 › 远程访问 › 固定域名）：
  - token 输入框（打码）+ 主机名输入框，**都是草稿**；
  - **保存按钮 + 二次确认**（"替换凭据/公网地址会变，旧的立即失效"），另有"清空"；
  - 误触不改任何状态；换域名 = 改主机名后保存，再在 Cloudflare 把新域名 Add route 到 `http://127.0.0.1:30141`；
  - 状态显示、启动/停止、自动重启开关。
- 与快速隧道**二选一**（mode 字段），互不干扰。

## 验收清单（做完逐条过）

1. 手机打开 `https://pi.downloading.ccwu.cc` → 输 8 位配对码/扫码 → 进应用；**发消息时手机上实时出现思考、工具调用、逐段输出**。
2. 关掉浏览器 → 再次打开同一地址（cookie 30 天）→ 直接进，不用扫码。
3. 电脑休眠唤醒 / cloudflared 被杀 → 隧道自动恢复，地址不变（命名隧道）。
4. 设置里改主机名 → 保存需确认 → 旧地址失效、新地址生效；代码中搜不到任何域名/token 字面量。
5. `tsc` / `lint` / 相关测试全过；`npm run deploy` 后由全局 `pi-web` 验证。
