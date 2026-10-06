# dsh-sharp

> 让 DSH 里的 AI 说人话：**先给结论、直白简短、不绕弯子、少废话思考。**

一个纯宿主侧（无 UI、无原生依赖、零 import）的 DSH 插件，用三条机制治四件事：

| 痛点 | 机制 |
| --- | --- |
| 铺垫一堆才说重点、复述你的问题、车轱辘话 | 往系统提示词插一节「回答契约」（`systemPrompt.section`） |
| 又要「首先其次最后」、又列三种方案让你自己挑 | 同上，契约里明确禁止 |
| 该秒答的问题想半天（多余思考） | 在 `agent/request` 瀑布上把 `reasoningEffort` 压到低档 |
| 契约拦不住的啰嗦（写小作文） | 在同一个瀑布上把这次调用的 `maxTokens` 收到上限 |

---

## 一、它到底改了什么

### 1. 输出契约（系统提示词）

在系统提示词里注册一节 `dsh-sharp:contract`，`order = 119`（落在 persona 前缀之后、计划策略之前，和 dsh-pua 的 120、agent-teams 的 117 同一带）。三档规则数：

- `lite` —— 4 条：先给结论、不复述、不寒暄、不道歉。
- `balanced` —— 12 条（默认）：再加「不展示思考草稿与备选方案」「默认给最短可用答案」「信息不足先给最可能答案再问一个最关键问题」「不确定就直说」「代码只给可运行版本+一行说明」「不重复已知信息」「不追加没问的内容」「不复述工具输出」。
- `hard` —— 17 条：再加「正文默认不超过 150 字」「不给背景/原理」「一句话能答完就一句话」「不写总结段」。

实测正文长度（字符）：`lite` zh 243 / en 680 / both 925；`balanced` zh 542 / en 1588 / both 2132；`hard` zh 724 / en 2100 / both 2826。默认档每轮多花 500 字符左右，换掉的车轱辘话远超这个数。

停用时 `text` 返回空串 —— 这是宿主官方认可的退出方式（`renderPrompt` 会把空 section 直接丢掉）。

### 2. 思考治理（`agent/request` 瀑布）

在每次请求前调整这次调用的 `reasoningEffort`：

- `auto`（默认）—— 跟着档位走：`lite` 不动，`balanced` / `hard` 压到低档。
- `prefer-low` —— 把档位压到该模型支持的**低档**。真 DeepSeek 的档位是 `off | low | high | max`、默认 `high`，所以这是一次真实、被 adapter 白名单认可的降级。
- `model-default` —— 删掉 `reasoningEffort`，让模型用自己声明的默认档位。
- `inherit` —— 完全不碰。

三条硬约束：

1. **只降不升**。当前档位语义排名不高于目标时原样返回，绝不上调。
2. **有地板**。白名单一个都没命中时（例如模型只给 `off`/`high`），不会退化成「排名最小」→ 挑到 `off`，而是挑「不低于白名单里最温和那一项」的档位。把思考彻底关掉是质量事故，不是「少想一点」。
3. **永不破坏宿主配置**。返回值用展开复制，`provider` / `model` / `temperature` / `stop` 全部保留 —— 宿主在 `agent/request` 之后会校验 `provider`/`model` 存在，丢了就直接抛错。

### 3. 输出预算（同一个瀑布上的 `maxTokens`）

这是唯一能**机械**强制「短」的手段 —— 因为宿主没有「改写模型输出文本」的钩子，契约只是软约束。

真 DeepSeek adapter 的默认值是 `DEFAULT_MAX_TOKENS = 256e3`（单次回复 256000 tokens），也就是**约等于没有上限**；`max_tokens = options.maxTokens ?? model.maxTokens ?? connection.maxTokens`。所以本插件的 `hard` 档把它收到 4096：

| 预算模式 | 上限 |
| --- | --- |
| `auto`（默认） | 跟着档位：`lite`/`balanced` 不动，`hard` 用 `tight` |
| `inherit` | 不设上限，完全不动 |
| `normal` | 16384 |
| `tight` | 4096 |
| `strict` | 2048 |
| 任意正整数 | 你说了算，但会被**地板 512** 兜住（防止手抖写出 `budget 10` 把回答截成残句） |

同样**只降不升**：这次调用已有的 `maxTokens`（或模型声明的 `defaultMaxTokens`）已经不大于上限时，一个字都不改。截断由 provider 处理并照常进入历史，不会切坏工具调用帧 —— 这也是没有选择在 `llm/stream` 上硬切流的原因。

模型能力查询（`llm.resolveModelInfo`）两个治理器共用一份缓存，按 `provider\0model` 路由：成功永久缓存（一次会话内模型能力是静态的），失败只缓存 60 秒，让「provider 还没注册好」这类瞬时故障自愈，又不至于每个请求都去打一次 adapter。查不到或抛错就静默放行 —— 治理器宁可不管，也不许把对话搞崩。

---

## 二、安装

### 从 GitHub 安装（推荐）

```
plugin_manager action=install_bundle target="github:Gliderunnamed/dsh-sharp"
```

等价 CLI 写法（`dsh plugin` 只是把参数转发给 profile 里的 pnpm）：

```
dsh plugin --profile web add github:Gliderunnamed/dsh-sharp
```

想钉住版本就带 ref：`github:Gliderunnamed/dsh-sharp#<commit-sha>`。装完 `cordis.patch.yml` 会 `insert` 一个 id 为 `sharp` 的插件；live profile **立即生效，不用重启**。

仓库必须能**匿名访问**：pnpm 启动前，管理器会用 `git -c credential.helper= ls-remote -- <repo> HEAD` 探一次，同时关掉凭据助手与所有交互提示（`GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=''`、`SSH_ASKPASS_REQUIRE=never`）。公开仓库零凭据即可过，之后的认证由 pnpm 接管。

### 其他 target 写法

| 方式 | target |
| --- | --- |
| 本地目录（开发用） | `link:D:/dsh_work/dsh-sharp`（**必须是绝对路径**） |
| 本地 tarball | `D:/path/dsh-sharp-1.0.0.tgz` |
| git | `github:Gliderunnamed/dsh-sharp`、`github:Gliderunnamed/dsh-sharp#<sha>`、`git+https://github.com/Gliderunnamed/dsh-sharp.git#ref`、`git@github.com:Gliderunnamed/dsh-sharp.git` |
| npm | `dsh-sharp` 或 `dsh-sharp@1.0.1` |

可接受的写法由 `plugin-manager` 的 `parseInstallSpec` 决定：`file:` / `link:` 后面必须是绝对路径，`https://` 必须指向 git 仓库或 `.tgz`，裸名字必须是 registry 认可的包名。安装要求包声明了 `dsh.bundle`，否则只会当成普通依赖装上并警告 `declares no dsh.bundle`。

**回滚**：`plugin_manager action=remove_bundle target="dsh-sharp"`；或把 `sharp` 插件 `set_plugin enabled=false`；运行时也可以 `/sharp off` 临时静音（会话级）。

### 为什么插件里没有任何 import

`link:` 方式安装的插件按**真实路径**解析裸模块（`D:\dsh_work\...`），而那个位置没有 `node_modules` —— 诊断工具目录下存在 `node_modules/@deepseek-ai/{schemastery,cosmokit,cordis}`，正是因为那个被链接的包 import 了它们。所以本插件**零外部依赖、零 import**，配置手工归一化（`normalizeConfig`），也没有 schemastery `Config` 导出、`cordis.patch.yml` 里没有 `config:` 块。

代价是配置只能用 `/sharp` 在运行时调；收益是它一定加载得起来。要写死配置，就在 `cordis.patch.yml` 的 `config:` 块里写（注释里有全部键名和示例），代码照样读。

---

## 三、使用

```
/sharp                       看当前状态（档位 / 思考 / 上限 / 本会话覆盖）
/sharp on | off              开 / 关（关掉后完全不碰提示词和请求配置）
/sharp lite|normal|hard      切档（normal = balanced）
/sharp think auto            跟着档位走（默认）
/sharp think inherit         完全不碰思考档位
/sharp think low             压低思考档位（prefer-low）
/sharp think default         回落到模型默认档位
/sharp budget auto           跟着档位走（默认）
/sharp budget off            不限制输出长度
/sharp budget tight          上限 4096（hard 档默认）
/sharp budget 3000           自定义上限（地板 512）
/sharp why                   打印本会话真实路由与模型能力（用了哪个 provider/model、支持哪些思考档、默认上限多少）
/sharp reset                 清掉本会话的临时设置
/sharp contract              打印当前会话的契约全文
/sharp help                  帮助
```

`/sharp why` 是排障用的：它读 `agent.session.requestHeader()?.config` 拿当前真实 provider/model，再去问 adapter 要能力表。如果它说「llm 服务不可用」，说明这个 profile 没加载 `llm`，思考与预算两个治理器会自动变成 no-op（契约照常工作）。

状态是**按会话**存的（`agent.id`），A 会话调成 hard 不会影响 B 会话；全局 `enabled: false` 的会话里 `/sharp on` 能单独救回来；会话销毁时自动清理；最多记住 512 个会话（超出按最老淘汰）。

### 配置（`cordis.patch.yml` 的 `config:`）

```yaml
enabled: true
level: balanced           # off | lite | balanced | hard
language: zh              # zh | en | both
order: 119
thinking:
  mode: auto              # auto | inherit | prefer-low | model-default
  prefer: [low, minimal]  # 依次尝试的名字；全部未命中时用其最低排名当地板
budget:
  mode: auto              # auto | inherit | normal | tight | strict | <正整数>
  normal: 16384
  tight: 4096
  strict: 2048
  floor: 512              # 任何显式上限都不会低于它
```

非法的档位/模式/语言/order/数字/数组都会被安静地归一化回默认值，不抛错。

---

## 四、验证

```
node test/smoke.mjs        # 24/24：假 ctx，验证逻辑与边界
node test/integration.mjs  # 47/47：真 cordis + 真 dsh-system-prompt + 真 waterfall
```

集成测试从 `app.asar` 里抽出的真运行时上跑，证明的是只有真环境才暴露的事：契约真的进了渲染后的提示词、order 真的夹在 118 与 120 之间、空 section 真的被丢弃、`/sharp` 开关真的联动、作用域销毁真的注销 section、真 `agent/request` 瀑布上真的改配置且只降不升、真瀑布上 `hard` 档真的把 `maxTokens` 收到 4096、抛错真的静默放行。

`.runtime/` 是临时验证目录（从 `app.asar` 抽出的 cordis / dsh-system-prompt / dsh-scope / dsh-llm-deepseek），不属于插件产物，缺失时集成测试自动 SKIP：

```
node tools/asar.mjs extract "<DSH>\resources\app.asar" "dsh/node_modules/@deepseek-ai" ".runtime/node_modules/@deepseek-ai"
```

`tools/asar.mjs` 是自带的极简只读 asar 读取器（`list` / `size` / `extract`），提取时剥掉前缀。

### 对齐宿主的几处细节（都踩过）

- `SystemPrompt#assemble(context)` 是 **async** 的；不 await 会在内部 `.map` 上抛。
- `section.text` 的入参就是 `assemble()` 收到的那个 context 对象，真实宿主里含 `agent`。
- 契约文本里**不能出现 `{{`**：宿主的插值器对畸形/未注册变量会抛错（本插件文本里没有任何花括号）。
- `getSectionOrder(name)` 只查宿主中心表 `SECTION_ORDERS`，查不到动态注册的 section —— 顺序只能用真排序验证。
- 同一个 scope 里注册重名 section 会抛 `prompt section "..." is already registered`，所以注册包了 try/catch，最坏情况只是少一节提示词，绝不让插件起不来。
- 假 ctx 的 `on()` 必须**累积**监听器：0.1.0 的测试假 ctx 只留最后一个监听器，于是预算治理器把思考治理器覆盖掉了 —— 单监听器假设会让「两个治理器同时工作」的 bug 完全隐形。

---

## 五、已知限制

- 契约仍然是**提示词层**的约束，不是硬截断。真正机械生效的是 `maxTokens`（模型可能在这之前就自然结束，也可能在别的调用路径上不受影响，例如会话标题这类非 agent 请求）。
- `prefer-low` 会把复杂推理也一起降到低档。需要长链路推理时用 `/sharp think inherit`（或 `model-default`）。
- 只治理 `reasoningEffort` 与 `maxTokens`，不动 `temperature` —— 聊天里乱动采样温度更容易翻车。
