# dsh-sharp

> Make the AI in DSH get to the point: **conclusion first, blunt, short, no filler — and less wasted thinking.**

A host-side DSH plugin (no UI, no native deps, zero imports) that attacks four annoyances with three mechanisms:

| Annoyance | Mechanism |
| --- | --- |
| Long warm-up before the actual answer; restating your question | A "response contract" section injected into the system prompt (`systemPrompt.section`) |
| "First… second… finally…", three options for you to choose from | Same contract, which forbids it explicitly |
| Over-thinking questions that deserve a one-liner | Lowering `reasoningEffort` on the `agent/request` waterfall |
| Rambling the contract cannot fully stop | Capping this call's `maxTokens` on the same waterfall |

中文说明见 [README.zh.md](./README.zh.md)。

---

## 1. What it changes

### Response contract (system prompt)

Registers a section named `dsh-sharp:contract` with `order = 119` (after the persona prefix, before plan policy — the same band as dsh-pua's 120 and agent-teams' 117). Three levels:

- `lite` — 4 rules: lead with the conclusion, no restating, no pleasantries, no apologies.
- `balanced` — 12 rules (default): plus "never show reasoning drafts or alternatives", "shortest usable answer", "if underspecified, give the most likely answer then ask one key question", "say 'not sure' plainly", "code: runnable version plus one line", "don't repeat what's already known", "don't add what I didn't ask for", "don't restate tool output".
- `hard` — 17 rules: plus "prose stays under ~150 characters", "no background or theory", "if one sentence answers it, answer in one sentence", "no summary paragraph".

Measured length in characters: `lite` zh 243 / en 680 / both 925; `balanced` zh 542 / en 1588 / both 2132; `hard` zh 724 / en 2100 / both 2826. The default level costs roughly 500 characters per turn and removes far more filler than that.

When disabled, `text` returns `''` — the host's own supported opt-out (`renderPrompt` drops empty sections).

### Thinking governor (`agent/request` waterfall)

Adjusts this call's `reasoningEffort` before every request:

- `auto` (default) — follow the level: `lite` touches nothing, `balanced` / `hard` clamp low.
- `prefer-low` — clamp to a low effort. Real DeepSeek ids are `off | low | high | max` with `high` as the default, so this is a genuine, adapter-whitelisted downgrade.
- `model-default` — delete `reasoningEffort` and let the model use its declared default.
- `inherit` — touch nothing.

Three hard rules:

1. **Only lower, never raise.** If the current effort ranks no higher than the target, the original config is returned untouched.
2. **There is a floor.** When no `prefer` name matches (say a model only offers `off`/`high`), it does not fall back to "lowest ranked" — i.e. `off` — but to the lowest effort *not below* the mildest entry in `prefer`. Silently disabling reasoning is a quality incident, not "less thinking".
3. **Never break the host config.** The return value is a spread copy, so `provider` / `model` / `temperature` / `stop` all survive; the host validates that `provider`/`model` are present right after the waterfall and throws otherwise.

### Output budget (`maxTokens` on the same waterfall)

This is the only **mechanical** way to force "short" — the host exposes no hook that rewrites model output text, so the contract stays a soft constraint.

The real DeepSeek adapter defaults to `DEFAULT_MAX_TOKENS = 256e3` (256000 tokens per reply) — effectively no limit — and sends `max_tokens = options.maxTokens ?? model.maxTokens ?? connection.maxTokens`. So the `hard` level caps it at 4096:

| Budget mode | Cap |
| --- | --- |
| `auto` (default) | follow the level: `lite`/`balanced` untouched, `hard` uses `tight` |
| `inherit` | no cap, touch nothing |
| `normal` | 16384 |
| `tight` | 4096 |
| `strict` | 2048 |
| any positive integer | yours, but clamped up to the **floor 512** so a stray `budget 10` cannot truncate an answer into a fragment |

Also **lower-only**: if the call already carries a `maxTokens` (or the model declares a `defaultMaxTokens`) that is not above the cap, nothing is changed. Truncation is handled by the provider and still lands in history as usual — which is also why `llm/stream` was rejected as the enforcement point: cutting the stream mid-frame can sever a tool call.

Model capability lookups (`llm.resolveModelInfo`) are shared by both governors and cached per `provider\0model` route: successes forever (capabilities are static within a session), failures for 60 seconds so a transient "provider not registered yet" self-heals without hitting the adapter on every request. If lookup fails or throws, the governor silently passes the config through — better to do nothing than to break a conversation.

---

## 2. Install

### From GitHub (recommended)

```
plugin_manager action=install_bundle target="github:Gliderunnamed/dsh-sharp"
```

Equivalent CLI form (`dsh plugin` just forwards its arguments to the profile's pnpm):

```
dsh plugin --profile web add github:Gliderunnamed/dsh-sharp
```

Pin a revision with a ref: `github:Gliderunnamed/dsh-sharp#<commit-sha>`. `cordis.patch.yml` then `insert`s a plugin with id `sharp`. A live profile applies it **immediately, no restart**.

The repository must be reachable **anonymously**: before pnpm starts, the manager probes it with `git -c credential.helper= ls-remote -- <repo> HEAD` while disabling credential helpers and every prompt (`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=''`, `SSH_ASKPASS_REQUIRE=never`). A public repository passes with no credentials; pnpm owns authentication afterwards.

### Other targets

| Form | target |
| --- | --- |
| local directory (development) | `link:D:/dsh_work/dsh-sharp` (**absolute path required**) |
| local tarball | `D:/path/dsh-sharp-1.0.0.tgz` |
| git | `github:Gliderunnamed/dsh-sharp`, `github:Gliderunnamed/dsh-sharp#<sha>`, `git+https://github.com/Gliderunnamed/dsh-sharp.git#ref`, `git@github.com:Gliderunnamed/dsh-sharp.git` |
| npm | `@gliderunnamed/dsh-sharp` or `@gliderunnamed/dsh-sharp@1.0.0` |

`plugin-manager`'s `parseInstallSpec` decides what is accepted: after `file:` / `link:` the path must be absolute, an `https://` URL must point at a git repository or a `.tgz`, and a bare name must be a valid registry package name. Installation requires the package to declare `dsh.bundle`, otherwise it lands as a plain dependency with the warning `declares no dsh.bundle`.

**Rollback**: `plugin_manager action=remove_bundle target="dsh-sharp"`, or `set_plugin enabled=false` for `sharp`, or mute it at runtime per session with `/sharp off`.

### Why the plugin has zero imports

`link:`-installed plugins resolve bare specifiers from their **real path** (`D:\dsh_work\...`), where no `node_modules` exists — the diagnostic-tools directory carries `node_modules/@deepseek-ai/{schemastery,cosmokit,cordis}` precisely because that linked package imports them. So this plugin has **no external dependency and no import at all**; config is normalized by hand in `normalizeConfig`, there is no schemastery `Config` export, and no `config:` block in `cordis.patch.yml`.

The cost: config is adjusted at runtime via `/sharp`. The benefit: it always loads. To hard-code config, add a `config:` block to `cordis.patch.yml` (the commented example lists every key) — the code reads it either way.

---

## 3. Usage

```
/sharp                       show status (level / thinking / cap / this session's overrides)
/sharp on | off              enable / disable (off touches neither prompt nor request config)
/sharp lite|normal|hard      level (normal = balanced)
/sharp think auto            follow the level (default)
/sharp think inherit         leave effort completely alone
/sharp think low             lower effort (prefer-low)
/sharp think default         fall back to the model default
/sharp budget auto           follow the level (default)
/sharp budget off            no output cap
/sharp budget tight          cap 4096 (the hard level's default)
/sharp budget 3000           custom cap (floor 512)
/sharp why                   print this session's real route and model capability
/sharp reset                 clear this session's overrides
/sharp contract              print this session's contract text
/sharp help                  help
```

`/sharp why` is the troubleshooting command: it reads `agent.session.requestHeader()?.config` for the real provider/model and asks the adapter for capabilities. If it reports "llm service unavailable", that profile has no `llm` service, and both governors degrade to no-ops (the contract still works).

State is **per session** (`agent.id`): setting hard in session A does not affect B. A session under global `enabled: false` can be revived with `/sharp on`, overrides are dropped when the agent is disposed, and at most 512 sessions are remembered (oldest evicted first).

### Configuration (`config:` in `cordis.patch.yml`)

```yaml
enabled: true
level: balanced           # off | lite | balanced | hard
language: zh              # zh | en | both
order: 119
thinking:
  mode: auto              # auto | inherit | prefer-low | model-default
  prefer: [low, minimal]  # tried in order; the lowest rank here is also the floor
budget:
  mode: auto              # auto | inherit | normal | tight | strict | <positive integer>
  normal: 16384
  tight: 4096
  strict: 2048
  floor: 512              # no explicit cap ever goes below this
```

Invalid levels, modes, languages, orders, numbers and arrays are quietly normalized back to defaults instead of throwing.

---

## 4. Verification

```
node test/smoke.mjs        # 24/24: fake ctx, logic and edges
node test/integration.mjs  # 47/47: real cordis + real dsh-system-prompt + real waterfall
```

The integration suite runs against the real runtime extracted from `app.asar`, proving the things only a real environment exposes: the contract really lands in the rendered prompt, the order really sits between 118 and 120, empty sections really get dropped, `/sharp` toggles really propagate, scope disposal really unregisters the section, and on the real `agent/request` waterfall the config is really lowered (never raised), the `hard` level really caps `maxTokens` at 4096, and exceptions really pass through.

`.runtime/` is a temporary verification directory (cordis / dsh-system-prompt / dsh-scope / dsh-llm-deepseek extracted from `app.asar`); it is not part of the package, and the integration test SKIPs when it is missing:

```
node tools/asar.mjs extract "<DSH>\resources\app.asar" "dsh/node_modules/@deepseek-ai" ".runtime/node_modules/@deepseek-ai"
```

`tools/asar.mjs` is a tiny read-only asar reader (`list` / `size` / `extract`) that strips the prefix on extraction.

### Host details this is aligned to (each one bit us)

- `SystemPrompt#assemble(context)` is **async**; not awaiting it throws on an internal `.map`.
- The `section.text` argument is exactly the context passed to `assemble()`, which in the real host carries `agent`.
- The contract text must not contain `{{`: the host interpolator throws on malformed or unknown variables (this plugin's text has no braces at all).
- `getSectionOrder(name)` only consults the host's central `SECTION_ORDERS` table and cannot see dynamically registered sections — ordering can only be verified through real sorting.
- Registering a duplicate section name in the same scope throws `prompt section "..." is already registered`, so registration is wrapped in try/catch: worst case the prompt loses one section instead of the plugin failing to load.
- A fake ctx's `on()` must **accumulate** listeners: the 0.1.0 test fake kept only the last one, which let the budget governor overwrite the thinking governor — a single-listener assumption hides the "both governors must run" class of bug completely.

---

## 5. Known limits

- The contract is still a **prompt-level** constraint, not a hard truncation. What actually binds mechanically is `maxTokens` (and the model may finish naturally before reaching it, or ignore it on non-agent call paths such as session titling).
- `prefer-low` also lowers effort for genuinely hard reasoning. Use `/sharp think inherit` (or `model-default`) when you need long chains of thought.
- Only `reasoningEffort` and `maxTokens` are governed; `temperature` is left alone — fiddling with sampling in chat causes far more damage.
