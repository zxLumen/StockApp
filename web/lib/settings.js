import path from 'node:path'
import { readJsonWithBak, writeJson } from './store.js'
import { PROVIDERS, detectProvider } from './providers.js'

/**
 * AI 配置。**每个服务商一个独立槽位**（各自的 model + baseURL），与 yijing64 同构。
 *
 * 为什么不用「单槽 + 切换时跟随预设」：那个模型有两个躲不掉的问题 ——
 *  ① 切换 provider 要么忘了跟（baseURL 留着上一个服务商的，于是配着新 Key
 *     去打旧地址，上游只回一个语焉不详的 401），要么跟了就把用户在「自定义」里
 *     手填的地址冲掉（custom 的预设 baseURL 是空串，一切过去就清空）。
 *  ② 「用户到底改没改这个字段」没法判定，跟随逻辑只能靠猜 —— 于是那段跟随分支
 *     实际上永远不生效（前端总是把 baseURL 一起传过来）。
 * 分槽之后，切换 provider 就是换一个槽去读：没有「跟随」这回事，也不跨服务商串味。
 */

const settingsFile = (dataDir) => path.join(dataDir, 'settings.json')
const keysFile = (dataDir) => path.join(dataDir, 'keys.json')

export const DEFAULT_SETTINGS = {
  provider: 'zx-gateway',
  // 带思考链的模型（deepseek-v4.x 等）把 reasoning 和正文记在同一份 max_tokens 上，
  // 而我们不显示思考过程 —— 预算太小会出现「思考吃完额度、正文一个字都没有」。
  maxTokens: 4096,
  temperature: 0.6,
  visitorAi: process.env.STOCK_VISITOR_AI !== '0',
}

const str = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback)

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

const clampNum = (value, min, max, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/** 补齐每个服务商的槽位；顺手兼容旧版「单槽」形状（model/baseURL 挂在顶层）。 */
const normalize = (stored) => {
  const raw = stored && typeof stored === 'object' ? stored : {}
  const provider = PROVIDERS.some((p) => p.id === raw.provider) ? raw.provider : DEFAULT_SETTINGS.provider
  // 旧版没有 providers 字段：把顶层的 model/baseURL 并进当时那个服务商的槽位
  const legacy = raw.providers && typeof raw.providers === 'object' ? null : provider

  /** @type {Record<string, {model: string, baseURL: string}>} */
  const providers = {}
  for (const preset of PROVIDERS) {
    const slot = legacy ? {} : (raw.providers?.[preset.id] ?? {})
    providers[preset.id] = {
      model: str(legacy === preset.id ? raw.model : slot.model, preset.defaultModel),
      baseURL:
        preset.id === 'zx-gateway'
          ? process.env.ZX_AI_GATEWAY_URL || preset.defaultBaseURL
          : str(legacy === preset.id ? raw.baseURL : slot.baseURL, preset.defaultBaseURL),
    }
  }

  return {
    provider,
    providers,
    maxTokens: clampInt(raw.maxTokens, 256, 8192, DEFAULT_SETTINGS.maxTokens),
    temperature: clampNum(raw.temperature, 0, 2, DEFAULT_SETTINGS.temperature),
    visitorAi: typeof raw.visitorAi === 'boolean' ? raw.visitorAi : DEFAULT_SETTINGS.visitorAi,
  }
}

export const loadSettings = async (dataDir) => normalize(await readJsonWithBak(settingsFile(dataDir), null))

/**
 * 合并保存（只接受白名单键）。
 *
 * 切 provider **不动任何槽位** —— 各服务商的地址与模型是各自独立的，切换只是换读哪个。
 * `providers` 里没传的字段保持原值；显式传空串表示「清掉 → 回落该服务商的预设默认值」。
 */
export async function saveSettings(dataDir, patch) {
  const current = await loadSettings(dataDir)
  const next = { ...current, providers: { ...current.providers } }

  if (PROVIDERS.some((p) => p.id === patch?.provider)) next.provider = patch.provider
  if (patch?.providers && typeof patch.providers === 'object') {
    for (const preset of PROVIDERS) {
      const slot = patch.providers[preset.id]
      if (!slot || typeof slot !== 'object') continue
      const prev = current.providers[preset.id]
      next.providers[preset.id] = {
        model: 'model' in slot ? str(slot.model, preset.defaultModel) : prev.model,
        baseURL: 'baseURL' in slot ? str(slot.baseURL, preset.defaultBaseURL) : prev.baseURL,
      }
    }
  }
  if (patch?.maxTokens !== undefined) next.maxTokens = clampInt(patch.maxTokens, 256, 8192, current.maxTokens)
  if (patch?.temperature !== undefined) next.temperature = clampNum(patch.temperature, 0, 2, current.temperature)
  if (typeof patch?.visitorAi === 'boolean') next.visitorAi = patch.visitorAi

  await writeJson(settingsFile(dataDir), next)
  return next
}

export async function loadKeys(dataDir) {
  const keys = await readJsonWithBak(keysFile(dataDir), {})
  return keys && typeof keys === 'object' ? keys : {}
}

/** 写入某个服务商的 Key（空串 = 清除）。调用方需先校验 provider 合法。 */
export async function saveKey(dataDir, provider, key) {
  const keys = await loadKeys(dataDir)
  if (key) keys[provider] = String(key).trim()
  else delete keys[provider]
  await writeJson(keysFile(dataDir), keys, { mode: 0o600 })
  return keys
}

/** 对外只回掩码，绝不回明文 Key。 */
const maskKey = (key) => {
  const k = String(key || '')
  if (!k) return null
  if (k.length <= 10) return `${k.slice(0, 2)}…`
  return `${k.slice(0, 6)}…${k.slice(-4)}`
}

/**
 * 展开成实际发请求用的配置。
 * `provider` 省略时用当前服务商；带上则取那个槽（给「拉取模型」用：能在非当前槽上探测）。
 */
export async function aiConfigFor(dataDir, provider) {
  const s = await loadSettings(dataDir)
  const id = PROVIDERS.some((p) => p.id === provider) ? provider : s.provider
  const keys = await loadKeys(dataDir)
  const slot = s.providers[id]
  // 当前服务商没存 Key 时，按地址猜一次（老配置里 provider 常是 custom，但地址填的是官方的）
  const keyId = keys[id] ? id : detectProvider(slot.baseURL)
  let apiKey = keys[keyId] || ''
  if (!apiKey && (id === 'zx-gateway' || keyId === 'zx-gateway')) {
    apiKey = (process.env.ZX_AI_APP_TOKEN || '').trim()
  }
  const isGw = id === 'zx-gateway' || keyId === 'zx-gateway'
  const baseURL = isGw
    ? process.env.ZX_AI_GATEWAY_URL ||
      PROVIDERS.find((p) => p.id === 'zx-gateway')?.defaultBaseURL ||
      slot.baseURL
    : slot.baseURL
  return {
    apiKey,
    baseURL,
    model: slot.model,
    maxTokens: s.maxTokens,
    temperature: s.temperature,
    visitorAi: s.visitorAi,
  }
}

export const aiConfig = (dataDir) => aiConfigFor(dataDir, null)

/** 设置面板用的快照：当前服务商解析值 + 每个槽位各自的状态。绝不回传明文 Key。 */
export async function publicSettings(dataDir) {
  const s = await loadSettings(dataDir)
  const keys = await loadKeys(dataDir)
  const cfg = await aiConfigFor(dataDir, s.provider)
  return {
    provider: s.provider,
    model: cfg.model,
    baseURL: cfg.baseURL,
    maxTokens: s.maxTokens,
    temperature: s.temperature,
    visitorAi: s.visitorAi,
    hasKey: !!cfg.apiKey,
    keyMask: maskKey(cfg.apiKey),
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      defaultModel: p.defaultModel,
      defaultBaseURL: p.defaultBaseURL,
      model: s.providers[p.id].model,
      baseURL: s.providers[p.id].baseURL,
      hasKey: !!keys[p.id],
      keyMask: maskKey(keys[p.id]),
    })),
  }
}