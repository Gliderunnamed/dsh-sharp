/**
 * dsh-sharp 真实运行时集成测试
 *
 * 与 smoke.mjs 的区别：smoke 用假 ctx 验证逻辑，这里加载 app.asar 里抽出的
 * 真 cordis + 真 dsh-system-prompt，把插件挂到真实服务上跑，验证的是
 * 「契约真的会进系统提示词」「order 真的排在那一段」「真 agent/request 瀑布上
 * 真的能改配置」「作用域销毁真的会注销 section」这些只有真运行时才暴露的事。
 *
 * .runtime 是临时验证目录（从 app.asar 抽出），不存在就跳过。
 *   node tools/asar.mjs extract "<asar>" dsh/node_modules/@deepseek-ai .runtime/node_modules/@deepseek-ai
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.join(here, '..')
const runtime = path.join(pkgRoot, '.runtime', 'node_modules', '@deepseek-ai')
const load = (p) => import(pathToFileURL(p).href)

const promptEntry = path.join(runtime, 'dsh-system-prompt', 'lib', 'index.js')
if (!existsSync(promptEntry)) {
  console.log('SKIP: .runtime 未就绪（先跑 tools/asar.mjs extract）')
  process.exit(0)
}

const { Context, Service } = await load(path.join(runtime, 'cordis', 'lib', 'index.js'))
const prompt = await load(promptEntry)
const { scopeTarget } = await load(path.join(runtime, 'dsh-scope', 'lib', 'index.js'))
const sharp = await load(path.join(pkgRoot, 'lib', 'index.js'))

let pass = 0
let fail = 0
const check = (name, ok) => {
  if (ok) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}`)
  }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))

/** 极简 commands 服务替身（只要能拿到最后一次 register 的定义）。 */
class StubCommands extends Service {
  constructor(ctx) {
    super(ctx, 'commands')
    this.definition = null
  }
  register(definition) {
    this.definition = definition
    return () => {
      this.definition = null
    }
  }
}

/** 假 llm：可控地返回/抛错；'off-only-model' 用来验证地板规则。 */
const EFFORTS = ['minimal', 'low', 'high']
const OFF_ONLY = ['off', 'high']
function makeLlm() {
  const state = { behavior: 'ok', calls: 0 }
  const llm = {
    async resolveModelInfo(provider, model) {
      state.calls += 1
      if (state.behavior === 'throw') throw new Error('adapter 还没准备好')
      const ids = model === 'off-only-model' ? OFF_ONLY : EFFORTS
      return {
        provider,
        id: model,
        name: model,
        reasoning: { efforts: ids.map((id) => ({ id, name: id })), defaultEffort: 'high' },
      }
    },
  }
  return { llm, state }
}

const seed = (effort, model = 'x') =>
  Object.freeze({
    provider: 'deepseek',
    model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    temperature: 0.3,
  })

// ---------------------------------------------------------------- 第一次装配
const ctx = new Context()
ctx.plugin(prompt.default, { includeHarnessIdentity: true, includeRuntimeContext: true })
ctx.plugin(StubCommands)
const { llm, state: llmState } = makeLlm()
ctx.provide('llm', llm)
const fork = ctx.plugin(sharp, { level: 'balanced', language: 'zh' })
await tick()

const commands = ctx.get('commands')
const assemble = (agent) => ctx.systemPrompt.assemble(agent === undefined ? {} : { agent })
const rendered = async (agent) => prompt.renderPrompt(await assemble(agent))
const sectionText = async (agent) => {
  const asm = await assemble(agent)
  const hit = asm.sections.find((s) => s.name === 'dsh-sharp:contract')
  return hit === undefined ? undefined : hit.text
}

check('真 cordis Context 上 systemPrompt 服务可解析', Boolean(ctx.systemPrompt))
check('假 commands 服务可解析', typeof commands?.register === 'function')
check('插件装配后注册了 /sharp 命令', commands?.definition?.name === 'sharp')
check('契约 section 已注册到真系统提示词', typeof (await sectionText()) === 'string')
check('契约真的进了渲染后的提示词', (await rendered()).includes('第一句就是结论'))
// getSectionOrder() 只查宿主中心表（SECTION_ORDERS），查不到动态注册的 section，
// 所以顺序只能靠真排序验证：插两节 order 118/120 的探针，看契约是否夹在中间。
ctx.systemPrompt.section({ name: 'probe:below', order: 118, text: () => 'PROBE-BELOW' })
ctx.systemPrompt.section({ name: 'probe:above', order: 120, text: () => 'PROBE-ABOVE' })
{
  const names = (await assemble()).sections.map((s) => s.name)
  const iBelow = names.indexOf('probe:below')
  const iSharp = names.indexOf('dsh-sharp:contract')
  const iAbove = names.indexOf('probe:above')
  check('section order = 119（真排序：排在 118 与 120 之间）', iBelow >= 0 && iBelow < iSharp && iSharp < iAbove)
}
check('契约文本不含 {{ （否则插值会抛）', !(await sectionText()).includes('{{'))
check('宿主自身的 identity/runtime section 仍在', (await assemble()).sections.length > 1)
check('balanced.zh 每轮开销可接受（<1600 字符）', (await sectionText()).length < 1600)

const invoke = async (rawInput, agent) =>
  commands.definition.handler({ agent, rawInput, attachments: [], signal: undefined })

check('默认 status 成功', (await invoke('status', undefined)).kind === 'success')

const agentA = { id: 'sess-A' }
const agentB = { id: 'sess-B' }

// 档位联动
const before = (await sectionText(agentA)).length
invoke('hard', agentA)
const after = (await sectionText(agentA)).length
check('会话内 /sharp hard 让契约变长（档位联动）', after > before)
check('hard 档带 150 字上限', (await sectionText(agentA)).includes('150'))
invoke('lite', agentA)
check('lite 档比 balanced 短', (await sectionText(agentA)).length < before)

// 停用与恢复
invoke('off', agentA)
check('会话 off 后 section text 为空串', (await sectionText(agentA)) === '')
check('空 section 被 renderPrompt 丢弃（提示词里没有契约）', !(await rendered(agentA)).includes('第一句就是结论'))
invoke('on', agentA)
check('会话 on 恢复契约', (await rendered(agentA)).includes('第一句就是结论'))

// 真 waterfall
const dispatch = (who, s) =>
  ctx.waterfall(scopeTarget(who, who), 'agent/request', { turn: 1, step: 1, signal: undefined, agent: who }, () => Promise.resolve(s))

const lowered = await dispatch(agentA, seed('high'))
check('真 waterfall：prefer-low 把 high 降到 low', lowered.reasoningEffort === 'low')
check('真 waterfall：保留 temperature/provider/model', lowered.temperature === 0.3 && lowered.provider === 'deepseek' && lowered.model === 'x')
check('真 waterfall：返回新对象而不是改冻结的种子', lowered !== seed('high'))
check('返回值带 provider/model（否则 harness 会抛）', Boolean(lowered.provider && lowered.model))

const alreadyLow = await dispatch(agentA, seed('minimal'))
check('只降不升：已是 minimal 就不动', alreadyLow.reasoningEffort === 'minimal')

const filled = await dispatch(agentA, seed(undefined))
check('种子无 reasoningEffort 时补上 low', filled.reasoningEffort === 'low')

// 白名单全不命中时的地板规则：模型只有 off/high 时不能选 off
const floored = await dispatch(agentA, seed('high', 'off-only-model'))
check('地板规则：只有 off/high 时不把思考关掉（选 high 而非 off）', floored.reasoningEffort === 'high')
check('地板规则：确实没被改成 off', floored.reasoningEffort !== 'off')

// 模式切换
invoke('think default', agentA)
const dropped = await dispatch(agentA, seed('high'))
check('think default 删掉 reasoningEffort（回落模型默认）', !('reasoningEffort' in dropped))
check('think default 仍保留 provider/model', dropped.provider === 'deepseek' && dropped.model === 'x')

invoke('think inherit', agentA)
const keep = seed('high')
check('think inherit 完全不碰配置（同一性）', (await dispatch(agentA, keep)) === keep)

invoke('think low', agentA)
check('think low 又能降级', (await dispatch(agentA, seed('high'))).reasoningEffort === 'low')

// 会话隔离：B 走 model-default
invoke('think default', agentB)
check('会话隔离：A 被降级', (await dispatch(agentA, seed('high'))).reasoningEffort === 'low')
check('会话隔离：B 仍走 model-default', !('reasoningEffort' in (await dispatch(agentB, seed('high')))))
check('会话隔离：B 的 think default 不影响 A 的契约', (await sectionText(agentA)).includes('第一句就是结论'))

// 失败与缓存：同一个 llm 实例上切换行为；'fresh-model' 这条路由尚未被缓存过
llmState.behavior = 'throw'
const throwSeed = seed('high', 'fresh-model')
check('resolveModelInfo 抛错时静默放行（同一性）', (await dispatch(agentA, throwSeed)) === throwSeed)
llmState.behavior = 'ok'
const cached = await dispatch(agentA, seed('high', 'x'))
check('成功路由命中缓存且仍能降级', cached.reasoningEffort === 'low')
check('缓存生效：没有为同一路由重复询问 adapter', llmState.calls <= 6)

// 输出预算：把「简短」变成机械约束（maxTokens 随请求发给 provider）
invoke('normal', agentA)
const noCap = await dispatch(agentA, seed('high'))
check('balanced 不设 maxTokens（交给模型/连接默认）', !('maxTokens' in noCap))

invoke('hard', agentA)
const capped = await dispatch(agentA, seed('high'))
check('hard 档把输出上限收到 4096', capped.maxTokens === 4096)
check('hard 档同时仍把思考降到 low', capped.reasoningEffort === 'low')

const lowerSeed = Object.freeze({ provider: 'deepseek', model: 'x', reasoningEffort: 'high', maxTokens: 1024 })
check('输出上限只降不升：已有更低上限就不动', (await dispatch(agentA, lowerSeed)).maxTokens === 1024)

const higherSeed = Object.freeze({ provider: 'deepseek', model: 'x', reasoningEffort: 'high', maxTokens: 9000 })
check('现值高于上限时才收紧到 4096', (await dispatch(agentA, higherSeed)).maxTokens === 4096)

void invoke('budget 100', agentA)
const flooredBudget = await dispatch(agentA, seed('high'))
check('显式预算低于地板时被地板兜住（512）', flooredBudget.maxTokens === 512)

// /sharp off 后完全不碰配置
invoke('off', agentA)
const untouched = seed('high')
check('/sharp off 后完全不碰配置（同一性）', (await dispatch(agentA, untouched)) === untouched)

// reset 与错误分支
invoke('on', agentA)
check('/sharp reset 成功', (await invoke('reset', agentA)).kind === 'success')
check('未知子命令返回 error', (await invoke('bogus', agentA)).kind === 'error')

// 作用域销毁 -> section 注销
await fork.dispose()
await tick()
check('插件作用域销毁后 section 被注销', (await assemble()).sections.every((s) => s.name !== 'dsh-sharp:contract'))
check('销毁后宿主提示词仍可用', (await rendered()).length > 0)

// 配置关停：enabled=false 时不该出现契约
const ctx2 = new Context()
ctx2.plugin(prompt.default, {})
ctx2.plugin(sharp, { enabled: false })
await tick()
const asm2 = await ctx2.systemPrompt.assemble({})
const hit2 = asm2.sections.find((s) => s.name === 'dsh-sharp:contract')
check('enabled=false 时契约不渲染', hit2 === undefined || hit2.text === '')
check('enabled=false 时宿主提示词仍可用', Array.isArray(asm2.sections) && prompt.renderPrompt(asm2).length > 0)

console.log(`\n${pass}/${pass + fail} passed`)
if (fail > 0) process.exit(1)
