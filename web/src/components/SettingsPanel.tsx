import { useEffect, useState } from 'react'
import {
  fetchAiModels,
  fetchAiSettings,
  saveAiKey,
  saveAiSettings,
  type AiProviderSlot,
  type AiSettings,
} from '../api'

interface Props {
  onClose: () => void
}

type SlotField = 'model' | 'baseURL'
type ModelList = { id: string; label: string }[]

const FIELD_LABEL: Record<SlotField, string> = { model: '模型', baseURL: 'Base URL' }

/**
 * 站长专属：AI 解读配置。
 *
 * **每个服务商一个独立槽位**（Base URL + 模型 + Key 各归各家）。切换服务商只改「当前用哪个」，
 * 绝不去动槽位内容 —— 也就不会再出现「换了服务商、地址却还留着上一个的」，
 * 配着新 Key 去打旧地址、上游回一个看不懂的 401。
 */
export default function SettingsPanel({ onClose }: Props) {
  const [s, setS] = useState<AiSettings | null>(null)
  /** 展开哪个槽位（同时只开一个，面板不至于被 5 张卡撑爆） */
  const [openSlot, setOpenSlot] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({})
  const [models, setModels] = useState<Record<string, ModelList>>({})
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    fetchAiSettings()
      .then((next) => {
        setS(next)
        setOpenSlot(next.provider)
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : '读取失败'))
  }, [])

  const slotOf = (id: string) => s?.providers.find((p) => p.id === id)

  /** 只改本地草稿，失焦时才落库。 */
  const draftSlot = (id: string, field: SlotField, value: string) =>
    setS((prev) =>
      prev
        ? { ...prev, providers: prev.providers.map((p) => (p.id === id ? { ...p, [field]: value } : p)) }
        : prev,
    )

  /** 落库某个槽位的一个字段；同一个槽的另一个字段没传，服务端保持原值。 */
  const commitSlot = async (id: string, field: SlotField, value: string) => {
    setErr('')
    try {
      const next = await saveAiSettings({ providers: { [id]: { [field]: value } } })
      setS(next)
      setMsg(`已保存 ${slotOf(id)?.label ?? id} 的 ${FIELD_LABEL[field]}`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败')
    }
  }

  const switchProvider = async (id: string) => {
    setErr('')
    setMsg('')
    setOpenSlot(id)
    try {
      setS(await saveAiSettings({ provider: id }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : '切换失败')
    }
  }

  /** `explicit` 给「清除 Key」用：清空输入框后再点保存，读到的是旧值而不是空串。 */
  const putKey = async (id: string, explicit?: string) => {
    setErr('')
    setMsg('')
    const key = (explicit ?? keyDraft[id] ?? '').trim()
    try {
      const next = await saveAiKey(id, key)
      setS(next)
      setKeyDraft((prev) => ({ ...prev, [id]: '' }))
      setMsg(key ? 'Key 已保存' : 'Key 已清除')
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败')
    }
  }

  const loadModels = async (id: string) => {
    setErr('')
    setMsg('')
    const slot = slotOf(id)
    if (!slot) return
    try {
      const r = await fetchAiModels(id, slot.baseURL)
      setModels((prev) => ({ ...prev, [id]: r.models }))
      setMsg(`${slot.label}：拿到 ${r.models.length} 个模型`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '拉取失败')
    }
  }

  const saveGlobal = async () => {
    if (!s) return
    setErr('')
    setMsg('')
    try {
      const next = await saveAiSettings({
        provider: s.provider,
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
      <div className="modal-box wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>AI 解读设置</h3>
          <button className="link" onClick={onClose}>
            关闭
          </button>
        </div>

        <label>
          当前服务商
          <select value={s.provider} onChange={(e) => void switchProvider(e.target.value)}>
            {s.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.hasKey ? '（已配 Key）' : '（未配 Key）'}
                {p.id === s.provider ? ' · 当前' : ''}
              </option>
            ))}
          </select>
        </label>

        <div className="note">每个服务商一套独立的地址 / 模型 / Key，切换只换「用哪个」，互不覆盖。</div>

        <div className="provider-slots">
          {s.providers.map((slot: AiProviderSlot) => {
            const active = slot.id === s.provider
            const open = openSlot === slot.id
            const list = models[slot.id] ?? []
            return (
              <section key={slot.id} className="slot" data-active={active || undefined}>
                <button
                  type="button"
                  className="slot-head"
                  aria-expanded={open}
                  onClick={() => setOpenSlot(open ? null : slot.id)}
                >
                  <span className="slot-title">{slot.label}</span>
                  {active && <span className="tag">当前</span>}
                  <span className={slot.hasKey ? 'tag ok' : 'tag warn'}>
                    {slot.hasKey ? '已配 Key' : '未配 Key'}
                  </span>
                  <span className="slot-hint">{slot.model || '（未填模型）'}</span>
                  <span className="slot-caret">{open ? '收起' : '展开'}</span>
                </button>

                {open && (
                  <div className="slot-body">
                    <label>
                      Base URL
                      <input
                        value={slot.baseURL}
                        placeholder={slot.defaultBaseURL || 'https://…'}
                        onChange={(e) => draftSlot(slot.id, 'baseURL', e.target.value)}
                        onBlur={(e) => void commitSlot(slot.id, 'baseURL', e.target.value)}
                      />
                    </label>

                    <label>
                      模型
                      <div className="row">
                        <input
                          value={slot.model}
                          placeholder={slot.defaultModel || '模型 id'}
                          onChange={(e) => draftSlot(slot.id, 'model', e.target.value)}
                          onBlur={(e) => void commitSlot(slot.id, 'model', e.target.value)}
                        />
                        <button className="btn" onClick={() => void loadModels(slot.id)}>
                          拉取
                        </button>
                      </div>
                    </label>

                    {list.length > 0 && (
                      <div className="model-list">
                        {list.slice(0, 24).map((m) => (
                          <button
                            key={m.id}
                            className={slot.model === m.id ? 'chip on' : 'chip'}
                            onClick={() => {
                              draftSlot(slot.id, 'model', m.id)
                              void commitSlot(slot.id, 'model', m.id)
                            }}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                    )}

                    <label>
                      API Key（{slot.hasKey ? `已配置 ${slot.keyMask ?? ''}` : '未配置'}）
                      <div className="row">
                        <input
                          type="password"
                          value={keyDraft[slot.id] ?? ''}
                          placeholder={slot.hasKey ? '留空则不改动' : 'sk-…'}
                          onChange={(e) => setKeyDraft((prev) => ({ ...prev, [slot.id]: e.target.value }))}
                        />
                        <button className="btn" onClick={() => void putKey(slot.id)}>
                          保存 Key
                        </button>
                      </div>
                    </label>

                    {slot.hasKey && (
                      <button className="link" onClick={() => void putKey(slot.id, '')}>
                        清除 {slot.label} 的 Key
                      </button>
                    )}
                  </div>
                )}
              </section>
            )
          })}
        </div>

        <div className="row two">
          <label>
            最大输出 tokens
            <input
              type="number"
              value={s.maxTokens}
              onChange={(e) => setS((prev) => (prev ? { ...prev, maxTokens: Number(e.target.value) } : prev))}
            />
          </label>
          <label>
            temperature
            <input
              type="number"
              step="0.1"
              value={s.temperature}
              onChange={(e) => setS((prev) => (prev ? { ...prev, temperature: Number(e.target.value) } : prev))}
            />
          </label>
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={s.visitorAi}
            onChange={(e) => setS((prev) => (prev ? { ...prev, visitorAi: e.target.checked } : prev))}
          />
          允许访客使用 AI 解读
        </label>

        {err && <div className="note err">{err}</div>}
        {msg && <div className="note ok">{msg}</div>}

        <div className="modal-foot">
          <button className="btn primary" onClick={() => void saveGlobal()}>
            保存设置
          </button>
        </div>
      </div>
    </div>
  )
}