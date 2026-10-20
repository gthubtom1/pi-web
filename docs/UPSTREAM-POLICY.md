# 长期维护：跟 pi 走，把上游 pi-web 当参考

> 一句话：**pi 是我们要跟的上游；`agegr/pi-web` 只是参考读物。** 版本钉死，升级是一次有闸门的独立任务。
>
> 这不是"今天做完就不动了"的项目。真正会推动我们改动的只有两件事：**pi 变了**，以及**我们自己的需求变了**。

---

## 1. 三个角色，别搞混

| 角色 | 是什么 | 我们和它的关系 | 处理方式 |
| --- | --- | --- | --- |
| **pi**（`@earendil-works/pi-*`，7 个包） | Agent 内核、扩展 API、工具命名、会话文件格式、默认值 | **上游**：我们是为它做的 Web 界面 | 定期看版本，整包升级，按 §3 验证 |
| **本仓库**（`gthubtom1/pi-web`） | 这个独立项目 | 唯一事实源 | 安装/更新/回滚都走它（`docs/INSTALL.md`） |
| **`agegr/pi-web`** | 二开的来源 | **参考**：别人怎么适配 pi、怎么修 bug | 读提交、读 diff，**不盲目合并、不从它安装** |

**为什么上游 pi-web 不再是权威**：我们的功能树（三扇门远程访问、人设注入、顾问、回退、自建 server + WebSocket、
单/双语、卡片式面板……）已经和它分叉；它更新多数是在跟同一个 pi。它的价值是"同一个问题别人怎么解"，
不是"必须同步它的代码"。

**已知错位**：本机 CLI 跑 pi 1.3.0，本项目 SDK 也已升到 1.3.0。以后若 CLI 又升而我们没升，
症状通常是"CLI 有、网页没有"——先看版本，再看 `docs/UPSTREAM-POLICY.md` 的验收项。

## 2. 什么时候检查（检测）

每月一次，或在这些时机立刻查：

- `pi --version` 变了（CLI 升级）；
- 出现"CLI 有 / 网页没有"或相反的行为差异；
- 想用只在新版 pi 才有的能力；
- 参考仓库里有我们正踩的 bug 的修法（读它的提交，不合并）。

一条只读命令看全貌：

```bash
node scripts/upstream-check.mjs          # 人看
node scripts/upstream-check.mjs --json   # 脚本看
node scripts/upstream-check.mjs --no-network
```

它报告：我们钉的 7 个 pi 包 vs npm 最新、参考仓库自基线以来的提交、**我们和它都改过的文件**（真冲突面）。

## 3. 值不值得升（分类闸门）

| 类别 | 判断依据 | 动作 |
| --- | --- | --- |
| **必须做** | pi 的安全修复 / 我们正踩的 bug 被修 / 我们要的功能只在它里面 | 排期，一次只升这一层 |
| **建议做** | 小版本内的行为修正 | 正常排期 |
| **可做** | 底层依赖、文档 | 合并批次 |
| **不做** | 大版本、扩展 API 破坏性变更、与 pi 冲突 | 记录原因，等需求 |

pi SDK 三条硬规则：

1. **7 个包一起升**（它们互相 `^` 引用；`lib/pi-packages.test.mjs` 会抓混搭）。
2. **`--save-exact`**，不留 `^`。
3. 升级后必须确认：会话文件（v3）仍可读、扩展 API 仍可用、MCP 工具命名与归属未变。

**升级前先做一次"零成本"风险预判**：本机 `~/.pi/agent/install/releases/<ver>` 里通常已经装着新 pi，
把它与 `node_modules/@earendil-works/*` 的入口 `.d.ts` 做导出符号对比——**只增不删 = 低风险**。
（1.2.0 → 1.3.0 的实测结果：7 个包无任何删除项，唯一新增 `formatReadLineRange`；行为差异只有一条：
`enabledModels` 里同名裸 id 从"选一个"变成"每个 provider 都算"，已记录在 `docs/agents/models.md`。）

## 4. 怎么做（本地化 + 验证闸门）

```bash
# 0) 固定"本来就失败"的集合
git worktree add ../baseline HEAD
(cd ../baseline && npm test 2>&1 | tee /tmp/before.log | tail -3)

git switch -c upgrade/pi-<version>

# 1) 七个包一起升
npm install --save-exact \
  @earendil-works/pi-agent-core@X.Y.Z @earendil-works/pi-ai@X.Y.Z \
  @earendil-works/pi-codemode@X.Y.Z @earendil-works/pi-coding-agent@X.Y.Z \
  @earendil-works/pi-mcp@X.Y.Z @earendil-works/pi-telemetry@X.Y.Z \
  @earendil-works/pi-tui@X.Y.Z

# 2) 静态档
node_modules/.bin/tsc --noEmit && npm run lint

# 3) 测试：比"失败集合"，不是比数量
npm test 2>&1 | tee /tmp/after.log | tail -3
grep '^✖' /tmp/before.log | sed 's/ ([0-9.]*ms)//' | sort -u > /tmp/b.txt
grep '^✖' /tmp/after.log  | sed 's/ ([0-9.]*ms)//' | sort -u > /tmp/a.txt
comm -13 /tmp/b.txt /tmp/a.txt     # 必须为空：出现新失败 = 回归，停下来查

# 4) 构建 + 安装（内存不够就加大堆）
PI_WEB_BUILD_HEAP_MB=14336 npm run deploy

# 5) 运行时验收（§5），然后提交、打标签
```

**回滚**：升级在独立分支上做；回滚 = `git switch main && npm install -g .`（全局命令是副本，重装一次即可）。

## 5. 任何升级/合并后必须过的运行时验收（10 分钟）

1. `pi-web` 起得来：`✓ Ready` + 自建 server 那行（`live events on /api/agent/:id/ws`）。
2. 本机免密：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:30141/api/sessions` → `200`。
3. 三扇门：`GET /api/remote` 有 `lan` / `tailscale` / `public`；面板三张卡都在、各有码和二维码。
4. 实时通道：浏览器里 `new WebSocket(wss://<host>/api/agent/<id>/ws)` 收到 `{"type":"connected"}`；
   **发一条消息能看到逐段输出**（SDK 升级最容易坏的地方）。
5. MCP：`get_commands` 里 `/mcp` 的 `sourceInfo.path` 是 `builtin:mcp`；一条 Read-only 会话里 MCP 工具仍被拦（ADR 0006）。
6. 会话兼容：打开一个老会话不报错；导出一次 HTML。
7. 设置面板 8 个 tab 都能切，控制台 0 报错。
8. 隧道：`tunnel-start` → `running` → 公网 URL 打开应用；`tunnel-stop` → 旧地址变 Cloudflare 530。

任何一条不过 ⇒ 回滚，把现象写进 `docs/agents/` 对应笔记，别在分支上硬修。

## 6. 什么时候去看参考仓库（而不是合并它）

只在三种情况下读 `agegr/pi-web` 的提交：

1. **pi 大版本升级后**，想知道别人踩了哪些坑（读它的 diff，对照我们的验证清单）；
2. 我们遇到一个**上游也在修的 bug**（读它的修法，自己实现，别整块合并）；
3. 想知道**新特性**长什么样（参考交互，不照抄代码）。

读完的结论写进 `docs/agents/` 对应笔记（为什么这么做/为什么不跟），**不要**留成"下次还得再读一遍"的隐知识。

## 7. 定档还是跟随（结论）

- **不定死**：pi 会一直变，停在原地就等于慢慢坏掉。
- **不自动跟随**：没有 CI 替我们合并；每次都是一个人按 §2–§5 走一遍。
- **当前状态**：pi SDK **1.3.0**（7 包一致），本仓库 **0.13.0**，参考仓库基线 `df163cd`、无新提交。
- **下一次要做的**：每月跑一次 `node scripts/upstream-check.mjs`；pi 出 1.4 时按本文档走一遍。
