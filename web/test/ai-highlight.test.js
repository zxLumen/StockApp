import test from 'node:test'
import assert from 'node:assert/strict'
import { extractVerdict, sectionOf, tokenize, VERDICTS } from '../src/lib/aiHighlightTokens.js'

/** 把 tokenize 的结果压成 "文本|类型:值" 序列，断言起来比遍历 React 节点清楚。 */
function shape(text) {
  return tokenize(text).map((t) => `${t.type}:${t.value}`)
}

test('tokenize: 结论词按倾向分类', () => {
  assert.deepEqual(shape('结论是**看多**'), ['text:结论是**', 'verdict:看多', 'text:**'])
  assert.deepEqual(shape('偏空一些'), ['verdict:偏空', 'text:一些'])
  assert.deepEqual(shape('维持震荡'), ['text:维持', 'verdict:震荡'])
  const up = tokenize('看多')[0]
  assert.equal(up.tone, 'up')
  assert.equal(tokenize('看空')[0].tone, 'down')
  assert.equal(tokenize('中性')[0].tone, 'flat')
})

test('tokenize: 「看好/看坏」也要能抓（用户明确提过的说法）', () => {
  assert.equal(tokenize('我看好该板块')[1].value, '看好')
  assert.equal(tokenize('我看好该板块')[1].tone, 'up')
  assert.equal(tokenize('我看坏该板块')[1].tone, 'down')
})

test('tokenize: 带符号的指标按涨跌方向染色（形态感知）', () => {
  assert.equal(tokenize('-2.92%')[0].tone, 'down', '跌用绿色')
  assert.equal(tokenize('+3.10%')[0].tone, 'up', '涨用红色')
  assert.equal(tokenize('2 个点')[0].tone, 'num', '无符号保持中性底色')
  assert.equal(tokenize('1.5 倍')[0].tone, 'num')
})

test('tokenize: 量化指标（数字 + 单位）要抓，裸数字不抓', () => {
  assert.deepEqual(shape('跌 -2.92%'), ['text:跌 ', 'num:-2.92%'], '负号要跟数字一起被高亮')
  assert.deepEqual(shape('阻力 22183 点'), ['text:阻力 ', 'num:22183 点'])
  assert.deepEqual(shape('约 1.5 倍'), ['text:约 ', 'num:1.5 倍'])
  assert.deepEqual(shape('成交额 1782 亿'), ['text:成交额 ', 'num:1782 亿'])
  // 均线值没有单位，不该被当成「指标形态」染起来
  assert.deepEqual(shape('MA5=16834.01'), ['text:MA5=16834.01'])
  assert.deepEqual(shape('2026 年的判断'), ['text:2026 年的判断'])
})

test('tokenize: 纯时间跨度不算量化指标（别把时间当指标高亮）', () => {
  // 时间跨度由小标题的 短期/中期/长期 标签表达，正文里的「1-2 周」再染一遍就是噪音
  for (const src of ['周期 3 个月', '未来 1-2 周偏弱', '1-2个月震荡', '2 天内', '3个季度', '持有 6-12 个月']) {
    assert.deepEqual(
      tokenize(src).filter((t) => t.type === 'num'),
      [],
      `${src} 不该出现 num 高亮，实际 ${JSON.stringify(tokenize(src))}`,
    )
  }
  // 但「交易日」是例外：8 个交易日封板是真量化说法，要抓
  assert.deepEqual(shape('8 个交易日封板'), ['num:8 个交易日', 'text:封板'])
})

test('tokenize: 复合单位要吃全（亿元/万亿元/万手/亿手 不能漏字）', () => {
  // 这些是 AI 输出里最高频的量词。正则左优先，漏列就会只吃前半截：
  // 「4.78亿元」显示成 chip「4.78亿」+ 普通文字「元」，看着像渲染坏了。
  for (const [src, want] of [
    ['主力净流入 4.78亿元', '4.78亿元'],
    ['成交额 236.62亿元', '236.62亿元'],
    ['市值 1.2万亿元', '1.2万亿元'],
    ['换手 3.2万手', '3.2万手'],
    ['成交 1.2亿手', '1.2亿手'],
    ['成交额 1782 亿', '1782 亿'],
  ]) {
    const nums = tokenize(src).filter((t) => t.type === 'num')
    assert.equal(nums.length, 1, `${src} 应恰好一个指标，实际 ${JSON.stringify(nums)}`)
    assert.equal(nums[0].value, want)
    // 单位必须被完整吃掉：chip 结尾不能停在「亿」「万」上
    assert.match(nums[0].value, /(亿元|万亿元|万手|亿手|亿|点|倍|%|％|元|手)$/, `${src} 的单位被截断了`)
  }
})

test('tokenize: 区间的连接符不是负号（13932-14500点 不能读成「跌 14500 点」）', () => {
  for (const src of ['企稳在13932-14500点区间', '下方支撑13932-14500点', '1.2-1.5倍']) {
    for (const t of tokenize(src)) {
      if (t.type === 'num') {
        assert.equal(t.tone, 'num', `${src} → ${t.value} 应为中性，不该按涨跌染色`)
      }
    }
  }
  // 区间要整体成一个 token，不能只高亮后半截
  assert.deepEqual(shape('13932-14500点'), ['num:13932-14500点'])
  assert.deepEqual(shape('1.2-1.5 倍'), ['num:1.2-1.5 倍'])
  // 真负数仍然照常染色
  assert.equal(tokenize('-2.92%')[0].tone, 'down')
})

test('tokenize: 长单位优先，`个交易日`/`个点` 不能被 `点`/`日` 抢走', () => {
  assert.equal(tokenize('8 个交易日')[0].value, '8 个交易日')
  assert.equal(tokenize('2 个点')[0].value, '2 个点')
  assert.equal(tokenize('1.2 万亿')[0].value, '1.2 万亿')
})

test('tokenize: 片段能无损拼回原文（高亮不能吃掉字符）', () => {
  const src = '**看多**，目标 22300 点，回踩 16000 点支撑，MA20=16473.99。'
  assert.equal(tokenize(src).map((t) => t.value).join(''), src)
})

test('tokenize: 空输入 / 非字符串不炸', () => {
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize(null), [])
  assert.deepEqual(tokenize(undefined), [])
})

test('extractVerdict: 优先读 ## 结论 小节，按位置取词', () => {
  assert.deepEqual(extractVerdict('## 结论\n**看多**，均线多头。'), { tone: 'up', label: '看多' })
  assert.deepEqual(extractVerdict('## 整体结论\n**看空**，均线空头。'), { tone: 'down', label: '看空' })
  // 标题里带序号 / 加粗也要认得出是结论小节
  assert.deepEqual(extractVerdict('## 一、**结论**\n**中性**，等待信号。'), { tone: 'flat', label: '中性' })
  // 结论小节里后面又提到别的倾向，要听第一句（那是 AI 下的定论）
  assert.deepEqual(
    extractVerdict('## 结论\n**看多**，趋势完好。\n\n风险很大，一旦破位就转空。'),
    { tone: 'up', label: '看多' },
  )
})

test('extractVerdict: 结论小节里的判断说了算，不能被前面分段的词带跑', () => {
  // 这条是真 bug 的回归：横幅报「看多」而 AI 的 ## 结论 写的是「中性」。
  // 老实现按 VERDICTS 数组顺序（up→down→flat）扫全文，比的是**类别优先级**
  // 而不是**位置**，所以后面短期段里的「偏多」一命中就返回 up。
  const md = [
    '## 短期（1-2 周）',
    '风险收益比相对有利，仍需设止损，整体偏多看待。',
    '',
    '## 结论',
    '**中性**，股价贴近60日低点且低于所有主要均线，方向暂不明朗。',
  ].join('\n')
  assert.deepEqual(extractVerdict(md), { tone: 'flat', label: '中性' })

  // 风险段在结论之前提到看空，也不能盖掉结论
  const md2 = [
    '## 风险提示',
    '若跌破前低则转为看空。',
    '',
    '## 结论',
    '**看多**，趋势完好。',
  ].join('\n')
  assert.deepEqual(extractVerdict(md2), { tone: 'up', label: '看多' })
})

test('extractVerdict: 没有结论小节才回退全文第一个倾向词', () => {
  assert.deepEqual(extractVerdict('整体偏空'), { tone: 'down', label: '看空' })
  assert.deepEqual(extractVerdict('建议中性对待'), { tone: 'flat', label: '中性' })
  // 回退时也按位置取，不是按类别优先级
  assert.deepEqual(extractVerdict('先说看空，但整体偏多'), { tone: 'down', label: '看空' })
  assert.equal(extractVerdict('走势结构良好，量能配合'), null, '没有倾向词就别硬凑横幅')
  assert.equal(extractVerdict(''), null)
})

test('sectionOf: 短/中/长期与结论、风险标题都要能分类', () => {
  assert.deepEqual(sectionOf('短期（1-2 周）'), { tone: 'short', tag: '短期' })
  assert.deepEqual(sectionOf('中期（1-3 个月）'), { tone: 'mid', tag: '中期' })
  assert.deepEqual(sectionOf('长期（6-12 个月）'), { tone: 'long', tag: '长期' })
  assert.deepEqual(sectionOf('结论'), { tone: 'verdict', tag: '结论' })
  assert.deepEqual(sectionOf('风险提示'), { tone: 'risk', tag: '风险' })
  assert.deepEqual(sectionOf('热点/消息面'), null)
})

test('sectionOf: 「短期」不能被「长期」的 6-12 个月误伤，反之亦然', () => {
  // 三个 horizon 都带「周/月」，靠各自独特的时间窗区分
  assert.equal(sectionOf('短期操作建议（1-2 周）').tag, '短期')
  assert.equal(sectionOf('中期趋势（1-3 个月）').tag, '中期')
  assert.equal(sectionOf('长期逻辑（6-12 个月）').tag, '长期')
})

test('VERDICTS: 三种倾向都要有中文标签（横幅上要显示）', () => {
  assert.deepEqual(
    VERDICTS.map((v) => v.label),
    ['看多', '看空', '中性'],
  )
})
