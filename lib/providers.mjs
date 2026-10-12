// 划词翻译的翻译后端。
//
// 说明：这里只使用**无需 API key 的公共接口**，且按“可达性优先”排序。
// 主用 cn.bing.com 的 ttranslatev3（自带 auto-detect、质量好、国内可直连），
// 备用人 MyMemory。Google 的 translate_a/single 端点在国内网络下不可达
// （实测 timeout / ECONNRESET），因此没有放进候选链。
//
// 之所以放在宿主侧而不是浏览器里直接调：① 绕开 CORS；② 可以集中做缓存、
// 分片与多后端回退；③ 探测到的真实语言可以回传给界面显示。

import https from 'node:https'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const BING_HOST = 'cn.bing.com'
const DEFAULT_TIMEOUT = 15000

// MyMemory 匿名额度很小（约 5000 字符/天），填一个邮箱可以提升到 5 万。
// 需要的话设环境变量 DSH_TRANSLATE_CONTACT。
const MEMORY_CONTACT = String(process.env.DSH_TRANSLATE_CONTACT || '').trim()

function httpRequest(urlStr, { method = 'GET', headers = {}, body = null, timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(urlStr)
    } catch (err) {
      reject(new Error('非法 URL'))
      return
    }
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')))
    if (body) req.write(body)
    req.end()
  })
}

// ---------------------------------------------------------------- 分片
// 按句子/换行边界切分，且**完整保留所有字符**（各片直接拼接等于原文），
// 这样逐片翻译后按序拼接，就能大致维持原文的换行与排版。
export function chunkText(text, max) {
  if (text.length <= max) return [text]
  const out = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(i + max, text.length)
    if (end < text.length) {
      const slice = text.slice(i, end)
      const m = slice.match(/[\s\S]*[.!?。！？;；:：\n]/)
      // 只在切出足够长的一段时才在标点处断开，避免碎片化
      if (m && m[0].length > max * 0.5) end = i + m[0].length
    }
    out.push(text.slice(i, end))
    i = end
  }
  return out
}

// ---------------------------------------------------------------- Bing
let bingSession = null

async function getBingSession(force = false) {
  if (!force && bingSession && Date.now() < bingSession.expires) return bingSession
  const res = await httpRequest(`https://${BING_HOST}/translator`, {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
  })
  if (res.status !== 200) throw new Error(`页面 HTTP ${res.status}`)
  const html = res.text
  const abuse = html.match(/params_AbusePreventionHelper\s*=\s*(\[[\s\S]*?\])/)
  if (!abuse) throw new Error('未能从页面取到 token（页面结构可能变了）')
  let key, token, ttl
  try {
    ;[key, token, ttl] = JSON.parse(abuse[1])
  } catch (err) {
    throw new Error('token 解析失败')
  }
  const ig = html.match(/IG:"([^"]+)"/)
  const iid = html.match(/data-iid="([^"]+)"/)
  bingSession = {
    key,
    token,
    ig: ig ? ig[1] : '',
    iid: iid ? iid[1] : '',
    cookie: (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; '),
    // token 自带 1 小时有效期，提前 2 分钟过期，避免边界失败
    expires: Date.now() + Math.max(60000, Math.min(Number(ttl) || 3600000, 3600000) - 120000),
  }
  return bingSession
}

async function bingTranslateChunk(text, to, allowRetry = true) {
  const s = await getBingSession()
  const form =
    'fromLang=auto-detect&text=' +
    encodeURIComponent(text) +
    '&to=' +
    to +
    '&token=' +
    encodeURIComponent(s.token) +
    '&key=' +
    s.key
  const res = await httpRequest(
    `https://${BING_HOST}/ttranslatev3?isVertical=1&&IG=${encodeURIComponent(s.ig)}&IID=${encodeURIComponent(s.iid)}`,
    {
      method: 'POST',
      headers: {
        'user-agent': UA,
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(form),
        referer: `https://${BING_HOST}/translator`,
        cookie: s.cookie,
      },
      body: form,
    },
  )
  let json = null
  try {
    json = JSON.parse(res.text)
  } catch (err) {
    /* 非 JSON：下面统一按失败处理 */
  }
  if (Array.isArray(json) && json[0] && Array.isArray(json[0].translations) && json[0].translations[0]) {
    return {
      text: json[0].translations.map((t) => t.text).join(''),
      detected: (json[0].detectedLanguage && json[0].detectedLanguage.language) || '',
    }
  }
  // token 过期或限流：强制换一次 session 再试一遍（只重试一次，避免死循环）
  if (allowRetry) {
    await getBingSession(true)
    return bingTranslateChunk(text, to, false)
  }
  const detail = json && (json.errorMessage || json.statusCode) ? JSON.stringify(json).slice(0, 180) : `HTTP ${res.status}`
  throw new Error(detail)
}

const bingProvider = {
  label: 'Bing',
  maxChunk: 4000,
  translate: bingTranslateChunk,
}

// ---------------------------------------------------------------- MyMemory
function guessSource(text) {
  if (/[\u3040-\u30ff]/.test(text)) return 'ja'
  if (/[\uac00-\ud7af]/.test(text)) return 'ko'
  if (/[\u0400-\u04ff]/.test(text)) return 'ru'
  if (/[\u0600-\u06ff]/.test(text)) return 'ar'
  if (/[\u0e00-\u0e7f]/.test(text)) return 'th'
  return 'en'
}

async function myMemoryTranslateChunk(text, to) {
  const src = guessSource(text)
  const tgt = to === 'zh-Hans' || to === 'zh-CN' ? 'zh-CN' : to
  const url =
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}` +
    `&langpair=${encodeURIComponent(src + '|' + tgt)}` +
    (MEMORY_CONTACT ? '&de=' + encodeURIComponent(MEMORY_CONTACT) : '')
  const res = await httpRequest(url, { headers: { 'user-agent': UA } })
  let json = null
  try {
    json = JSON.parse(res.text)
  } catch (err) {
    throw new Error(`HTTP ${res.status}`)
  }
  const out = json && json.responseData && json.responseData.translatedText
  if (!out) throw new Error(`HTTP ${res.status}`)
  if (/MYMEMORY WARNING/i.test(out)) throw new Error('今日免费额度已用尽')
  return { text: out, detected: src }
}

const myMemoryProvider = {
  label: 'MyMemory',
  // 该接口单次请求体上限约 500 字节，保守取 480
  maxChunk: 480,
  translate: myMemoryTranslateChunk,
}

const PROVIDERS = [bingProvider, myMemoryProvider]

// ---------------------------------------------------------------- 结果缓存
const CACHE_MAX = 500
const CACHE_TTL = 24 * 60 * 60 * 1000
const cache = new Map()

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key)
    return null
  }
  // LRU：命中后挪到末尾
  cache.delete(key)
  cache.set(key, hit)
  return hit.value
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value })
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
}

export function clearCaches() {
  cache.clear()
  bingSession = null
}

// ---------------------------------------------------------------- 对外入口
export async function translate(text, { to = 'zh-Hans', force = false } = {}) {
  const key = to + '\u0000' + text
  if (!force) {
    const hit = cacheGet(key)
    if (hit) return Object.assign({}, hit, { cached: true })
  }

  const errors = []
  for (const provider of PROVIDERS) {
    try {
      const parts = chunkText(text, provider.maxChunk)
      const outs = []
      let detected = ''
      for (const part of parts) {
        const r = await provider.translate(part, to)
        outs.push(r.text)
        if (!detected && r.detected) detected = r.detected
      }
      const result = {
        translation: outs.join(''),
        detected,
        provider: provider.label,
        chars: text.length,
        parts: parts.length,
      }
      cacheSet(key, result)
      return result
    } catch (err) {
      errors.push(`${provider.label}: ${(err && err.message) || err}`)
    }
  }
  throw new Error(errors.join('；'))
}
