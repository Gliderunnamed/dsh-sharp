# Changelog

本文件记录 dsh-sharp 的对外变更。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## 1.0.1

- **包名从 `@gliderunnamed/dsh-sharp` 退回 `dsh-sharp`**。这是真踩过的坑：`link:` / git 安装时 profile 的 `node_modules` 键名取自包的 `name`，而 `cordis.patch.yml` 里 `insert` 的 `name` 必须能从 profile 解析到**同一个**包。1.0.0 改了 `name` 却没重装，于是 `import('@gliderunnamed/dsh-sharp')` 直接 `ERR_MODULE_NOT_FOUND`，那条插入项永远不激活 —— 宿主对「有条目没激活」的处置是整个 web 启动失败：`Error: web boot: 1 entry did not activate`。现在包 `name`、`cordis.patch.yml`、两份 README 的安装表三处统一为 `dsh-sharp`，与旧的 `link:` 安装和 GitHub 仓库名（`Gliderunnamed/dsh-sharp`）都自洽。
- `apply()` 整体包一层 `try/catch`：任何意外异常只写一条 `logger.error` 并把插件降级为**无操作**，绝不把宿主的加载 fiber 带崩（即不再可能因为本插件出现 `web boot: N entry did not activate`）。
- `/sharp` 命令注册同样加保护：同名命令被重复注册（插件装了两遍）时只警告，不再抛。

## 1.0.0

首个公开发布版：三条机制、零运行时依赖、48 项测试。

- **输出契约**（`systemPrompt.section`，`order = 119`）：`lite` 4 条 / `balanced` 12 条（默认）/ `hard` 17 条中文与英文两套规则；停用时 `text` 返回空串，由宿主的 `renderPrompt` 丢弃该节。
- **思考治理**（`agent/request` 瀑布）：`auto`（默认，跟随档位）/ `prefer-low` / `model-default` / `inherit`；只降不升，白名单全未命中时有地板防止把思考降成 `off`；模型能力按 `provider\0model` 缓存（成功永久、失败 60 秒）。
- **输出上限**（同一个瀑布上的 `maxTokens`）：把「简短」变成机械约束。DeepSeek adapter 默认 `DEFAULT_MAX_TOKENS = 256e3`，`hard` 档收紧到 4096；`auto` / `inherit` / `normal`(16384) / `tight`(4096) / `strict`(2048) / 任意正整数，地板 512；同样只降不升。
- **`/sharp` 命令**：`status` / `on` / `off` / `lite|normal|hard` / `think ...` / `budget ...` / `why` / `reset` / `contract` / `help`，状态按会话隔离，超过 512 个会话按最老淘汰。
- 宿主缺 `systemPrompt` 时只打警告不让插件加载失败；缺 `llm` / `commands` 时对应能力自动降级为 no-op。
- 测试：`test/smoke.mjs` 24 项（假 ctx）；`test/integration.mjs` 24 项（从 `app.asar` 抽出的真 cordis + 真 `dsh-system-prompt` + 真 waterfall，缺 `.runtime/` 时自动 SKIP）。

## 0.2.0

- 新增输出上限治理器（`maxTokens`）与 `/sharp budget`、`/sharp why`。
- 思考模式新增 `auto` 并改为默认：由档位推导而不再一律压最低档。
- 契约规则 balanced 10 → 12 条、hard 14 → 17 条。
- 修 0.1.0 的测试假 ctx 只保留最后一个监听器、导致「预算治理器覆盖思考治理器」的 bug 被隐藏的问题。

## 0.1.0

- 初版：输出契约 + 思考治理器 + `/sharp` 命令；20 项冒烟测试 + 41 项集成测试。
