import fs from 'node:fs/promises'
import path from 'node:path'

// 每个文件一把串行锁：应用里写入很轻（自选股 / AI 配置），但并发写必须保证不互相覆盖。
const locks = new Map()

function withLock(file, fn) {
  const prev = locks.get(file) || Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(
    file,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

/** 读一次并区分「没读到」与「读到 undefined」，回退逻辑需要这个区别。 */
async function readJsonRaw(file) {
  try {
    const txt = await fs.readFile(file, 'utf8')
    if (!txt.trim()) return { found: false, value: null }
    return { found: true, value: JSON.parse(txt) }
  } catch {
    return { found: false, value: null }
  }
}

export async function readJson(file, fallback = null) {
  const r = await readJsonRaw(file)
  return r.found ? r.value : fallback
}

/** 原子写：先写 .tmp 再 rename；顺带留一份 .bak，坏掉能回退。 */
export async function writeJson(file, value, { mode } = {}) {
  return withLock(file, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const txt = `${JSON.stringify(value, null, 2)}\n`
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, txt, mode ? { encoding: 'utf8', mode } : 'utf8')
    try {
      await fs.copyFile(file, `${file}.bak`)
    } catch {
      /* 首次写入没有原文件 */
    }
    await fs.rename(tmp, file)
    if (mode) await fs.chmod(file, mode).catch(() => {})
  })
}

export async function readJsonWithBak(file, fallback = null) {
  const primary = await readJsonRaw(file)
  if (primary.found) return primary.value
  const bak = await readJsonRaw(`${file}.bak`)
  if (bak.found) return bak.value
  return fallback
}