/**
 * dsh-sharp / model-info.js
 *
 * 共享的模型能力缓存。思考治理器和输出预算治理器都要问 llm 服务同一件事
 * （这个路由支持哪些思考档位、默认输出上限多少），所以缓存一份共用。
 *
 * 缓存策略：成功结果永久缓存（模型能力在一次会话里是静态的，而
 * resolveModelInfo 可能真的去问 adapter）；失败结果只缓存一小段时间，
 * 让「provider 还没注册好」这类瞬时问题自愈，又不会每个请求都去打一次。
 */

const FAILURE_RETRY_MS = 60_000

/**
 * @param {{ resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => Promise<unknown> }} llm
 */
export function createModelInfoCache(llm) {
  /** @type {Map<string, { info: unknown, retryAt: number }>} */
  const cache = new Map()
  let disposed = false

  /**
   * @param {unknown} provider
   * @param {unknown} model
   * @param {AbortSignal} [signal]
   * @returns {Promise<any | null>}
   */
  const get = async (provider, model, signal) => {
    if (typeof provider !== 'string' || provider.length === 0) return null
    if (typeof model !== 'string' || model.length === 0) return null

    const key = `${provider}\u0000${model}`
    const hit = cache.get(key)
    if (hit !== undefined && (hit.info !== null || hit.retryAt > Date.now())) return hit.info

    let info = null
    try {
      info = await llm.resolveModelInfo(provider, model, signal)
    } catch {
      info = null
    }
    if (info === undefined) info = null
    if (!disposed) cache.set(key, { info, retryAt: info === null ? Date.now() + FAILURE_RETRY_MS : 0 })
    return info
  }

  return {
    get,
    dispose() {
      disposed = true
      cache.clear()
    },
    get size() {
      return cache.size
    },
  }
}

export { FAILURE_RETRY_MS }
