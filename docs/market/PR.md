# 市场投稿：awesome-dsh-plugin

目标仓库 `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`，规则出自它的 `contributing.md`（**PR 只加一个文件；两个 README 由脚本生成，不要手工编辑**）。

本插件仓库：`https://github.com/Gliderunnamed/dsh-sharp`（public，创建于 `2026-10-05T12:46:55Z`）。

## 一、CI 的门（顺序：条目数 → dsh.bundle → 仓库年龄 → awesome-lint/站点构建）

| 条件 | 状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle` | ✅ `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` |
| 仓库根有非空 `cordis.patch.yml` | ✅ 695 B |
| 仓库创建满 **1 天** | ⏳ 建仓时间 `2026-10-05T12:46:55Z` ⇒ **最早北京时间 2026-10-06 20:47 之后**才能提 PR（自动检查，今天提必被拒） |
| 仓库加了 **`dsh-plugin`** topic | ⏳ 手动：仓库首页 → About 齿轮 → Topics → 填 `dsh-plugin` |
| 代码真实可用、描述与代码一致 | ✅ `npm test` = 24 + 47 个断言全过；描述只讲两个机制 |
| 一个 PR 最多 3 条 | ✅ 只提 1 条 |

## 二、唯一改动：新增 `data/plugins/Gliderunnamed__dsh-sharp.yml`

把 [Gliderunnamed__dsh-sharp.yml](Gliderunnamed__dsh-sharp.yml) 原样复制过去（分隔符是**两个下划线**）：

```yaml
url: https://github.com/Gliderunnamed/dsh-sharp
name: Gliderunnamed/dsh-sharp
category: model
description:
  en: 'Adds a numbered answering contract to the system prompt and lowers the reasoning effort and max output tokens of each call, so replies lead with the conclusion; switch levels at runtime with /sharp.'
  zh: '给系统提示词插入编号回答契约，并压低每次调用的思考档位与最大输出 token，让回答先给结论；用 /sharp 在运行时切换档位。'
```

- `url` 必须与仓库地址**完全一致**（大小写也要一致）；`name` 是列表里显示的链接文字。
- 描述加引号是为了避开 YAML 的 `: ` 与 `; ` 解析陷阱。
- 分类选 `model`：插件实际改的就是每次模型调用的 `reasoningEffort` / `maxTokens`，外加一段 system prompt 契约。官方明确说分类选不准由维护者直接改，**不会因此打回**。
- 不发 npm、没有预构建 tarball，所以不写 `tarball:`；没有 UI，也不写 `screenshots.json`。

## 三、操作步骤

先在浏览器点 **Fork**：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/fork>，得到 `https://github.com/Gliderunnamed/awesome-dsh-plugin`（下面的地址就是你自己 fork 出来那个）。

```bash
git clone https://github.com/Gliderunnamed/awesome-dsh-plugin && cd awesome-dsh-plugin
git checkout -b add-dsh-sharp
cp /path/to/Gliderunnamed__dsh-sharp.yml "data/plugins/Gliderunnamed__dsh-sharp.yml"
git add "data/plugins/Gliderunnamed__dsh-sharp.yml"
git commit -m "Add Gliderunnamed/dsh-sharp"
git push -u origin add-dsh-sharp
```

然后在 GitHub 上开 PR，标题 `Add Gliderunnamed/dsh-sharp`。不需要跑 `node scripts/generate-readme.mjs`（跑也行，但提交内容必须与数据源一致）。

## 四、PR 描述（可直接粘贴）

> **What it is.** dsh-sharp adds one ordered system-prompt section (`dsh-sharp:contract`, order 119) carrying a numbered answering contract in three levels (lite / balanced / hard), and two `agent/request` waterfall governors: one lowers `reasoningEffort` to the lowest effort the model actually advertises (never raises it, never drops to `off`), one caps `maxTokens` per call. Levels are switched at runtime with `/sharp` (`on`/`off`/`lite`/`normal`/`hard`/`think`/`budget`/`why`).
>
> **No dependencies, and no imports at all** — not even `schemastery`, so it loads from a bare checkout with no `node_modules`. No `dsh.client` (there is no UI). MIT.
>
> **Verified against the real host, not just mocks.** `npm test` runs 24 assertions on a fake context and 47 on the real `cordis` + `dsh-system-prompt` + `agent/request` waterfall extracted from `app.asar`, covering section registration and ordering, the disabled path (empty section text), the level-switch commands, and the waterfall contract (returns a new object, keeps `provider`/`model`, never mutates the frozen seed). It is installed and running in a live profile.
>
> **Description accuracy.** The "answering contract" is `lib/contract.js`; "reasoning effort" and "max output tokens" are the two `agent/request` governors in `lib/thinking.js` and `lib/budget.js`; `/sharp` is registered in `lib/command.js`.
