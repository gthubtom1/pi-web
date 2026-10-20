# 跟不跟上游走：两个上游、四道闸门、一次检查脚本

> 一句话：**不定档，也不自动跟随**。版本钉死（`--save-exact`），升级是一次**有闸门的独立任务**，
> 每次都先看"它改了什么 × 我们改了它哪些文件"，再决定做不做。

本项目同时被两条上游推着走，它们互相独立，判断方法也不同：

| 上游 | 是什么 | 现状 | 影响面 | 升级的代价 |
| --- | --- | --- | --- | --- |
| **pi SDK**（`@earendil-works/pi-*`，7 个包） | Agent 内核、扩展 API、工具命名、会话文件格式、默认值 | 我们**钉在 1.2.0**；npm 上已有 **1.3.0** | 几乎全部服务端行为 | **整包一起升** + 全量回归；不能只升一个 |
| **pi-web 上游**（`agegr/pi-web`） | 这个 fork 的来源仓库 | 基线 `0.12.2 / df163cd` | UI、路由、会话渲染 | 合并冲突（面见 `docs/FORK-NOTES.md` §3） |

**已知的版本错位（必须记住）**：本机 CLI 跑的是 **pi 1.3.0**，而 pi-web 自己捆的是 **SDK 1.2.0**。
这是允许的（两边各自加载自己的 SDK），但意味着：CLI 的新行为（例如 `replaceable` 名单、扩展 API）
不会自动出现在 Web 端；反过来，Web 端看到的工具/命令以它自己的 SDK 为准。
**排查"为什么 CLI 和网页表现不一样"时，先看这个错位。**

---

## 1. 什么时候检查（检测）

一个月一次，或者在这些时机立刻检查：

- pi CLI 升级后（`pi --version` 变了）；
- 出现"CLI 有、网页没有"或反之的行为差异；
- 想用某个只在新版才有的功能；
- 上游 pi-web 有了我们需要的修复。

一条命令看全貌（只读，不改任何东西）：

```bash
node scripts/upstream-check.mjs          # 人看
node scripts/upstream-check.mjs --json   # 脚本看
node scripts/upstream-check.mjs --no-network   # 没网/不想打 npm
```

它回答四件事：我们钉了哪些 pi 包、npm 上现在是什么版本、上游 pi-web 自基线以来有哪些新提交、
**哪些文件是我们和上游都改过的（真正的冲突面）**。

首次使用需要一次性的准备：

```bash
git remote add upstream https://github.com/agegr/pi-web.git   # 只做一次
echo '{"commit":"df163cdb422f3c3c3c50e7357e8bc7c7354a5f64"}' > .upstream-base.json
```

## 2. 值不值得升（分类闸门）

对每个候选升级，先归类再动手。**任何一项落进"必须做"，就不做"顺手升"。**

| 类别 | 判断依据 | 动作 |
| --- | --- | --- |
| **必须做** | 安全修复 / 我们正踩着的 bug 被修 / 我们要的功能只在它里面 | 排期做，一次只升这一层 |
| **建议做** | 小版本内的行为修正，冲突面为空或很小 | 正常排期 |
| **可做** | 只有底层依赖的小改动、文档 | 合并批次 |
| **不做** | 大版本、扩展 API 破坏性变更、与我们钉的 SDK 冲突 | 记录原因，等有需求再说 |

对 pi SDK 额外三条硬规则（来自 `AGENTS.md`）：

1. **7 个包一起升**，版本必须一致：它们互相用 `^` 引用，混搭迟早出事（`lib/pi-packages.test.mjs` 会抓）。
2. **禁止只升一个包**；`npm install --save-exact` 一次全写。
3. 升级后必须确认会话文件仍可读（格式版本 3）、扩展 API 仍可用。

## 3. 怎么做（本地化 + 验证闸门）

```bash
# 0) 先建基线工作树，把"本来就失败"固定下来（否则分不清是谁弄坏的）
git worktree add ../baseline HEAD
(cd ../baseline && npm test 2>&1 | tee /tmp/before.log | tail -3)

# 1) 开分支
git switch -c upgrade/<upstream>-<version>

# 2) pi SDK 升级（示例）
npm install --save-exact \
  @earendil-works/pi-agent-core@X.Y.Z @earendil-works/pi-ai@X.Y.Z \
  @earendil-works/pi-codemode@X.Y.Z @earendil-works/pi-coding-agent@X.Y.Z \
  @earendil-works/pi-mcp@X.Y.Z @earendil-works/pi-telemetry@X.Y.Z \
  @earendil-works/pi-tui@X.Y.Z

# 3) pi-web 上游合并（示例）
git fetch upstream
git merge upstream/main        # 冲突处理原则见 docs/FORK-NOTES.md §4

# 4) 静态闸门
node_modules/.bin/tsc --noEmit && npm run lint

# 5) 测试闸门：比"失败集合"，不是比数量
npm test 2>&1 | tee /tmp/after.log | tail -3
grep '^✖' /tmp/before.log | sed 's/ ([0-9.]*ms)//' | sort -u > /tmp/b.txt
grep '^✖' /tmp/after.log  | sed 's/ ([0-9.]*ms)//' | sort -u > /tmp/a.txt
comm -13 /tmp/b.txt /tmp/a.txt     # 只应有空：出现新失败 = 回归，停下来查

# 6) 构建 + 安装（这台机器的构建需要更大的堆）
PI_WEB_BUILD_HEAP_MB=14336 npm run deploy

# 7) 运行时验收（见 §4），然后才推送/打标签
```

**回滚**：升级在独立分支 + 独立标签上做，`npm install -g .` 装的是当前仓库，所以回滚就是
`git switch main && npm install -g .`（必要时 `git switch -` 重装一次）。全局装的是副本，
切回去再装一次即可，不需要重装依赖。

## 4. 升级后必须过的运行时验收（10 分钟）

1. `pi-web` 起得来：`✓ Ready`，并且是自建 server 那一行（`live events on /api/agent/:id/ws`）。
2. 本机免密：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:30141/api/sessions` → `200`。
3. 三扇门：`GET /api/remote` 有 `lan` / `tailscale` / `public` 三组 `pairing`；面板三张卡都在。
4. 实时通道：浏览器里 `new WebSocket(wss://<host>/api/agent/<id>/ws)` 收到 `{"type":"connected"}`；
   发一条消息能看到逐段输出（这是 SDK 升级最容易坏的地方）。
5. MCP：`get_commands` 里 `/mcp` 的 `sourceInfo.path` 是 `builtin:mcp`（或记录第三方接管）；
   一条 Read-only 会话里 MCP 工具仍被拦（ADR 0006）。
6. 会话兼容：打开一个老会话不报错；导出一次 HTML。
7. 设置面板 8 个 tab 都能切、控制台 0 报错。
8. 隧道：`tunnel-start` → `running` → 公网 URL 访问到应用；`tunnel-stop` → 旧地址变 Cloudflare 530。

任何一条不过 ⇒ 回滚，把现象写进 `docs/agents/` 对应笔记，别在分支上硬修。

## 5. 定档还是跟随（结论）

- **不"定死"**：这个仓库的价值就在于跟上 pi 的新能力；钉版本只是为了"升得可控"，不是为了停在原地。
- **不自动跟随**：没有 CI 会替我们合并上游；每次升级都是一个人按 §2–§4 走一遍。
- **当前状态**：pi SDK `1.2.0`（落后一个 minor），pi-web 基线 `df163cd`，上游无新提交。
  下一次检查的建议动作：单独开一个 `upgrade/pi-1.3.0` 任务，先跑 `node scripts/upstream-check.mjs`，
  再按 §3 走一遍——**注意 pi 1.3.0 就是引入 `replaceable` 的那版**，MCP 工具命名、
  扩展替换行为都要在验收里重点看。
