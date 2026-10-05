/**
 * dsh-sharp / state.js
 *
 * 每个会话一份可覆盖的状态：锐化档位 + 思考模式 + 输出预算。
 * 没有覆盖时回落到插件配置里的全局默认值；全局默认值可以是 'auto'，
 * 这时由**档位**决定该用什么思考模式和输出预算 —— 一个旋钮管三件事。
 */

/** 锐化档位。off 表示完全不注入契约。 */
export const LEVELS = ['off', 'lite', 'balanced', 'hard']

/** 思考模式。inherit 表示不动模型的思考配置；auto 表示跟着档位走。 */
export const THINK_MODES = ['auto', 'inherit', 'prefer-low', 'model-default']

/**
 * 档位自带的默认值（只在模式为 'auto' 时生效）：
 *   lite     —— 只删废话，不动思考预算、不压输出上限
 *   balanced —— 默认档：压到最低非 off 的思考档，输出上限交给模型
 *   hard     —— 最短最硬：思考最低 + 输出上限收紧
 */
export const LEVEL_DEFAULTS = {
  lite: { think: 'inherit', budget: 'inherit' },
  balanced: { think: 'prefer-low', budget: 'inherit' },
  hard: { think: 'prefer-low', budget: 'tight' },
}

/** 会话覆盖表的上限，防止拿不到 agent/disposed 的极端情况下无限增长。 */
const MAX_SESSIONS = 512

/**
 * 把用户输入（命令参数 / 配置值）归一化成合法档位。
 * @param {unknown} value
 * @returns {'off' | 'lite' | 'balanced' | 'hard' | undefined}
 */
export function normalizeLevel(value) {
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  if (v === '') return undefined
  if (v === 'off' || v === '0' || v === 'disable' || v === 'disabled' || v === 'false') return 'off'
  if (v === 'lite' || v === 'light' || v === 'soft' || v === '1') return 'lite'
  if (v === 'balanced' || v === 'normal' || v === 'default' || v === '2') return 'balanced'
  if (v === 'hard' || v === 'strict' || v === 'max' || v === '3') return 'hard'
  return undefined
}

/**
 * @param {unknown} value
 * @returns {'auto' | 'inherit' | 'prefer-low' | 'model-default' | undefined}
 */
export function normalizeThinkMode(value) {
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  if (v === '') return undefined
  if (v === 'auto' || v === 'level' || v === 'by-level') return 'auto'
  if (v === 'inherit' || v === 'keep' || v === 'none' || v === 'as-is' || v === 'untouched') return 'inherit'
  if (v === 'prefer-low' || v === 'low' || v === 'lowest' || v === 'shallow' || v === 'cheap' || v === 'min') {
    return 'prefer-low'
  }
  if (v === 'model-default' || v === 'default' || v === 'drop' || v === 'reset' || v === 'model') {
    return 'model-default'
  }
  return undefined
}

export class SharpState {
  /**
   * @param {{ enabled: boolean, level: string, language: string, thinking: { mode: string }, budget: { mode: string | number } }} config
   */
  constructor(config) {
    this.config = config
    /** @type {Map<string, { level?: string, think?: string, budget?: string | number }>} */
    this.sessions = new Map()
  }

  /**
   * @param {string | undefined} key
   */
  #entry(key) {
    if (typeof key !== 'string' || key.length === 0) return undefined
    let entry = this.sessions.get(key)
    if (entry === undefined) {
      if (this.sessions.size >= MAX_SESSIONS) {
        // Map 保持插入顺序：踢掉最老的那个，保证内存有界。
        const oldest = this.sessions.keys().next()
        if (oldest.done !== true) this.sessions.delete(oldest.value)
      }
      entry = {}
      this.sessions.set(key, entry)
    }
    return entry
  }

  /** @param {string | undefined} key */
  #override(key) {
    return typeof key === 'string' ? this.sessions.get(key) : undefined
  }

  /** 是否注入契约。会话显式覆盖优先（所以 /sharp on 能救回被全局停用的会话）。 */
  active(key) {
    const entry = this.#override(key)
    if (entry !== undefined && typeof entry.level === 'string') return entry.level !== 'off'
    return this.config.enabled === true && this.config.level !== 'off'
  }

  /** @returns {'off' | 'lite' | 'balanced' | 'hard'} */
  level(key) {
    const entry = this.#override(key)
    if (entry !== undefined && typeof entry.level === 'string') return entry.level
    return this.config.level
  }

  /** 该档位自带的默认值。 */
  #derived(key) {
    const level = this.level(key)
    return LEVEL_DEFAULTS[level] ?? LEVEL_DEFAULTS.balanced
  }

  /** 未解析 'auto' 的原始思考模式（给 /sharp status 标注「随档位自动」用）。 */
  thinkModeRaw(key) {
    const entry = this.#override(key)
    if (entry !== undefined && typeof entry.think === 'string') return entry.think
    return this.config.thinking.mode
  }

  /** @returns {'inherit' | 'prefer-low' | 'model-default'} */
  thinkMode(key) {
    const raw = this.thinkModeRaw(key)
    if (raw === 'auto') return this.#derived(key).think
    return raw === 'inherit' || raw === 'model-default' || raw === 'prefer-low' ? raw : 'inherit'
  }

  /** 未解析 'auto' 的原始输出预算模式。 */
  budgetModeRaw(key) {
    const entry = this.#override(key)
    if (entry !== undefined && typeof entry.budget !== 'undefined') return entry.budget
    return this.config.budget.mode
  }

  /** @returns {'inherit' | 'normal' | 'tight' | 'strict' | number} */
  budgetMode(key) {
    const raw = this.budgetModeRaw(key)
    if (raw === 'auto') return this.#derived(key).budget
    return raw === undefined ? 'inherit' : raw
  }

  /**
   * @param {string | undefined} key
   * @param {'off' | 'lite' | 'balanced' | 'hard'} level
   */
  setLevel(key, level) {
    const entry = this.#entry(key)
    if (entry === undefined) return false
    entry.level = level
    return true
  }

  /**
   * @param {string | undefined} key
   * @param {'auto' | 'inherit' | 'prefer-low' | 'model-default'} mode
   */
  setThinkMode(key, mode) {
    const entry = this.#entry(key)
    if (entry === undefined) return false
    entry.think = mode
    return true
  }

  /**
   * @param {string | undefined} key
   * @param {'auto' | 'inherit' | 'normal' | 'tight' | 'strict' | number} mode
   */
  setBudgetMode(key, mode) {
    const entry = this.#entry(key)
    if (entry === undefined) return false
    entry.budget = mode
    return true
  }

  /** 清掉某个会话的覆盖，回到全局默认。 */
  reset(key) {
    if (typeof key !== 'string' || key.length === 0) return false
    return this.sessions.delete(key)
  }

  /** agent 销毁时清理，避免 Map 泄漏。 */
  forget(key) {
    if (typeof key !== 'string' || key.length === 0) return false
    return this.sessions.delete(key)
  }

  /** 给 /sharp status 用的一份摘要。 */
  describe(key) {
    const entry = this.#override(key)
    const thinkRaw = this.thinkModeRaw(key)
    const budgetRaw = this.budgetModeRaw(key)
    return {
      enabled: this.config.enabled === true,
      level: this.level(key),
      think: this.thinkMode(key),
      thinkRaw,
      thinkAuto: thinkRaw === 'auto',
      budget: this.budgetMode(key),
      budgetRaw,
      budgetAuto: budgetRaw === 'auto',
      language: this.config.language,
      overridden: entry !== undefined,
      sessionCount: this.sessions.size,
    }
  }

  dispose() {
    this.sessions.clear()
  }
}
