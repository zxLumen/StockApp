import { useEffect, useState } from 'react'
import { fetchAiModels, fetchAiSettings, saveAiKey, saveAiSettings, type AiSettings } from '../api'

interface Props {
  onClose: () => void
}

/** 站长专属：AI 解读的 provider / 模型 / Key 配置。 */
export default function SettingsPanel({ onClose }: Props) {
  const [s, setS] = useState<AiSettings | null>(null)
  const [key, setKey] = useState('')
  const [models, setModels] = useState<{ id: string; label: string }[]>([])
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    fetchAiSettings().then(setS).catch((e: unknown) => setErr(e instanceof Error ? e.message : '读取失败'))
  }, [])

  const patch = (p: Partial<AiSettings>) => setS((prev) => (prev ? { ...prev, ...p } : prev))

  const save = async () => {
    if (!s) return
    setErr('')
    setMsg('')
    try {
      const next = await saveAiSettings({
        provider: s.provider,
        model: s.model,
        baseURL: s.baseURL,
        maxTokens: s.maxTokens,
        temperature: s.temperature,
        visitorAi: s.visitorAi,
      })
      setS(next)
      setMsg('已保存')
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败')
    }
  }

  const saveKeyNow = async () => {
    if (!s) return
    setErr('')
    setMsg('')
    try {
      const next = await saveAiKey(s.provider, key)
      setS(next)
      setKey('')
      setMsg('Key 已保存')
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败')
    }
  }

  const loadModels = async () => {
    setErr('')
    try {
      const r = await fetchAiModels(s?.baseURL)
      setModels(r.models)
      setMsg(`拿到 ${r.models.length} 个模型`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '拉取失败')
    }
  }

  if (!s) {
    return (
      <div className="modal">
        <div className="modal-box">
          <div className="note">{err || '加载中…'}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>AI 解读设置</h3>
          <button className="link" onClick={onClose}>
            关闭
          </button>
        </div>

        <label>
          服务商
          <select value={s.provider} onChange={(e) => patch({ provider: e.target.value })}>
            {['deepseek', 'zhipu', 'opencodeZen', 'opencodeGo', 'custom'].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        <label>
          Base URL
          <input value={s.baseURL} onChange={(e) => patch({ baseURL: e.target.value })} />
        </label>

        <label>
          模型
          <div className="row">
            <input value={s.model} onChange={(e) => patch({ model: e.target.value })} />
            <button className="btn" onClick={() => void loadModels()}>
              拉取
            </button>
          </div>
        </label>

        {models.length > 0 && (
          <div className="model-list">
            {models.slice(0, 24).map((m) => (
              <button key={m.id} className="chip" onClick={() => patch({ model: m.id })}>
                {m.label}
              </button>
            ))}
          </div>
        )}

        <label>
          API Key（{s.hasKey ? `已配置 ${s.keyMask ?? ''}` : '未配置'}）
          <div className="row">
            <input
              type="password"
              value={key}
              placeholder={s.hasKey ? '留空则不改动' : 'sk-…'}
              onChange={(e) => setKey(e.target.value)}
            />
            <button className="btn" onClick={() => void saveKeyNow()}>
              保存
            </button>
          </div>
        </label>

        <div className="row two">
          <label>
            最大输出 tokens
            <input
              type="number"
              value={s.maxTokens}
              onChange={(e) => patch({ maxTokens: Number(e.target.value) })}
            />
          </label>
          <label>
            temperature
            <input
              type="number"
              step="0.1"
              value={s.temperature}
              onChange={(e) => patch({ temperature: Number(e.target.value) })}
            />
          </label>
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={s.visitorAi}
            onChange={(e) => patch({ visitorAi: e.target.checked })}
          />
          允许访客使用 AI 解读
        </label>

        {err && <div className="note err">{err}</div>}
        {msg && <div className="note ok">{msg}</div>}

        <div className="modal-foot">
          <button className="btn primary" onClick={() => void save()}>
            保存设置
          </button>
        </div>
      </div>
    </div>
  )
}