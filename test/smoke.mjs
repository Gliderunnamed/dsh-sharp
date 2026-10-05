/**
 * dsh-sharp 冒烟测试：不依赖 cordis，用一个假 ctx 把整条链路跑一遍。
 *
 *   node test/smoke.mjs
 *
 * 假 ctx 里 `on()` 按事件**累积**监听器（真 cordis 也是多监听器），
 * 并用 `request()` 模拟 waterfall 的 next 链 —— 否则两个治理器会互相覆盖，
 * 这正是 0.2.0 第一次跑测试时踩到的坑。
 */

import assert from 'node:assert/strict'

import { apply, normalizeConfig, DEFAULT_CONFIG, SECTION_NAME } from '../lib/index.js'
import { describeLevel, renderContract } from '../lib/contract.js'
import { listEfforts, pickLowerEffort, rankOf } from '../lib/thinking.js'
import { createModelInfoCache } from '../lib/model-info.js'
import { BUDGET_MODES, normalizeBudgetMode, pickBudgetCap } from '../lib/budget.js'
import { LEVEL_DEFAULTS, SharpState, THINK_MODES, normalizeLevel, normalizeThinkMode } from '../lib/state.js'
import { sessionKey } from '../lib/session.js'

let passed = 0
const checks = []
function test(label, fn) {
  checks.push([label, fn])
}

/** 模型声明：4 档思考 + 8192 默认输出上限。 */
const FULL_EFFORTS = {
  reasoning: {
    efforts: [{ id: 'minimal' }, { id: 'low' }, { id: 'medium' }, { id: 'high' }],
    defaultEffort: 'medium',
  },
  defaultMaxTokens: 8192,
}

function makeCtx(modelInfo = FULL_EFFORTS) {
  const listeners = new Map()
  const sections = []
  const registered = []
  const log = []
  const disposers = []
  const llm = {
    calls: 0,
    behavior: 'ok',
    async resolveModelInfo() {
      llm.calls += 1
      if (llm.behavior === 'throw') throw new Error('boom')
      return modelInfo
    },
  }
  const commands = {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  }
  const systemPrompt = {
    section(definition) {
      sections.push(definition)
      return () => {}
    },
  }

  const ctx = {
    logger: { info: (m) => log.push(['info', m]), warn: (m) => log.push(['warn', m]) },
    systemPrompt,
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {}
    },
    emit() {},
    effect(fn) {
      disposers.push(fn())
      return () => {}
    },
    get(service) {
      if (service === 'llm') return llm
      if (service === 'commands') return commands
      return undefined
    },
  }

  return { ctx, listeners, sections, registered, log, disposers, llm }
}

/** 按真 cordis 的 waterfall 语义跑 `agent/request` 的整条监听链。 */
function request(ctxHost, payload, inner) {
  const handlers = ctxHost.listeners.get('agent/request') ?? []
  const step = (i) => (i >= handlers.length ? inner() : handlers[i](payload, () => step(i + 1)))
  return step(0)
}

const agent = (id) => ({ id })

// ---------------------------------------------------------------- config ----

test('normalizeConfig 给默认值（档位 + auto + 预算表）', () => {
  const c = normalizeConfig(undefined)
  assert.equal(c.enabled, true)
  assert.equal(c.level, 'balanced')
  assert.equal(c.language, 'zh')
  assert.equal(c.order, DEFAULT_CONFIG.order)
  assert.equal(c.thinking.mode, 'auto')
  assert.deepEqual(c.thinking.prefer, ['low', 'minimal'])
  assert.equal(c.budget.mode, 'auto')
  assert.equal(c.budget.normal, 16384)
  assert.equal(c.budget.tight, 4096)
  assert.equal(c.budget.strict, 2048)
  assert.equal(c.budget.floor, 512)
})

test('normalizeConfig 接受覆盖并容错', () => {
  const c = normalizeConfig({
    enabled: false,
    level: 'HARD',
    language: 'en-US',
    order: '7',
    thinking: { mode: 'model-default', prefer: ['none', '', 5] },
    budget: { mode: 'strict', tight: '2048' },
  })
  assert.equal(c.enabled, false)
  assert.equal(c.level, 'hard')
  assert.equal(c.language, 'en')
  assert.equal(c.order, 7)
  assert.equal(c.thinking.mode, 'model-default')
  assert.deepEqual(c.thinking.prefer, ['none'])
  assert.equal(c.budget.mode, 'strict')
  assert.equal(c.budget.tight, 2048)

  const junk = normalizeConfig({ level: '???', language: 42, thinking: 'nope', budget: 'nope' })
  assert.equal(junk.level, 'balanced')
  assert.equal(junk.language, 'zh')
  assert.equal(junk.thinking.mode, 'auto')
  assert.equal(junk.budget.mode, 'auto')
  assert.equal(normalizeConfig({ budget: { normal: -5 } }).budget.normal, 16384)
})

test('normalizeLevel / normalizeThinkMode / normalizeBudgetMode', () => {
  assert.equal(normalizeLevel('OFF'), 'off')
  assert.equal(normalizeLevel('Lite'), 'lite')
  assert.equal(normalizeLevel('normal'), 'balanced')
  assert.equal(normalizeLevel('strict'), 'hard')
  assert.equal(normalizeLevel('nope'), undefined)

  assert.equal(normalizeThinkMode('auto'), 'auto')
  assert.equal(normalizeThinkMode('level'), 'auto')
  assert.equal(normalizeThinkMode('low'), 'prefer-low')
  assert.equal(normalizeThinkMode('default'), 'model-default')
  assert.equal(normalizeThinkMode('keep'), 'inherit')
  assert.equal(normalizeThinkMode('nope'), undefined)

  assert.equal(normalizeBudgetMode('auto'), 'auto')
  assert.equal(normalizeBudgetMode('off'), 'inherit')
  assert.equal(normalizeBudgetMode('tight'), 'tight')
  assert.equal(normalizeBudgetMode('3000'), 3000)
  assert.equal(normalizeBudgetMode(3000), 3000)
  assert.equal(normalizeBudgetMode(-1), undefined)
  assert.equal(normalizeBudgetMode('nope'), undefined)

  assert.deepEqual(THINK_MODES, ['auto', 'inherit', 'prefer-low', 'model-default'])
  assert.deepEqual(BUDGET_MODES, ['auto', 'inherit', 'normal', 'tight', 'strict'])
})

test('档位自带的默认值是一张明表', () => {
  assert.deepEqual(LEVEL_DEFAULTS.lite, { think: 'inherit', budget: 'inherit' })
  assert.deepEqual(LEVEL_DEFAULTS.balanced, { think: 'prefer-low', budget: 'inherit' })
  assert.deepEqual(LEVEL_DEFAULTS.hard, { think: 'prefer-low', budget: 'tight' })
})

// -------------------------------------------------------------- contract ----

test('renderContract 三档 + 语言 + 条数', () => {
  const lite = renderContract('lite', 'zh')
  assert.ok(lite.includes('# 回答契约'))
  assert.ok(lite.includes('1. '))
  assert.ok(!lite.includes('150 字'))

  const balanced = renderContract('balanced', 'zh')
  assert.ok(balanced.includes('12. '))
  assert.ok(!balanced.includes('13. '))

  const hard = renderContract('hard', 'zh')
  assert.ok(hard.includes('150 字'))
  assert.ok(hard.includes('17. '))
  assert.ok(!hard.includes('18. '))

  const en = renderContract('balanced', 'en')
  assert.ok(en.includes('# Answer contract'))
  assert.ok(!en.includes('回答契约'))

  const both = renderContract('balanced', 'both')
  assert.ok(both.includes('# 回答契约'))
  assert.ok(both.includes('# Answer contract'))

  // 未知档位回落到 balanced，不抛
  assert.ok(renderContract('nonsense', 'zh').includes('12. '))

  assert.ok(describeLevel('hard').includes('17 条'))
  assert.ok(describeLevel('lite').includes('4 条'))
  assert.ok(describeLevel('balanced').includes('12 条'))
})

test('contract 文本保持精简（每轮都要带上）', () => {
  assert.ok(renderContract('balanced', 'zh').length < 800, `balanced 太长：${renderContract('balanced', 'zh').length}`)
  assert.ok(renderContract('hard', 'zh').length < 1500, `hard 太长：${renderContract('hard', 'zh').length}`)
  assert.ok(!renderContract('hard', 'zh').includes('{{'), '契约里不能出现 {{ 插值语法')
})

// -------------------------------------------------------------- thinking ----

test('rankOf / listEfforts', () => {
  assert.equal(rankOf('off'), 0)
  assert.equal(rankOf('minimal'), 1)
  assert.equal(rankOf('LOW'), 2)
  assert.equal(rankOf('high'), 4)
  assert.equal(rankOf('whatever'), 3)
  assert.deepEqual(listEfforts(FULL_EFFORTS), ['minimal', 'low', 'medium', 'high'])
  assert.deepEqual(listEfforts({}), [])
  assert.deepEqual(listEfforts(undefined), [])
})

test('pickLowerEffort：先 prefer 精确命中，再语义最低（有地板）', () => {
  const info = FULL_EFFORTS
  assert.equal(pickLowerEffort(info, ['low', 'minimal']), 'low')
  assert.equal(pickLowerEffort(info, ['minimal', 'low']), 'minimal')
  // 白名单全未命中 -> 语义最低，但不得低于白名单本身的地板
  assert.equal(pickLowerEffort(info, ['medium']), 'medium')
  const onlyOff = { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }
  assert.equal(pickLowerEffort(onlyOff, ['low', 'minimal']), 'high', 'off 是质量事故，不能被当兜底')
  assert.equal(pickLowerEffort(onlyOff, ['off']), 'off', '显式要求 off 才给 off')
  assert.equal(pickLowerEffort({}, ['low']), undefined)
})

// ---------------------------------------------------------------- budget ----

test('pickBudgetCap：只降不升 + 地板', () => {
  assert.equal(pickBudgetCap({ cap: 4096, floor: 512 }), 4096)
  assert.equal(pickBudgetCap({ cap: 100, floor: 512 }), 512, '地板要兜住')
  assert.equal(pickBudgetCap({ cap: 4096, floor: 512, current: 1024 }), undefined, '现值更低就不动')
  assert.equal(pickBudgetCap({ cap: 4096, floor: 512, modelDefault: 2048 }), undefined, '模型默认更低就不动')
  assert.equal(pickBudgetCap({ cap: 4096, floor: 512, modelDefault: 8192 }), 4096)
  assert.equal(pickBudgetCap({ cap: 0, floor: 512 }), undefined)
})

// ------------------------------------------------------------ model-info ----

test('createModelInfoCache：成功永久命中，失败只短暂记忆', async () => {
  const llm = {
    calls: 0,
    behavior: 'ok',
    async resolveModelInfo() {
      llm.calls += 1
      if (llm.behavior === 'throw') throw new Error('boom')
      return FULL_EFFORTS
    },
  }
  const cache = createModelInfoCache(llm)

  assert.equal(await cache.get('p', 'm'), FULL_EFFORTS)
  assert.equal(llm.calls, 1)
  await cache.get('p', 'm')
  assert.equal(llm.calls, 1, '成功结果应当永久命中')
  assert.equal(cache.size, 1)

  // 非法路由不去问 adapter
  assert.equal(await cache.get('', 'm'), null)
  assert.equal(await cache.get('p', undefined), null)
  assert.equal(llm.calls, 1)

  // 另一个路由失败 -> null，且在 TTL 内不再问
  llm.behavior = 'throw'
  assert.equal(await cache.get('p', 'fresh'), null)
  assert.equal(await cache.get('p', 'fresh'), null)
  assert.equal(llm.calls, 2, '失败结果短时间内只问一次')

  cache.dispose()
  assert.equal(cache.size, 0)
})

// ------------------------------------------------------- session / state ----

test('sessionKey 多路探测', () => {
  assert.equal(sessionKey({ id: 'a' }), 'a')
  assert.equal(sessionKey({ session: { id: 'b' } }), 'b')
  assert.equal(sessionKey({ session: { sessionId: 'c' } }), 'c')
  assert.equal(sessionKey({ sessionId: 'd' }), 'd')
  assert.equal(sessionKey({ id: '' }), undefined)
  assert.equal(sessionKey(undefined), undefined)
})

test('SharpState：auto 随档位解析 + 覆盖优先 + 回落', () => {
  const state = new SharpState(normalizeConfig(undefined))
  assert.equal(state.level('s1'), 'balanced')
  assert.equal(state.thinkMode('s1'), 'prefer-low', 'balanced 的 auto -> prefer-low')
  assert.equal(state.budgetMode('s1'), 'inherit', 'balanced 的 auto -> 不限')
  assert.equal(state.describe('s1').thinkAuto, true)

  assert.equal(state.setLevel('s1', 'hard'), true)
  assert.equal(state.thinkMode('s1'), 'prefer-low')
  assert.equal(state.budgetMode('s1'), 'tight')

  assert.equal(state.setLevel('s1', 'lite'), true)
  assert.equal(state.thinkMode('s1'), 'inherit', 'lite 不动思考')
  assert.equal(state.budgetMode('s1'), 'inherit')

  assert.equal(state.setThinkMode('s1', 'model-default'), true)
  assert.equal(state.thinkMode('s1'), 'model-default')
  assert.equal(state.describe('s1').thinkAuto, false)

  assert.equal(state.setBudgetMode('s1', 3000), true)
  assert.equal(state.budgetMode('s1'), 3000)
  assert.equal(state.setBudgetMode('s1', 'auto'), true)
  assert.equal(state.budgetMode('s1'), 'inherit', '回到 lite 的 auto -> 不限')

  // 拿不到会话标识 -> 写入失败，但读仍然可用（回落全局默认）
  assert.equal(state.setLevel(undefined, 'hard'), false)
  assert.equal(state.level(undefined), 'balanced')

  assert.equal(state.reset('s1'), true)
  assert.equal(state.reset('s1'), false)
  assert.equal(state.describe('s1').overridden, false)
})

test('全局停用可被会话覆盖救回', () => {
  const state = new SharpState(normalizeConfig({ enabled: false }))
  assert.equal(state.active('s1'), false)
  assert.equal(state.setLevel('s1', 'hard'), true)
  assert.equal(state.active('s1'), true)
  assert.equal(state.setLevel('s1', 'off'), true)
  assert.equal(state.active('s1'), false)
})

test('会话覆盖表有上限，不会无限增长', () => {
  const state = new SharpState(normalizeConfig(undefined))
  for (let i = 0; i < 600; i += 1) state.setLevel(`s${i}`, 'hard')
  assert.equal(state.describe('s599').sessionCount, 512)
  assert.equal(state.describe('s0').overridden, false, '最老的应当被淘汰')
  assert.equal(state.describe('s599').overridden, true)
})

// ----------------------------------------------------------------- apply ----

test('apply 注册 section + command + 两个瀑布监听 + 两个 disposer', () => {
  const h = makeCtx()
  apply(h.ctx, undefined)

  assert.equal(h.sections.length, 1)
  assert.equal(h.sections[0].name, SECTION_NAME)
  assert.equal(h.sections[0].order, 119)
  assert.equal(h.registered.length, 1)
  assert.equal(h.registered[0].name, 'sharp')
  assert.deepEqual([...h.listeners.keys()].sort(), ['agent/disposed', 'agent/request'])
  assert.equal(h.listeners.get('agent/request').length, 2, '思考治理器 + 输出预算治理器')
  assert.equal(h.disposers.length, 2)
  assert.ok(h.log.some(([level]) => level === 'info'))
})

test('section text 跟会话档位联动，停用时是空串', async () => {
  const h = makeCtx()
  apply(h.ctx, undefined)
  const text = h.sections[0]
  const me = agent('s1')

  assert.ok(text.text({ agent: me }).includes('12. '))
  await h.registered[0].handler({ agent: me, rawInput: 'hard', attachments: [], signal: undefined })
  assert.ok(text.text({ agent: me }).includes('17. '))
  await h.registered[0].handler({ agent: me, rawInput: 'lite', attachments: [], signal: undefined })
  assert.ok(text.text({ agent: me }).includes('4. '))
  await h.registered[0].handler({ agent: me, rawInput: 'off', attachments: [], signal: undefined })
  assert.equal(text.text({ agent: me }), '', '空串 = 官方退出方式，renderPrompt 会丢弃')
  // 没有 agent（拿不到会话）时走全局默认
  assert.ok(text.text(undefined).includes('12. '))
})

test('瀑布：思考压到最低档，只降不升，不丢其他字段', async () => {
  const h = makeCtx()
  apply(h.ctx, undefined)
  const me = agent('s1')
  const payload = { agent: me, turn: 1, step: 1, signal: undefined }

  const lowered = await request(h, payload, async () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' }))
  assert.equal(lowered.reasoningEffort, 'low')
  assert.equal(lowered.provider, 'p')
  assert.equal(lowered.model, 'm')

  const alreadyLow = { provider: 'p', model: 'm', reasoningEffort: 'minimal' }
  assert.equal(await request(h, payload, async () => alreadyLow), alreadyLow, '已经更低就原样返回')

  const implicit = await request(h, payload, async () => ({ provider: 'p', model: 'm' }))
  assert.equal(implicit.reasoningEffort, 'low', '没写 effort 时也要压')

  const rich = await request(h, payload, async () => ({
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
    temperature: 0.2,
    stop: ['x'],
  }))
  assert.equal(rich.temperature, 0.2)
  assert.deepEqual(rich.stop, ['x'])
})

test('瀑布：hard 档收紧输出上限，balanced 不动', async () => {
  const h = makeCtx()
  apply(h.ctx, undefined)
  const me = agent('s1')
  const payload = { agent: me, turn: 1, step: 1, signal: undefined }
  const run = async (rawInput, base) => {
    await h.registered[0].handler({ agent: me, rawInput, attachments: [], signal: undefined })
    return request(h, payload, async () => base)
  }

  const balanced = await run('normal', { provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.equal('maxTokens' in balanced, false, 'balanced 不设上限')

  const hard = await run('hard', { provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.equal(hard.maxTokens, 4096)
  assert.equal(hard.reasoningEffort, 'low')

  const alreadyTight = await run('hard', { provider: 'p', model: 'm', reasoningEffort: 'low', maxTokens: 1024 })
  assert.equal(alreadyTight.maxTokens, 1024, '现值更低就不动')

  const explicit = await run('budget 3000', { provider: 'p', model: 'm', reasoningEffort: 'low' })
  assert.equal(explicit.maxTokens, 3000)

  const floored = await run('budget 100', { provider: 'p', model: 'm', reasoningEffort: 'low' })
  assert.equal(floored.maxTokens, 512, '地板兜住')

  const unlimited = await run('budget off', { provider: 'p', model: 'm', reasoningEffort: 'low' })
  assert.equal('maxTokens' in unlimited, false)
})

test('瀑布：模式切换（default / inherit / off / on）', async () => {
  const h = makeCtx()
  apply(h.ctx, undefined)
  const me = agent('s1')
  const payload = { agent: me, turn: 1, step: 1, signal: undefined }
  const cmd = (rawInput) => h.registered[0].handler({ agent: me, rawInput, attachments: [], signal: undefined })
  const base = async () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' })

  await cmd('think default')
  const dropped = await request(h, payload, base)
  assert.equal('reasoningEffort' in dropped, false)
  assert.equal(dropped.provider, 'p')

  await cmd('think inherit')
  const kept = await request(h, payload, base)
  assert.equal(kept.reasoningEffort, 'high')

  await cmd('off')
  assert.equal((await request(h, payload, base)).reasoningEffort, 'high')

  await cmd('on')
  assert.equal((await request(h, payload, base)).reasoningEffort, 'high', 'think 仍是 inherit')

  await cmd('think low')
  assert.equal((await request(h, payload, base)).reasoningEffort, 'low')
})

test('瀑布：模型没有 reasoning / resolveModelInfo 抛错 / next 抛错都不外泄', async () => {
  const h = makeCtx({ context: { contextWindow: 128000 } })
  apply(h.ctx, undefined)
  const me = agent('s1')
  const payload = { agent: me, turn: 1, step: 1, signal: undefined }

  const seed = { provider: 'p', model: 'm', reasoningEffort: 'high' }
  assert.equal(await request(h, payload, async () => seed), seed, '没有 reasoning 声明时对象同一')

  h.llm.behavior = 'throw'
  const fresh = { provider: 'p', model: 'fresh', reasoningEffort: 'high' }
  assert.equal(await request(h, payload, async () => fresh), fresh, '解析失败静默放行')

  await assert.rejects(() => request(h, payload, async () => { throw new Error('inner') }), /inner/)
})

test('thinking.mode=inherit 时仍然挂监听，但每个请求都不改配置', async () => {
  const h = makeCtx()
  apply(h.ctx, { thinking: { mode: 'inherit' } })
  assert.equal(h.listeners.get('agent/request').length, 2, '监听器必须挂着，否则 /sharp think 无法在运行时生效')

  const seed = { provider: 'p', model: 'm', reasoningEffort: 'high' }
  assert.equal(await request(h, { agent: agent('s1') }, async () => seed), seed)
})

test('agent/disposed 会清理会话覆盖', async () => {
  const h = makeCtx()
  apply(h.ctx, undefined)
  const me = agent('s1')
  await h.registered[0].handler({ agent: me, rawInput: 'hard', attachments: [], signal: undefined })
  assert.equal(h.sections[0].text({ agent: me }).includes('17. '), true)

  h.listeners.get('agent/disposed')[0]({ agent: me })
  assert.equal(h.sections[0].text({ agent: me }).includes('12. '), true, '回到全局默认')
})

test('缺少 systemPrompt / commands / llm 时仍能加载', () => {
  const log = []
  const ctx = {
    logger: { info: (m) => log.push(m), warn: (m) => log.push(m) },
    on() {
      return () => {}
    },
    emit() {},
    effect(fn) {
      fn()
      return () => {}
    },
    get() {
      return undefined
    },
  }
  assert.doesNotThrow(() => apply(ctx, undefined))
  assert.ok(log.some((line) => String(line).includes('systemPrompt')))
})

test('/sharp 子命令都能返回结构化结果', async () => {
  const h = makeCtx()
  apply(h.ctx, undefined)
  const me = agent('s1')
  const run = (rawInput) => h.registered[0].handler({ agent: me, rawInput, attachments: [], signal: undefined })

  for (const rawInput of ['', 'status', 'help', 'why', 'think', 'budget', 'contract', 'lite', 'normal', 'hard']) {
    const result = await run(rawInput)
    assert.equal(result.kind, 'success', `/${rawInput} 应当是 success：${result.text}`)
  }
  for (const rawInput of ['bogus', 'think wat', 'budget wat']) {
    const result = await run(rawInput)
    assert.equal(result.kind, 'error', `/${rawInput} 应当是 error`)
  }
  const status = await run('status')
  assert.ok(status.text.includes('档位'))
  assert.ok(status.text.includes('上限'))
})

// ------------------------------------------------------------------ main ----

for (const [label, fn] of checks) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    console.error(`  FAIL ${label}`)
    console.error(`       ${error?.message ?? error}`)
  }
}

console.log(`\n${passed}/${checks.length} passed`)
if (passed !== checks.length) process.exit(1)
