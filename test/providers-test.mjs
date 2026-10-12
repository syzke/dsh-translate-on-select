// 翻译后端自测：分片保序 + 真实调用公共接口 + 缓存行为。
//
// 注意：会真的联网请求 cn.bing.com / api.mymemory.translated.net，请按需运行：
//   node test/providers-test.mjs
//
// 只想做离线语法检查用：
//   node --check lib/index.js && node --check lib/providers.mjs && node --check assets/translate.js

import { translate, chunkText, clearCaches } from '../lib/providers.mjs'

console.log('--- chunkText 保序/保字符检查 ---')
{
  const t = 'First sentence. Second one! Third? ' + 'x'.repeat(300) + '\nLast line.'
  for (const max of [40, 130, 5000]) {
    const parts = chunkText(t, max)
    const rejoin = parts.join('')
    console.log(
      `max=${String(max).padStart(4)} parts=${parts.length} roundtrip=${rejoin === t} maxLen=${Math.max(...parts.map((p) => p.length))}`,
    )
  }
}

console.log('\n--- 真实翻译 ---')
const cases = [
  ['英文', 'The quick brown fox jumps over the lazy dog.'],
  ['日语', 'こんにちは、今日はいい天気ですね。'],
  ['德语', 'Die Bibliothek öffnet um neun Uhr morgens.'],
  ['代码', 'const cached = new Map();\nfunction get(k) { return cached.get(k) ?? null }'],
  ['长文本', 'DeepSeek Harness is a local-first agent runtime. '.repeat(40)],
]
for (const [label, text] of cases) {
  const t0 = Date.now()
  try {
    const r = await translate(text)
    const ms = Date.now() - t0
    console.log(`[${label}] ${ms}ms provider=${r.provider} detected=${r.detected} parts=${r.parts} cached=${!!r.cached}`)
    console.log('   ->', r.translation.replace(/\n/g, ' ⏎ ').slice(0, 160))
  } catch (e) {
    console.log(`[${label}] FAILED: ${e.message}`)
  }
}

console.log('\n--- 缓存命中 ---')
{
  const t0 = Date.now()
  const r = await translate('The quick brown fox jumps over the lazy dog.')
  console.log(`cached=${!!r.cached} ${Date.now() - t0}ms`)
}

console.log('\n--- 强制刷新（跳缓存） ---')
{
  clearCaches()
  const t0 = Date.now()
  const r = await translate('The quick brown fox jumps over the lazy dog.', { force: true })
  console.log(`cached=${!!r.cached} ${Date.now() - t0}ms provider=${r.provider}`)
}
