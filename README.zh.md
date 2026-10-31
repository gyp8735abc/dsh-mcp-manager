# dsh-mcp-manager

[English](README.md) | 中文 · [![npm](https://img.shields.io/npm/v/@gyp8735abc/dsh-mcp-manager)](https://www.npmjs.com/package/@gyp8735abc/dsh-mcp-manager) · [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的 **按工作区** MCP 与技能管理器。

在每个工作区行点一个按钮，就能决定「这个工作区要挂哪些 MCP 服务器、要看哪些技能」——
全局 MCP 和项目 MCP 的开关**按工作区独立**，互不影响。

## 它解决什么问题

DSH 自带的 MCP 配置是 **profile 级**的：`mcp:` 里写什么，所有工作区、所有会话都吃同一份。
于是日常用起来是这样的：

- 你在 A 项目里用 `codebase`（SQLite 索引）、在 B 项目里也想用，但两边的 `.codebase/codebase.db`
  是不同文件——一份全局配置只能指向一个库；
- 你常开 5 个 MCP 服务器，但当前这个工作区只需要 1 个，另外 4 个的进程白白常驻，
  工具列表也被塞满，模型选错工具的概率跟着上去；
- 技能同理：用户级 `~/.claude/skills` 下的几十个技能，在每个会话里都出现，
  但只有个别工作区真的需要它们。

这个插件把「开关」下沉到**工作区**这一层：

| 对象 | 来源 | 开关粒度 |
|---|---|---|
| 全局 MCP | `~/.claude.json` 的 `mcpServers` | 每个工作区独立 |
| 项目 MCP | 该工作区自己的 `.mcp.json` | 每个工作区独立 |
| 手动 MCP | profile 配置里手写的 `dsh-mcp-client` 行 | 每个工作区独立 |
| 技能 | `.dsh/skills`、`.claude/skills`、`.agents/skills`、`~/.dsh/skills`、`~/.claude/skills`、`~/.agents/skills` | 每个工作区独立 |

## 功能

- **一个弹窗管全部** — 弹窗按「项目 MCP / 全局 MCP / 手动 MCP / 项目技能 / 全局技能」分组，
  每行一个开关，直接显示 `已启用 / 已停用` 与 `已连接 / 未连接`。
- **真正的按工作区隔离** — 状态键是工作区路径；在 A 里关掉的服务器，B 照常启用。
- **并集挂载，切换不打架** — 所有「有存活会话」的工作区同时挂载各自的 MCP，每个
  （工作区, 服务器）一个独立进程（各自的配置和 `cwd`）。切换/聚焦会话**不会**停掉别的工作区的 MCP；
  某个工作区的 MCP 在它最后一个会话关闭后才卸载。
- **会话级工具过滤** — 只有本工作区的 `mcp__<工作区>__*` 和全局/手动服务器进入当前会话的
  工具列表，别的工作区挂着的服务器不会漏进来。
- **技能也按工作区过滤** — 停用的技能从模型侧目录里消失、`skill` 工具调用会被明确拒绝，
  而不是变成「未知工具」。
- **兼容 Claude Code 的技能目录** — 项目 `.claude/skills` 与用户 `~/.claude/skills` 都会被扫描，
  包括没有 YAML frontmatter 的 `SKILL.md`。
- **动态扫描** — 每次打开弹窗都重新读工作区列表与各工作区的 `.mcp.json`，
  新增工作区、改配置文件都不需要重启 DSH。
- **零核心补丁** — 不改 DSH 安装目录里的任何文件，装/卸插件只动 profile 与 `$DSH_HOME`。
- **中英双语 UI** — 跟随 DSH 界面语言。

## 安装

### 方式一：插件市场（推荐，两步）

1. 打开 **插件 → 发现 → 添加索引源**，填入：

   ```
   https://gyp8735abc.github.io/dsh-mcp-manager/index.json
   ```

2. 搜索 `MCP manager`，打开条目，点 **安装**。

> 索引没有签名，市场里的标题、作者、来源都是发布方的声明。只添加你信任的索引源，
> 并在安装确认框里核对来源是 `@gyp8735abc/dsh-mcp-manager`。

### 方式二：一条命令

```sh
dsh plugin --profile web add @gyp8735abc/dsh-mcp-manager
```

本包同时是一个 DSH bundle（`dsh.bundle.patch`），安装后插件行会自动插入 profile 的组合，
不需要手写 `cordis.patch.yml`。

### 方式三：从源码

```sh
git clone https://github.com/gyp8735abc/dsh-mcp-manager.git
cd dsh-mcp-manager
dsh plugin --profile web add .
```

### 验证安装

```sh
dsh --profile web --dump-config | grep -A 3 dsh-mcp-manager
```

能看到 `id: dsh-mcp-manager` 就说明它已经进组合树。然后**重启 `dsh web`** 并强制刷新浏览器
（`Ctrl+Shift+R`）——浏览器端的 bundle 只在启动时注入。

装好后，工作区列表每一行的 `⋯` 菜单**左边**会多出一个插头图标按钮。

## 使用

点工作区行上的插头按钮，弹窗会显示：

```
┌ MCP 与技能 ────────────────────────────────┐
│ 工作区  D:\ai-workspace      当前工作区      │
│                                               │
│ 项目 MCP（.mcp.json）                         │
│   ● codebase      stdio   已启用  已连接      │
│   ○ e2e-runner    stdio   已停用  未连接      │
│                                               │
│ 全局 MCP（~/.claude.json）                    │
│   ● everything-search  http  已启用  已连接    │
│                                               │
│ 手动 MCP（profile 配置）                      │
│   ○ codegraph     stdio   已停用  未连接      │
│                                               │
│ 项目技能（本工作区）                          │
│   ● officecli  .dsh   已启用                  │
│   ○ probe      .claude 已停用                 │
│                                               │
│ 全局技能（所有工作区）                        │
│   ● diagnose-windows-sandbox-acl  ~/.dsh      │
└───────────────────────────────────────────────┘
```

- **当前工作区**（弹窗顶部有提示）：拨动开关**立即生效**——启用就连接进程并注册工具，
  停用就断开并卸载工具。
- **非当前工作区**：开关只保存状态，等这个工作区有会话时才按状态挂载。
- 空分组不显示；某个工作区一个 MCP、一个技能都没有时，弹窗给出空状态提示。
- 项目 MCP 的名字会带工作区前缀：A 工作区里的 `codebase` 在运行时叫 `a__codebase`，
  模型看到的工具名是 `mcp__a__codebase__search_code`。这样两个工作区的同名服务器可以
  以各自独立的进程共存，而不是互相顶掉。

## 数据与状态

状态文件是 `$DSH_HOME/mcp-manager/state.json`（`$DSH_HOME` 默认 `~/.dsh`）：

```json
{
  "projects": [
    {
      "path": "D:\\ai-workspace",
      "disabled": ["dsh-mcp-manager__codebase"],
      "disabledSkills": ["office"]
    }
  ]
}
```

| 字段 | 含义 |
|---|---|
| `path` | 工作区绝对路径（身份键） |
| `disabled` | 该工作区停用的 MCP 运行名列表；项目服务器写工作区限定名（`<slug>__<name>`），全局/手动服务器写原名 |
| `disabledSkills` | 该工作区停用的技能名列表 |

- 首次启动会自动从旧的 `$DSH_HOME/settings.yaml` 的 `mcp:` 段导入一次，无需手工迁移。
- 停用名单里同时认限定名与旧 plain 名（`codebase`），所以老配置不会失效。
- 手改这个文件后，重启 DSH 或重新打开弹窗即生效。

### HTTP API

弹窗只用这三个接口，也可以自己调用（同源，无鉴权）：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/dsh-mcp-manager/inventory?active=<工作区路径>` | 该工作区的完整清单（MCP 分组 + 技能 + 连接状态） |
| `POST` | `/api/dsh-mcp-manager/activate` | `{ "path": "..." }`，记住当前聚焦的工作区 |
| `POST` | `/api/dsh-mcp-manager/set` | `{ "path": "...", "kind": "mcp"\|"skill", "name": "...", "enabled": true }` |

## 挂载语义（想改配置文件前先读这段）

- **并集模型**：挂载集合 = 所有「有存活会话」的工作区各自想要的服务器之并集。
  没有任何存活会话时，退化为「当前聚焦工作区」的集合。
- **进程粒度**：项目服务器每个（工作区, 服务器）一个进程，`cwd` 默认是该工作区目录，
  所以 `.codebase/codebase.db` 这类相对路径各自落到自己的工作区。
- **全局服务器**：只要任一存活工作区启用，就挂一个共享进程。
- **手动服务器**（profile 里手写的 `dsh-mcp-client` 行）：只要任一存活工作区需要就保持启用，
  因为一个 loader 行只能有一个进程。
- **卸载时机**：某工作区最后一个会话关闭后，它专属的服务器进程被卸载；
  卸载后会按命令行特征清扫可能残留的子进程。
- **孤儿进程**：托管服务器被停用/卸载时，插件会用启动命令的特征串找并杀掉残留子进程，
  避免 stdio 服务器变成野进程。

## 技能

- 技能根按以下优先级合并（**rank 小者赢**，同名技能只出现一次）：

  | 顺序 | 根 | 来源标记 |
  |---|---|---|
  | 1 | `<工作区>/.dsh/skills` | `project-dsh` |
  | 2 | `<工作区>/.claude/skills` | `project-claude` |
  | 3 | `<工作区>/.agents/skills` | `project-agents` |
  | 4 | `~/.dsh/skills` | `user-dsh` |
  | 5 | `~/.claude/skills` | `user-claude` |
  | 6 | `~/.agents/skills` | `user-agents` |

  `.claude` 与 `.agents` 这两组是 DSH 默认不认的（DSH 只认 `.dsh` 与 `.agents`），
  由本插件通过 `ctx.skills.registerProvider()` 补上，不 patch 任何核心包。
- **技能目录**里每个技能是一层目录下的 `SKILL.md`，或根目录下的单个 `.md` 文件；
  没有 frontmatter 时用目录名作名字、正文第一行作描述（Claude Code 的常见写法）。
- **停用技能的三重生效点**：会话技能目录不再列出、`/技能名` 不会被注入、
  `skill` 工具调用被拒绝并返回「该技能在此工作区已停用」。

## 兼容性

| 项目 | 要求 |
|---|---|
| DSH | `>=0.2.0-rc.2 <0.3.0`（安装时按运行时版本校验，不匹配会拒绝安装） |
| Node.js | `>=22` |
| 界面 | 仅 Web（`dsh web` 与桌面版 GUI 的 Web 视图）；`headless` / `acp` 无 UI 入口 |

运行时依赖只有 DSH 安装目录自带的包（`@deepseek-ai/dsh-mcp-client` 等），
插件本身没有 npm 运行时依赖。

## 已知限制

- **技能文件没有 watcher** — DSH 运行期间新增到 `.claude/skills` 的技能，要重启才会出现
  （已有技能与项目技能在启动时全部加载）。
- **工作区按钮是 DOM 注入的** — DSH 0.2.x 只为「会话行」声明了 slot，工作区行没有，
  所以按钮通过 `MutationObserver` 注入并在重渲染后补回。按钮若在某些主题/布局下没出现，
  先确认 DSH 版本是否仍在 `>=0.2.0-rc.2 <0.3.0` 区间。
- **技能过滤是原型补丁** — 它影响所有访问技能服务的消费者（比如技能选择器 UI）。
  这是有意为之：开关本身就是按工作区的，而每次查询都带 `cwd`。
- **状态不在 DSH 设置页** — DSH 0.2.x 不再允许插件注册任意设置命名空间，
  所以开关状态存在自己的 `state.json` 里，不出现在设置页。
- **切换语义** — 「非当前工作区」的开关只保存状态，不会立刻拉起进程；这是为了避免
  给没在用的工作区白开进程。

## 安全

- 插件会拉起项目 `.mcp.json` 与 `~/.claude.json` 里声明的 **stdio 命令**，
  等同于把代码执行权交给这些配置。只在你信任的仓库/配置里使用。
- 三个 HTTP 接口**没有鉴权**，设计前提是 `dsh web` 只监听 loopback（默认 `127.0.0.1`）。
  用 `--host 0.0.0.0` 暴露到网络时，任何能访问该端口的人都能开关你的 MCP 服务器。
- 插件不改 DSH 安装目录，不写 `settings.yaml`，只写 `$DSH_HOME/mcp-manager/state.json`。

## 开发

```sh
node --check lib/index.js        # host：清单收集、按工作区状态、并集挂载、路由
node --check lib/skill-filter.js # 技能过滤（SkillRegistry 原型 + tools.guard）
node --check lib/skill-roots.js  # Claude 技能根 provider
node --check client/client.js    # 浏览器 bundle（ModuleLoader factory 形式）

npm run pack:check               # 校验 npm 包内容（发布前必跑）
npm run market:index             # 生成 docs/index.json 插件市场索引
```

| 路径 | 作用 |
|---|---|
| `lib/index.js` | Host 主逻辑：状态、`inventory` / `activate` / `set`、并集挂载、会话工具过滤 |
| `lib/skill-filter.js` | 按工作区过滤技能（目录 / 注入 / 工具调用三处） |
| `lib/skill-roots.js` | `.claude` 技能根 + 无 frontmatter 的 `SKILL.md` 解析 |
| `client/client.js` | 浏览器半：工作区行按钮 + 弹窗（中英双语） |
| `cordis.patch.yml` | bundle 补丁：把插件行插进 profile 组合 |
| `locale/{en,zh}.json` | 插件页显示用的标题/简介 |
| `docs/index.json` | 插件市场索引（format 1），托管在 GitHub Pages |
| `docs/PUBLISHING.md` | 发布流程（npm + GitHub + 市场索引） |

浏览器半是**手写的 ModuleLoader bundle**（`window.__ModuleLoader__.load({ factory })`），
没有构建步骤；改完直接刷新页面即可。

## 发布

见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 许可证

[MIT](LICENSE)
