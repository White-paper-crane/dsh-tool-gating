# dsh-tool-gating

DSH 本地插件：常驻一小撮工具，其余按组加载。工具面按需展开，省 prompt 前缀，也让模型少看无关工具。

- **L0（常驻）**：`groups.json` 的 `core`，默认 8 个（read/write/edit/pwsh/glob/grep/todo_write/load_tools）。
- **L1（阶段组）**：coding / teams / browser / ops / media / memory / context / misc。模型调 `load_tools(groups=["coding"])` 后，下一步的工具列表里出现该组。
- **L1.5（静态目录）**：系统提示里一段固定目录（`名字 — 用途 [组]`），让模型知道有什么可加载。目录只依赖 `groups.json`，不随加载状态变化。
- **不做 L2（自动回收）**：没有按使用频率自动卸载。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 插件入口：注册 `load_tools`、目录 section、宿主事件；`export const name/inject/apply` |
| `lib/groups.js` | 组清单解析与校验、目录文本渲染（纯函数） |
| `lib/state.js` | 门控状态机：plan/commit、预算、deny 台账（纯函数） |
| `groups.json` | 组清单（125 个工具名，全部带中文 purpose；core 8 个） |
| `tests/fake-ctx.mjs` | 假宿主：只实现插件用到的那片 Cordis/ToolsService 语义 |
| `tests/selftest.mjs` | 离线集成自检（假 ctx 跑真插件代码） |
| `tests/test-state.mjs` | 状态机 / 清单校验的纯逻辑自测 |

## 自测（不需要启用插件）

```powershell
cd <这个目录>
node tests/test-state.mjs   # 28 passed（状态机/清单校验）
node tests/test-auto.mjs    # 自动分组
node tests/selftest.mjs     # 28 passed（假 ctx 跑真插件）
```

`node tests/selftest.mjs` 就是「不启用、仅自检」的加载方式：`import` 真插件 → 造一个假 ctx → 跑 `apply()` → 断言注册的工具、目录文本、限制层、预算、清理。

## 启用（改 profile 配置属于危险操作，先确认）

在 profile 的 `cordis.patch.yml`（例如 `~/.dsh/profiles/desktop/cordis.patch.yml`）里加一条 insert：

```yaml
- insert:
    - id: dsh-tool-gating
      name: '<本目录的绝对路径>/index.js'
      config:
        maxSwitchesPerTurn: 2
        maxSwitchesPerSession: 6
```

然后重启桌面端（或按你的 profile 热加载方式重载插件）。验证：

1. 新会话的工具列表只剩 core + `load_tools`；
2. 系统提示里有 `[tool-gating] 工具按组加载…` 目录；
3. 调 `load_tools {groups:["memory"]}`，下一步能看到 memory 组。

## 停用

删掉上面那条 insert，重启。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `groupsFile` | 本目录 `groups.json` | 换一份清单 |
| `maxSwitchesPerTurn` | 2 | 每 turn 最多加载几次（含 pre-execute 自动加载） |
| `maxSwitchesPerSession` | 6 | 每会话最多加载几次 |
| `extraCore` | `[]` | 额外常驻的工具名（不写进 groups.json 也行） |

## 自动发现（新插件不用改配置）

`groups.json` 顶层的 `auto` 控制自动归组：

```json
"auto": { "enabled": true, "exclude": ["bcdp_*", "run_code"] }
```

- 第一次建 agent 时，把「清单里没登记、但宿主里真实存在」的工具收进来：按名字第一个 `_` 之前的部分成组（`qq_send_image` → `qq` 组），同名组已存在则并进去。
- 只算一次，之后冻结——目录文本属于系统提示，中途改一次就作废一次前缀缓存。
- `exclude` 支持精确名和 `前缀*`。默认排除 `bcdp_*`（浏览器插件自己按 turn 注册/注销）和 `run_code`（强制可见的 PTC 入口）。
- 会话中途后注册的工具照旧可见、不被隐藏（`restrict` 只 deny 清单里的名字）。

## 改组清单

`groups.json` 的约束（`parseGroups` 会校验，违反直接让插件加载失败）：

- `version` 必须是 `1`；`groups` 非空。
- 工具名 `^[a-z][a-z0-9_]{1,63}$`，全局唯一（core 与各组之间也不许重复）。
- 每项必须带 `purpose`，≤ 40 字。
- `core` 必须包含 `load_tools`，否则加载入口会被自己关掉。
- 组名 `^[a-z][a-z0-9-]{0,31}$`；`core` / `none` 是「回到 L0」的保留字，不能当组名。
- `limits.maxSwitchesPerTurn` / `limits.maxSwitchesPerSession` 是正整数。

改完跑 `node tests/test-state.mjs`，再跑 `node tests/selftest.mjs`。

## 已知限制

1. **生效点是「下一步」不是「下个 turn」**。`restrict()` 在 `load_tools` 执行时立刻生效，但一步的 toolSet 是 preStep 快照，所以同一 turn 的下一步就能看见新组。计划文档里写的是 turn 边界；实测宿主按步快照，这里按真实语义实现。每次切换都会 `toolsChanged()` → 头部重写 → 缓存前缀作废，所以有预算上限。
2. **只 deny 清单里列出的工具**。第三方 / 未列入清单的工具始终可见（避免把不认识的工具藏没）。想门控就把名字加进 `groups.json`。
3. **未加载就调用会先失败一次**。pre-execute 拦下并自动加载该组，返回 error 让模型下一步重试；不静默补执行（schema 还没进模型视野）。
4. **取不到 turn 号时只做会话上限**。`agent.phase.turn` 不可用时不重置 turn 预算，避免误拦。
5. **插件 dispose 时必须能拿到 `agent.ctx`**。限制层建立在 agent 作用域上，`ctx.agents` 不可用时只清理已登记的 agent。
6. **`tools/change` 只在工具注册表变化时触发**，检测不到「同一层被别处重新注册同名工具」这类极端情况；pre-execute 里每次都重算一次台账兜底。
7. **agent 作用域注册的工具管不到**（实测，宿主规则）。`ctx.tools.restrict()` 只能限制全局工具的可见性；插件通过 `agent.ctx.tools.register()` 注册的工具落在 agent 自己的层里，宿主把它们排除在「可限制名单」外，永远可见。典型：`qq_*`、`team_task_*`/`spawn_teammate`/`wait_agent`、`proactive_*`——大约 20 来个，躲不掉。