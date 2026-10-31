# 发布指南（npm + GitHub + 插件市场）

这份文档是给**维护者**看的：把 `dsh-mcp-manager` 从本地目录变成一个别人能一条命令装上的插件。

面向**用户**的安装与使用说明在 [README.zh.md](../README.zh.md)。

---

## 0. 三条发布通道，各管什么

| 通道 | 作用 | 用户侧入口 |
|---|---|---|
| **npm**（必需） | 真正承载代码。DSH 的插件安装就是 `pnpm add` | `dsh plugin --profile web add @gyp8735abc/dsh-mcp-manager`，或插件页里填包名 |
| **GitHub 仓库**（必需） | 放源码、README、Issue、Release，也是市场索引 `homepage/repository` 指向的地方 | 读文档、看源码、报 issue |
| **插件市场索引**（可选但推荐） | 一个 JSON 文件，让「插件 → 发现」能搜到、一键装 | 添加索引源 → 搜索 → 安装 |

索引本身不托管代码，它只声明「这个包名、这个版本、从 npm 拿、要求的 DSH 版本」。
所以顺序永远是：**先发 npm，再更新索引**。

---

## 1. 发布前要确认的三个身份

当前仓库里已经写死为：

| 位置 | 当前值 |
|---|---|
| npm 包名 | `@gyp8735abc/dsh-mcp-manager` |
| GitHub 仓库 | `https://github.com/gyp8735abc/dsh-mcp-manager` |
| 作者 | `gyp8735abc` |

> **作用域必须以你自己的 npm 用户名为准。** npm 的规则是：`@xxx/` 里的 `xxx` 要么是
> 你的用户名，要么是你拥有的组织。如果你的 npm 用户名不是 `gyp8735abc`，发布时会报
> `403 Forbidden - PUT ... You do not have permission to publish`。
>
> 改名只涉及三个文件（索引由脚本重新生成，不用手改）：
>
> ```powershell
> # 在仓库根目录执行，把旧作用域换成你的 npm 用户名
> (Get-Content package.json -Raw) -replace '@gyp8735abc/', '@<你的npm用户名>/' | Set-Content package.json -NoNewline
> (Get-Content cordis.patch.yml -Raw) -replace '@gyp8735abc/', '@<你的npm用户名>/' | Set-Content cordis.patch.yml -NoNewline
> # README.md / README.zh.md 里的包名与索引地址同理（搜索 @gyp8735abc 逐个替换）
> ```

另外注意：**`dsh-mcp-manager` 这个裸名字在 npm 上已经被别人占了**（作者 `nichts`，
一个「设置页里管全局 MCP」的插件）。所以本包必须带作用域，不能叫裸名。

---

## 2. 账号准备（一次性）

### npm

1. 注册 <https://www.npmjs.com/signup>，把用户名记下来（它会成为你的作用域）。
2. 打开 **Account → Two-Factor Authentication**，至少开启 **Authorization only**。
   没有 2FA 的账号可以发布，但 npm 现在对新包的自动化发布越来越严，开启更省事。
3. 建议生成 **Granular Access Token**（Account → Access Tokens）给 CI 用：
   - Permissions: **Read and write**
   - Packages: 选择 `@<你的用户名>/*`
   - 勾选 **Bypass 2FA**（否则 CI 里发布会卡在 OTP）

### GitHub

1. 建一个公开仓库，名字随意（本文按 `dsh-mcp-manager` 写）。
2. 如果你打算用 Actions 自动发布：仓库 **Settings → Secrets and variables → Actions**
   里加 `NPM_TOKEN`（上一步的 granular token）。

---

## 3. 把代码推到 GitHub

```powershell
cd "D:\ai-workspace\dsh-mcp-manager-port"
git init
git add .
git commit -m "feat: per-workspace MCP and skill manager for DSH 0.2.x"
git branch -M main
git remote add origin https://github.com/gyp8735abc/dsh-mcp-manager.git

# 如果 GitHub 直连不稳，先挂代理（本机是 127.0.0.1:7897）
$env:HTTPS_PROXY="http://127.0.0.1:7897"
$env:HTTP_PROXY="http://127.0.0.1:7897"
git push -u origin main
```

`git add .` 之前确认 `.gitignore` 生效（`node_modules/`、`.npm-cache-pack/`、`.pack.json` 都不该进仓库）。

---

## 4. 发布到 npm

### 4.1 先本地自检

```powershell
cd "D:\ai-workspace\dsh-mcp-manager-port"
npm run check        # 四个源文件语法检查
npm run pack:check   # 校验 npm 会打包哪些文件（13 个文件，约 124 KiB）
```

`pack:check` 会核对：运行时文件是否齐、有没有把 `scripts/`、`docs/`、`node_modules/`
带进包里、`dsh.bundle` / `dsh.client` / `exports` / `engines` 是否齐全。

### 4.2 登录官方源（注意你本机的默认源）

你的 `~/.npmrc` 里 `registry=https://registry.npmmirror.com`。**镜像站不能发布**，
所以登录和发布都要显式指向官方源：

```powershell
npm login --registry=https://registry.npmjs.org --auth-type=web
npm whoami --registry=https://registry.npmjs.org   # 应该打印你的用户名
```

`package.json` 里已经写了：

```json
"publishConfig": { "access": "public", "registry": "https://registry.npmjs.org" }
```

- `access: public` 是**作用域包的强制要求**，否则会被当成私有包收费（返回 `402`）。
- `registry` 让它即使在本机默认镜像的情况下也往官方源发。

### 4.2b 关键一步：2FA 与 bypass token（0.2.0 发布时踩到的坑）

这个账号的 npm 登录走的是**邮箱一次性验证码**，但 npm 发布要求的是真正的
two-factor authentication。首次 `npm publish` 会返回：

```
E403 Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

两条出路，0.2.0 走的是第二条：

| 方案 | 做法 | 适合 |
|---|---|---|
| A. 开 TOTP | 账号设置里启用 authenticator App，发布时 `npm publish --otp=<6位码>` | 人肉发布 |
| B. bypass token（当前采用） | <https://www.npmjs.com/settings/gyp8735abc/tokens/granular-access-tokens/new> → 勾 **Bypass 2FA** → 权限 **Read and write (publish and stage)** → **All packages** | 本地脚本 + CI |

**B 的 token 不要写进仓库。** 本机约定：两枚凭据（npm 发布 + GitHub PAT）统一放在
`D:\ai-workspace\.secrets\env.ps1`（该目录已被 `.gitignore` 排除），仓库里的
`.npmrc.publish` 只引用变量、不含明文：

```powershell
. D:\ai-workspace\.secrets\env.ps1        # 载入 NPM_TOKEN / GH_TOKEN
# .npmrc.publish 内容：
#   registry=https://registry.npmjs.org
#   //registry.npmjs.org/:_authToken=${NPM_TOKEN}
npm publish --ignore-scripts --userconfig .npmrc.publish --registry=$env:NPM_REGISTRY
```

凭据的权限、到期时间、轮换方式见 [`.secrets/README.md`](../../.secrets/README.md)
（相对 `D:\ai-workspace`）。

两个必须知道的附加事实：

1. **`--ignore-scripts` 是必要的（在受沙箱限制的终端里）。** `prepublishOnly`
   会调用 `pack:check`，它内部再 spawn 一次 `npm`，在沙箱化的 shell 里会
   `EPERM`。正常终端里可以去掉这个参数；去掉前先单独跑过 `npm run check` 和
   `npm run pack:check`。
2. **bypass token 正在退场。** npm 已在页面顶部提示：带 bypass 的直接发布能力
   **2027 年 1 月**移除，账号变更类操作 2026 年 8 月起就受限。迁移方向是
   **Trusted Publishing**（CI 用 OIDC 免 token）或给账号开 TOTP 后人工 `--otp`。
   本仓库的 `.github/workflows/publish.yml` 目前用 `NPM_TOKEN` secret，届时换成
   trusted publisher 即可。

### 4.3 发布

```powershell
$env:npm_config_cache = "$PWD\.npm-cache-pack"   # 沙箱终端里把 cache 留在仓库内
npm publish --ignore-scripts --userconfig .npmrc.publish --registry=https://registry.npmjs.org
```

如果账号开了 TOTP 且没有 bypass token，改用一次性验证码：

```powershell
npm publish --otp=123456
```

成功时最后几行类似：

```
npm notice 📦  @gyp8735abc/dsh-mcp-manager@0.2.0
npm notice Tarball Contents
...
+ @gyp8735abc/dsh-mcp-manager@0.2.0
```

> **npm 有"处理中"延迟。** 0.2.0 发布后约 3 分钟内，`npm view` / registry 读到的仍是
> `404`。这不是失败——`+ @gyp8735abc/...` 出现就是已提交，等一会儿再查。别急着改版本号重发。

### 4.4 立即验证

```powershell
npm view @gyp8735abc/dsh-mcp-manager version --registry=https://registry.npmjs.org
# 0.2.0

npm view @gyp8735abc/dsh-mcp-manager dist.tarball --registry=https://registry.npmjs.org
```

真正的验收是**在一个干净的 `DSH_HOME` 里装一遍**（不污染你日常用的环境）：

```powershell
$env:DSH_HOME="D:\tmp\dsh-test-home"
dsh plugin --profile web add "@gyp8735abc/dsh-mcp-manager@0.2.0"
dsh --profile web --dump-config | Select-String -Pattern "dsh-mcp-manager" -Context 1,3
```

`--dump-config` 里能看到这一行就说明组合成功：

```yaml
- id: dsh-mcp-manager
  name: "@gyp8735abc/dsh-mcp-manager"
```

再起一次服务，确认 host 半真的跑起来：

```powershell
dsh web --port 0 --no-open
# 记下打印出来的 http://127.0.0.1:<port>/?token=...
# 另开一个窗口：
$r = Invoke-WebRequest "http://127.0.0.1:<port>/api/dsh-mcp-manager/inventory?active=D%3A%5Cai-workspace" `
     -Headers @{ Authorization = "Bearer <token>" }
$r.Content | ConvertFrom-Json | Select-Object projectPath, globalSource
```

返回 `projectPath` + 各分组清单 = host 半加载成功、路由已注册。
最后检查浏览器半有没有被注入到页面里：

```powershell
(Invoke-WebRequest "http://127.0.0.1:<port>/?token=<token>").Content -match 'dsh-mcp-manager/client\.js'
# True
```

> 本仓库作者已用**打包出来的 tarball**（与 `npm publish` 上传内容一致）在独立
> `DSH_HOME` 里跑过上述全流程：安装 → 组合 → 启动 → `inventory` 返回真实工作区数据 →
> 页面预加载列表里出现 `@gyp8735abc/dsh-mcp-manager/client.js` → `POST set` 落盘到
> `state.json`。0.2.0 发布后又用**真实的 npm 安装**（`dsh plugin add @gyp8735abc/dsh-mcp-manager@0.2.0`）
> 在全新的 `DSH_HOME` 里重复了一遍，结果一致——说明 peer 依赖
> （`@deepseek-ai/dsh-mcp-client`）在干净环境里由 DSH 运行时表提供，不需要用户额外安装。

---

## 5. 托管插件市场索引（GitHub Pages）

索引文件是 `docs/index.json`，由脚本生成，**不要手写**：

```powershell
# 发完 npm 之后跑，这样时间戳是 npm 上的真实发布时间
node scripts/build-market-index.mjs --from-registry `
  --validator "D:\p\npm-global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-plugin-market-index\lib\index.js"
```

脚本做三件事：写 `docs/index.json`、把 `icon.svg` 复制到 `docs/`（索引里的图标是相对路径，
按索引 URL 解析）、用 DSH 官方的 format-1 校验器验一遍（校验失败会直接报错退出）。
没有校验器时会打印一条警告并跳过——**发布前请确保看到 `validated by ...`**。

### 5.1 打开 Pages

仓库 `gyp8735abc/dsh-mcp-manager` 的 Pages **已经配置好**（source: `main` / `/docs`），
索引地址就是：

```
https://gyp8735abc.github.io/dsh-mcp-manager/index.json
```

新仓库要从头配的话，两条路：

- **界面**：Settings → Pages → Source: *Deploy from a branch* → Branch: `main`，目录 `/docs` → Save。
- **API**（需要带 `repo` 权限的 token）：

  ```powershell
  $env:GH_TOKEN = "<你的 PAT>"
  node -e "fetch('https://api.github.com/repos/gyp8735abc/dsh-mcp-manager/pages',{method:'POST',headers:{authorization:'Bearer '+process.env.GH_TOKEN,accept:'application/vnd.github+json','content-type':'application/json'},body:JSON.stringify({source:{branch:'main',path:'/docs'}})})"
  ```

改完 `docs/index.json` 后 `git push` 即可，Pages 会自动重建（约 20–60 秒）。

### 5.2 验证索引

```powershell
# PowerShell 的 Invoke-WebRequest 在部分代理环境下会报 SSL 错，用 node 的 fetch 更稳
node -e "(async()=>{const r=await fetch('https://gyp8735abc.github.io/dsh-mcp-manager/index.json');const j=await r.json();console.log(r.status, j.plugins[0].name, j.plugins[0].versions[0].version)})()"
```

### 5.3 索引长什么样（format 1 字段说明）

```jsonc
{
  "format": 1,                                  // 固定 1
  "title": { "en": "...", "zh": "..." },        // 必须含 en
  "description": { "en": "...", "zh": "..." },  // 可选
  "metadata": {
    "categories": { "mcp": { "title": { "en": "MCP", "zh": "MCP" } } },
    "labels":     { "per-workspace": { "title": { "en": "Per workspace", "zh": "按工作区" } } }
  },
  "plugins": [{
    "name": "@gyp8735abc/dsh-mcp-manager",       // 必须是合法 npm 包名
    "title": { "en": "...", "zh": "..." },
    "description": { "en": "...", "zh": "..." },
    "icon": "./icon.svg",                        // 相对索引 URL，或 data: URL（≤32 KiB）
    "author": "gyp8735abc",
    "homepage": "https://github.com/gyp8735abc/dsh-mcp-manager#readme",
    "repository": { "url": "https://github.com/gyp8735abc/dsh-mcp-manager" },
    "metadata": {
      "category": "mcp",                         // 必须是 metadata.categories 里声明过的 id
      "keywords": ["dsh", "mcp"],
      "labels": ["per-workspace"]                // 必须是 metadata.labels 里声明过的 id
    },
    "versions": [{
      "version": "0.2.0",                        // 精确 SemVer，不能是范围
      "publishTimestamp": 1793462400,            // Unix 秒
      "source": { "type": "npm" },               // 或 { "type": "git", "url": "...", "commit": "<40位sha>" }
      "engines": { "dsh": ">=0.2.0-rc.2 <0.3.0" } // 决定市场里是否显示「可安装」
    }]
  }]
}
```

要点：

- `versions` 是**数组**，新版本可以往里追加，市场会列出所有版本并标出推荐版本；
  当前生成脚本只写入 `package.json` 里的当前版本。要保留历史版本，发布后手工把旧条目
  补进 `versions` 数组（保持「新→旧」顺序无所谓，校验器会自己按 SemVer 降序排）。
- `engines.dsh` 与 `package.json` 里的同名声明保持一致，否则市场显示的兼容性会和实际安装
  时的 preflight 结果矛盾。
- `publishTimestamp` 必须是你**发布到 npm 之后**的真实时间；用 `--from-registry` 就不会错。
- 一个索引可以放多个插件；`plugins[].name` 不能重复。

---

## 6. 用户怎么装（发布成功后对外只写这三种）

1. **插件市场**：插件 → 发现 → 添加索引源 `https://gyp8735abc.github.io/dsh-mcp-manager/index.json` → 搜索 → 安装。
2. **命令行**：`dsh plugin --profile web add @gyp8735abc/dsh-mcp-manager`
3. **源码**：`git clone` 后 `dsh plugin --profile web add .`

三条路都走同一份 `dsh.bundle.patch`，装完插件行自动进组合，无需手改 `cordis.patch.yml`。
用户重启 `dsh web` 并强制刷新浏览器后，工作区行会出现插头按钮。

---

## 7. 发新版本

```powershell
# 1. 改版本号（语义化：修 bug 补丁位、加功能次版本位、破坏性改动主版本位）
npm version patch --no-git-tag-version
# 2. 更新 CHANGELOG.md
# 3. 自检 + 发布
npm run check
npm run pack:check
npm publish
# 4. 更新市场索引（拉真实发布时间）
node scripts/build-market-index.mjs --from-registry --validator "<校验器路径>"
# 5. 提交 + 打 tag（tag 会触发 .github/workflows/publish.yml 的自动发布，若你用它）
git add -A; git commit -m "release: v0.2.1"; git tag v0.2.1; git push --follow-tags
```

> 如果你用了 GitHub Actions 的自动发布，就**不要**在本地再 `npm publish` 一次，
> 否则第二次会因版本已存在而失败（`EPUBLISHCONFLICT`）。二选一：
> 本地发（tag 只做标记），或 tag 触发 CI 发。

### 版本号与 DSH 兼容性

- `package.json` 的 `engines.dsh` 是**唯一的兼容性判据**（一旦声明，`peerDependencies`
  就不再参与判定）。安装前 DSH 会拿运行时版本做 preflight，不匹配直接拒绝安装。
- 现在的范围 `>=0.2.0-rc.2 <0.3.0` 表示「0.2.x 全系列可用，0.3 起不保证」。
  DSH 发布 0.3 前，如果要继续支持 0.2，就保持这个范围；要跟进 0.3，就改成
  `>=0.2.0-rc.2 <0.4.0` 并**实际测过**再发。
- 应急：用户可以用 `dsh plugin --profile web allow-version @gyp8735abc/dsh-mcp-manager@0.2.0 --dsh-version 0.3.0-rc.1 --accept-risk`
  强制安装，但那条路有崩溃风险，不要把「让用户自己豁免」当成兼容性策略。

---

## 8. 常见错误对照

| 报错 / 现象 | 原因 | 处理 |
|---|---|---|
| `402 Payment Required` | 作用域包没设 `access: public` | 确认 `publishConfig.access` |
| `403 Forbidden - PUT` | 作用域不属于你的账号 / 未登录 | `npm whoami --registry=https://registry.npmjs.org`；`npm login` |
| `ENEEDAUTH` | 没登录，或登录到了镜像站 | `npm login --registry=https://registry.npmjs.org` |
| `EPUBLISHCONFLICT` / `403 ... cannot publish over` | 版本号已存在 | `npm version patch` 后重发（npm 不允许覆盖已发布版本） |
| `ERR_PNPM_TARBALL_URL_MISMATCH`（用户侧） | 用户先装了别家源的包，又切回官方源 | 删 `node_modules` 与 lockfile 后重装 |
| 市场里搜不到 | 索引没部署 / `format` 不是 1 / `name` 写错 | 浏览器直接打开索引 JSON；`node scripts/build-market-index.mjs --validator ...` |
| 市场条目显示「不可安装」 | 该版本 `engines.dsh` 与运行版本不匹配 | 改 `engines.dsh` 并重发索引 |
| 装完没有插头按钮 | 没重启 `dsh web` / 没强刷浏览器 / DSH 版本超出范围 | 重启 + `Ctrl+Shift+R`；`dsh --version` |
| `dsh plugin add` 说找不到包 | 镜像站还没同步（新包一般几分钟到几十分钟） | 用官方源装：`dsh plugin --profile web add @gyp8735abc/dsh-mcp-manager --registry=https://registry.npmjs.org` |
| 发布 3 分钟内 `npm view` 还是 404 | npm 发布流水线在处理中 | 等 1–3 分钟再查，不要改版本号重发 |
| 推 `.github/` 下的 workflow 被拒 | PAT 缺 `workflow` 权限 | 重新生成 token 并勾上 `workflow` |

---

## 9. 发布检查清单

发布前：

- [ ] `package.json` 的 `name` 作用域是你的 npm 用户名，`version` 是新的
- [ ] `cordis.patch.yml` 里的 `name` 与包名**完全一致**（含作用域）
- [ ] `CHANGELOG.md` 写了这一版
- [ ] `npm run check` 通过
- [ ] `npm run pack:check` 通过，文件列表只有预期的那 13 个
- [ ] 在一个干净的 `DSH_HOME` 里用本地 tarball 装过一遍，`--dump-config` 有该行
- [ ] `.npmrc.publish` 存在且**没有**被 `git status` 看到（`.gitignore` 已覆盖）

发布后：

- [ ] `npm view <包名> version` 返回新版本（记得等处理延迟）
- [ ] `node scripts/build-market-index.mjs --from-registry --validator ...` 输出 `validated by`
- [ ] `docs/index.json` 已提交并推送，Pages 地址返回 200
- [ ] 在另一台机器（或另一个 `DSH_HOME`）按 README 的「方式一」从市场装一次，能看到按钮

---

## 10. 发布记录

| 项 | 值 |
|---|---|
| npm 包 | `@gyp8735abc/dsh-mcp-manager@0.2.0`，发布于 2026-10-31T23:43:27Z |
| 包体积 | 40.2 kB（tar）/ 126.8 kB（解包）· 13 个文件 |
| GitHub | <https://github.com/gyp8735abc/dsh-mcp-manager> |
| 市场索引 | <https://gyp8735abc.github.io/dsh-mcp-manager/index.json> |
| 发布用 token | `D:\ai-workspace\.secrets\env.ps1`（npm bypass 2FA，至 2027-01-30；GitHub PAT，至 2026-12-01） |
| 验证 | 全新 `DSH_HOME` 从 npm 安装 → 组合成功 → `/api/dsh-mcp-manager/inventory` 返回 200 → 页面加载 `client.js` |

> token 到期（2027-01-30）或 npm 于 2027-01 移除 bypass 直接发布后，按 §4.2b 换成
> TOTP + `--otp` 或 Trusted Publishing。

