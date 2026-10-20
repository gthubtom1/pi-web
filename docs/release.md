# 发布流程（本仓库自己的）

每次发布产出**一样东西**：一个**预构建 tarball**，挂在 GitHub Release 上。别人用它安装时不需要构建：

```bash
npm install -g --allow-scripts=pi-web-fork,node-pty,@google/genai,protobufjs \
  https://github.com/gthubtom1/pi-web/releases/download/v<版本>/pi-web-fork-<版本>.tgz
```

> 本项目**不发布到 npm**。任何 registry 上的同名包都不是它。发布只做 GitHub Release。

从干净的 `main` 开始执行。

## 1. 预检

```bash
git switch main
git pull --ff-only
git status --short            # 必须为空
node_modules/.bin/tsc --noEmit
npm run lint
npm test 2>&1 | tail -3       # 与基线的失败集合比对，不看总数
```

失败集合里只能有**已知环境性失败**（Windows 的 ESM 路径、`fileURLToPath` 在 `D:\`、`EBUSY rmdir`、MCP 集成）。
出现新失败就停下来修，不要带着发布。

## 2. 版本号（只有三处）

```bash
npm version patch --no-git-tag-version     # package.json + package-lock.json
```

然后改这两个文件里**安装 URL 的版本号**（它们是目前唯一写死版本的地方）：

- `README.md` 的 Quick Start
- `docs/INSTALL.md` 的 §1 A

```bash
grep -n "releases/download/v" README.md docs/INSTALL.md
```

## 3. 构建 + 打包

```bash
npm run release:tarball
```

它会：`next build`（内存不够时 `PI_WEB_BUILD_HEAP_MB=14336`）→ 按 `package.json` 的 `files`
白名单 `npm pack` → 打印 tarball 大小和**给别人用的那条安装命令**。

产物应该 **5–7 MB**。如果它变成上百 MB，说明 `files` 的排除失效了——最可能是
`.next/**/*.nft.json`（每路由一个 20+ MB 的依赖追踪清单，运行时不需要）又被打进去了，别发布。

## 4. 验收这个包（发布前，必做）

```bash
# 装到一个临时前缀，别动本机现有安装
P="$(mktemp -d)"
npm install -g --prefix "$P" --allow-scripts=pi-web-fork,node-pty,@google/genai,protobufjs ./pi-web-fork-<版本>.tgz
"$P/pi-web" version                     # 应打印新版本
"$P/pi-web" -p 30197 --no-open &        # 换一个端口，避免顶掉正在用的
sleep 20
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:30197/api/web-auth   # 200
```

再在浏览器里打开 `http://127.0.0.1:30197/`：设置面板 8 个 tab 能切、控制台无报错、
发一条消息能看到逐段输出（或至少 `/api/sessions` 有返回）。**这一步不通过就不要发。**

## 5. 打标签

```bash
git commit -am "release: <版本>"
git tag -a v<版本> -m "pi-web-fork <版本>"
git push origin main v<版本>
```

标签必须指向**将要发布的那次提交**（先提交、再打标签；改完代码重打标签要 `git tag -f` + `push -f`）。

## 6. 发布

```bash
npm run release:tarball -- --publish      # 用 gh 创建/覆盖 Release 并上传 tarball
# 或者手动：
gh release create v<版本> pi-web-fork-<版本>.tgz --repo gthubtom1/pi-web \
  --title "pi-web-fork <版本> (prebuilt)" --notes "安装：<上面那条命令>"
```

## 7. 发布后核对

```bash
gh release view v<版本> --repo gthubtom1/pi-web --json assets --jq '.assets[].name'
curl -sIL https://github.com/gthubtom1/pi-web/releases/download/v<版本>/pi-web-fork-<版本>.tgz | tail -1   # 200
```

再在一台干净的机器（或临时前缀）用 README 里那条命令装一次，`pi-web version` 应为新版本。

## 回滚

- **只换产物**：改完重新 `npm run release:tarball`，再 `gh release upload v<版本> <tgz> --clobber`。
- **撤回整个版本**：`gh release delete v<版本> --repo gthubtom1/pi-web`，并把 `package.json` 版本退回、
  两个 URL 改回旧版本，然后按 §3 重新发一个补丁版本（不要复用被打回的 tag）。

## 注意事项

- `*.tgz` 已 gitignore：**产物不进仓库**，只挂 Release。
- `fork.json` 随包发布（`pi-web update` 用它告诉用户该去哪个 releases 页），改仓库地址时一起改。
- 版本号只在前述三处 + 标签出现；`docs/UPSTREAM-POLICY.md` 里的"当前状态"也顺手更新一下。
