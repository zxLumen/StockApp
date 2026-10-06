export const PROVIDERS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultModel: 'deepseek-flash',
    defaultBaseURL: 'https://api.deepseek.com',
  },
  {
    id: 'zhipu',
    label: '智谱',
    defaultModel: 'glm-4.7-flash',
    defaultBaseURL: 'https://open.bigmodel.cn/api/paas/v4',
  },
  {
    id: 'opencodeZen',
    label: 'opencode Zen',
    defaultModel: 'big-pickle',
    defaultBaseURL: 'https://opencode.ai/zen/v1',
  },
  {
    id: 'opencodeGo',
    label: 'opencode Go',
    defaultModel: 'deepseek-v4.1-flash',
    defaultBaseURL: 'https://opencode.ai/zen/go/v1',
  },
  {
    id: 'zx-gateway',
    label: '博客 AI 网关',
    defaultModel: '',
    defaultBaseURL: process.env.ZX_AI_GATEWAY_URL || 'http://localhost:3000/api/ai/v1',
  },
  { id: 'custom', label: '自定义', defaultModel: '', defaultBaseURL: '' },
]

export const providerById = (id) => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]

export const detectProvider = (baseURL) => {
  const url = String(baseURL || '').toLowerCase()
  if (url.includes('opencode.ai')) return url.includes('/zen/go') ? 'opencodeGo' : 'opencodeZen'
  if (url.includes('deepseek')) return 'deepseek'
  if (url.includes('bigmodel.cn')) return 'zhipu'
  if (url.includes('/api/ai/')) return 'zx-gateway'
  return 'custom'
}