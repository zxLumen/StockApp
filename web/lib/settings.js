import path from 'node:path'
import { readJson, writeJson, readJsonWithBak } from './store.js'
import { DATA_DIR } from './scope.js'
import { providerById, detectProvider } from './providers.js'

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const KEYS_FILE = path.join(DATA_DIR, 'keys.json')

export const DEFAULT_SETTINGS = {
  provider: 'deepseek',
  model: 'deepseek-flash',
  baseURL: 'https://api.deepseek.com',
  maxTokens: 2048,
  temperature: 0.6,
  visitorAi: process.env.STOCK_VISITOR_AI !== '0',
}

export async function loadSettings() {
  const stored = await readJsonWithBak(SETTINGS_FILE, null)
  return { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) }
}

export async function saveSettings(patch) {
  const cur = await loadSettings()
  const next = {
    ...cur,
    ...patch,
    maxTokens: Math.min(8192, Math.max(256, Number(patch.maxTokens ?? cur.maxTokens) || 2048)),
    temperature: Math.min(2, Math.max(0, Number(patch.temperature ?? cur.temperature))),
  }
  // 选了某个预设且没手改 baseURL/model 时，跟随预设走
  const preset = providerById(next.provider)
  if (patch.provider && patch.provider !== cur.provider && !patch.baseURL && !patch.model) {
    next.baseURL = preset.defaultBaseURL
    next.model = preset.defaultModel
  }
  await writeJson(SETTINGS_FILE, next)
  return next
}

export async function loadKeys() {
  const keys = await readJsonWithBak(KEYS_FILE, {})
  return keys && typeof keys === 'object' ? keys : {}
}

export async function saveKey(provider, key) {
  const keys = await loadKeys()
  const id = provider || detectProvider((await loadSettings()).baseURL)
  if (key) keys[id] = String(key).trim()
  else delete keys[id]
  await writeJson(KEYS_FILE, keys, { mode: 0o600 })
  return keys
}

/** 对外只回掩码，绝不回明文 Key。 */
export async function publicSettings() {
  const s = await loadSettings()
  const keys = await loadKeys()
  const key = keys[s.provider] || keys[detectProvider(s.baseURL)] || ''
  return {
    provider: s.provider,
    model: s.model,
    baseURL: s.baseURL,
    maxTokens: s.maxTokens,
    temperature: s.temperature,
    visitorAi: s.visitorAi,
    hasKey: !!key,
    keyMask: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : null,
  }
}

/** 组装给上游用的配置；没配 Key 时返回 hasKey:false 交给调用方报错。 */
export async function aiConfig() {
  const s = await loadSettings()
  const keys = await loadKeys()
  const id = keys[s.provider] != null ? s.provider : detectProvider(s.baseURL)
  return {
    apiKey: keys[id] || '',
    baseURL: s.baseURL,
    model: s.model,
    maxTokens: s.maxTokens,
    temperature: s.temperature,
    visitorAi: s.visitorAi,
  }
}