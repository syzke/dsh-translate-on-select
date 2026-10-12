/* dsh-translate-on-select —— 前端划词翻译卡片。
 *
 * 行为：鼠标选中非中文内容 → 在选区下方浮出一张卡片，就地显示简体中文译文。
 * 纯原生实现，不依赖 DSH 内部模块；样式全部收在下面的 CSS 字符串里。
 */
;(function () {
  'use strict'
  if (window.__dshTranslateOnSelect) return
  window.__dshTranslateOnSelect = true

  var API = '/dsh-translate/translate'
  var CONFIG_API = '/dsh-translate/config'

  var MIN_CHARS = 2
  var MAX_CHARS = 20000
  var DEBOUNCE_MS = 200
  var CACHE_MAX = 200

  // ------------------------------------------------------------ 样式
  var CSS = [
    '.dsh-tg-card{',
    '  --tg-bg:rgba(255,255,255,.93);--tg-fg:#1f2328;--tg-muted:#6b7280;',
    '  --tg-border:rgba(15,23,42,.10);--tg-hover:rgba(15,23,42,.06);',
    '  --tg-accent:#2563eb;--tg-skel:rgba(15,23,42,.07);--tg-err:#dc2626;',
    '  --tg-shadow:0 12px 32px -10px rgba(15,23,42,.28),0 2px 8px -2px rgba(15,23,42,.12);',
    '  position:fixed;z-index:2147483000;box-sizing:border-box;',
    '  width:max-content;min-width:260px;max-width:min(620px,calc(100vw - 24px));',
    '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif;',
    '  font-size:13.5px;line-height:1.62;text-align:left;',
    '  color:var(--tg-fg);background:var(--tg-bg);border:1px solid var(--tg-border);',
    '  border-radius:14px;box-shadow:var(--tg-shadow);overflow:hidden;',
    '  -webkit-backdrop-filter:blur(16px) saturate(180%);backdrop-filter:blur(16px) saturate(180%);',
    '  animation:dshTgIn .16s cubic-bezier(.2,.8,.2,1);',
    '}',
    '.dsh-tg-card[data-theme="dark"]{',
    '  --tg-bg:rgba(28,31,38,.93);--tg-fg:#e6e8eb;--tg-muted:#98a1ae;',
    '  --tg-border:rgba(255,255,255,.10);--tg-hover:rgba(255,255,255,.08);',
    '  --tg-accent:#7aa2f7;--tg-skel:rgba(255,255,255,.09);--tg-err:#f87171;',
    '  --tg-shadow:0 16px 40px -12px rgba(0,0,0,.62),0 2px 10px -2px rgba(0,0,0,.42);',
    '}',
    '@keyframes dshTgIn{from{opacity:0;transform:translateY(-5px) scale(.985)}to{opacity:1;transform:none}}',
    '@keyframes dshTgShimmer{0%{background-position:100% 0}100%{background-position:0 0}}',
    '@keyframes dshTgPop{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.12)}100%{transform:scale(1);opacity:1}}',
    '@media (prefers-reduced-motion:reduce){.dsh-tg-card{animation:none}.dsh-tg-skel i{animation:none}}',

    // 头部
    '.dsh-tg-head{display:flex;align-items:center;gap:8px;padding:7px 8px 7px 12px;border-bottom:1px solid var(--tg-border)}',
    '.dsh-tg-badge{',
    '  flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;',
    '  width:19px;height:19px;border-radius:6px;font-size:11px;font-weight:700;line-height:1;',
    '  color:#fff;background:linear-gradient(135deg,#3b82f6,#6366f1);',
    '  box-shadow:0 1px 3px rgba(59,130,246,.4);',
    '}',
    '.dsh-tg-meta{font-size:11.5px;color:var(--tg-muted);letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dsh-tg-grow{flex:1 1 auto;min-width:4px}',
    '.dsh-tg-btn{',
    '  flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:4px;',
    '  height:24px;min-width:24px;padding:0 6px;border:0;border-radius:7px;cursor:pointer;',
    '  background:transparent;color:var(--tg-muted);font-size:11.5px;font-family:inherit;',
    '  transition:background .14s ease,color .14s ease;',
    '}',
    '.dsh-tg-btn:hover{background:var(--tg-hover);color:var(--tg-fg)}',
    '.dsh-tg-btn:active{transform:translateY(.5px)}',
    '.dsh-tg-btn svg{width:13px;height:13px;display:block}',
    '.dsh-tg-btn[data-done="1"]{color:#16a34a}',
    '.dsh-tg-card[data-theme="dark"] .dsh-tg-btn[data-done="1"]{color:#4ade80}',
    '.dsh-tg-btn[data-done="1"] svg{animation:dshTgPop .28s ease}',

    // 正文
    '.dsh-tg-body{padding:10px 14px 11px;max-height:min(46vh,380px);overflow:auto;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}',
    '.dsh-tg-body::-webkit-scrollbar{width:8px;height:8px}',
    '.dsh-tg-body::-webkit-scrollbar-thumb{background:var(--tg-hover);border-radius:4px}',
    '.dsh-tg-body::-webkit-scrollbar-track{background:transparent}',
    '.dsh-tg-err{color:var(--tg-err)}',
    '.dsh-tg-err b{font-weight:600}',
    '.dsh-tg-hint{display:block;margin-top:6px;color:var(--tg-muted);font-size:11.5px}',

    // 骨架屏
    '.dsh-tg-skel{display:flex;flex-direction:column;gap:9px;padding:1px 0}',
    '.dsh-tg-skel i{',
    '  display:block;height:9px;border-radius:5px;',
    '  background:linear-gradient(90deg,var(--tg-skel) 25%,transparent 37%,var(--tg-skel) 63%);',
    '  background-size:400% 100%;animation:dshTgShimmer 1.25s ease-in-out infinite;',
    '}',

    // 底栏
    '.dsh-tg-foot{display:flex;align-items:center;gap:6px;padding:0 12px 9px;font-size:11px;color:var(--tg-muted)}',
    '.dsh-tg-dot{width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.55;flex:0 0 auto}',
  ].join('\n')

  function ensureStyle() {
    if (document.getElementById('dsh-tg-style')) return
    var st = document.createElement('style')
    st.id = 'dsh-tg-style'
    st.textContent = CSS
    ;(document.head || document.documentElement).appendChild(st)
  }

  // ------------------------------------------------------------ 工具
  function isDark() {
    try {
      var el = document.documentElement
      var attr = String(el.getAttribute('data-theme') || '').toLowerCase()
      if (attr.indexOf('dark') >= 0) return true
      if (attr.indexOf('light') >= 0) return false
      var cls = el.className || ''
      if (typeof cls === 'string') {
        if (/(^|\s)(dark|theme-dark)(\s|$)/.test(cls)) return true
        if (/(^|\s)(light|theme-light)(\s|$)/.test(cls)) return false
      }
      var bd = document.body && document.body.className
      if (typeof bd === 'string' && /(^|\s)(dark|theme-dark)(\s|$)/.test(bd)) return true
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
    } catch (err) {
      return false
    }
  }

  function countMatches(text, re) {
    var m = text.match(re)
    return m ? m.length : 0
  }

  // 已经是中文（或没有可译的字母）就不必翻：避免"选中文→请求→原样返回"这种无用功。
  // 日语/韩语会因为假名/谚文而被判为"需要翻译"。
  function isAlreadyChinese(text) {
    var words = countMatches(text, /[\p{L}]/gu)
    if (words === 0) return true
    var kana = countMatches(text, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu)
    var hangul = countMatches(text, /[\p{Script=Hangul}]/gu)
    if (kana + hangul > 0) return false
    var han = countMatches(text, /\p{Script=Han}/gu)
    return han / words >= 0.8
  }

  var LANG_NAMES = {
    en: '英语', ja: '日语', ko: '韩语', fr: '法语', de: '德语', es: '西班牙语',
    ru: '俄语', pt: '葡萄牙语', it: '意大利语', ar: '阿拉伯语', th: '泰语',
    vi: '越南语', id: '印尼语', nl: '荷兰语', pl: '波兰语', tr: '土耳其语',
    hi: '印地语', sv: '瑞典语', uk: '乌克兰语', cs: '捷克语', el: '希腊语',
    he: '希伯来语', fa: '波斯语', ms: '马来语', da: '丹麦语', fi: '芬兰语',
    no: '挪威语', hu: '匈牙利语', ro: '罗马尼亚语', bg: '保加利亚语',
  }
  function langName(code) {
    if (!code) return ''
    var c = String(code).toLowerCase()
    return LANG_NAMES[c] || c.toUpperCase()
  }

  function targetName(to) {
    if (!to) return '简体中文'
    if (/^zh(-|$)/i.test(to)) return '简体中文'
    return langName(to)
  }

  var SVG = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  }

  // ------------------------------------------------------------ 卡片
  var card = null
  var els = null
  var state = { text: '', result: null, error: '', to: 'zh-Hans', visible: false, token: 0 }
  var cache = new Map()
  var inflight = null
  var hideTimer = null

  function buildCard() {
    ensureStyle()
    card = document.createElement('div')
    card.className = 'dsh-tg-card'
    card.setAttribute('data-state', 'loading')
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-label', '翻译结果')
    card.innerHTML =
      '<div class="dsh-tg-head">' +
      '<span class="dsh-tg-badge">译</span>' +
      '<span class="dsh-tg-meta"></span>' +
      '<span class="dsh-tg-grow"></span>' +
      '<button class="dsh-tg-btn" data-act="copy" title="复制译文">' + SVG.copy + '</button>' +
      '<button class="dsh-tg-btn" data-act="retry" title="重新翻译">' + SVG.retry + '</button>' +
      '<button class="dsh-tg-btn" data-act="close" title="关闭（Esc）">' + SVG.close + '</button>' +
      '</div>' +
      '<div class="dsh-tg-body"></div>' +
      '<div class="dsh-tg-foot"></div>'
    els = {
      meta: card.querySelector('.dsh-tg-meta'),
      body: card.querySelector('.dsh-tg-body'),
      foot: card.querySelector('.dsh-tg-foot'),
      copy: card.querySelector('[data-act="copy"]'),
      retry: card.querySelector('[data-act="retry"]'),
      close: card.querySelector('[data-act="close"]'),
    }
    card.addEventListener('mousedown', function (e) {
      // 卡片内的点击不应该被"点外面即关闭"的逻辑吃掉
      e.stopPropagation()
    })
    card.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null
      if (!btn) return
      var act = btn.getAttribute('data-act')
      if (act === 'close') hide()
      else if (act === 'retry') run(state.text, { force: true })
      else if (act === 'copy') doCopy()
    })
    card.style.display = 'none'
    document.body.appendChild(card)
    return card
  }

  function ensureCard() {
    if (card && card.isConnected) return card
    card = null
    els = null
    return buildCard()
  }

  function renderSkeleton() {
    var rows = [['62%'], ['96%'], ['84%'], ['45%']]
    var html = '<div class="dsh-tg-skel">'
    for (var i = 0; i < rows.length; i++) {
      html += '<i style="width:' + rows[i][0] + '"></i>'
    }
    return html + '</div>'
  }

  function render() {
    if (!card) return
    card.setAttribute('data-theme', isDark() ? 'dark' : 'light')
    card.setAttribute('data-state', state.error ? 'error' : state.result ? 'done' : 'loading')

    if (state.error) {
      els.meta.textContent = '翻译失败'
      els.body.innerHTML =
        '<div class="dsh-tg-err"><b>没翻出来：</b>' + escapeHtml(state.error) + '</div>' +
        '<span class="dsh-tg-hint">点右上角的 ⟳ 可以重试。若一直失败，通常是公共翻译接口暂时不可用或额度用尽。</span>'
      els.foot.textContent = ''
      els.copy.style.display = 'none'
      return
    }
    els.copy.style.display = ''

    if (!state.result) {
      els.meta.textContent = '正在翻译…'
      els.body.innerHTML = renderSkeleton()
      els.foot.textContent = ''
      return
    }

    var r = state.result
    var from = langName(r.detected)
    els.meta.textContent = (from ? from + ' → ' : '') + targetName(state.to)
    els.body.textContent = r.translation

    var parts = []
    parts.push(r.provider || '')
    if (r.chars) parts.push(r.chars + ' 字符')
    if (r.cached) parts.push('命中缓存')
    parts.push('Esc 关闭')
    els.foot.innerHTML =
      parts
        .filter(Boolean)
        .map(function (p) {
          return escapeHtml(p)
        })
        .join('<span class="dsh-tg-dot"></span>')
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function place(rect) {
    if (!card) return
    var vw = window.innerWidth
    var vh = window.innerHeight
    var gap = 8

    card.style.visibility = 'hidden'
    card.style.display = 'block'
    // || 0 是防御：布局尚未完成时 offsetWidth/Height 可能是 0，别让 NaN 污染定位
    var w = card.offsetWidth || 0
    var h = card.offsetHeight || 0

    var top = rect.bottom + gap
    if (top + h > vh - 8) {
      var above = rect.top - h - gap
      top = above >= 8 ? above : Math.max(8, vh - h - 8)
    }
    var left = rect.left
    left = Math.min(Math.max(8, left), Math.max(8, vw - w - 8))

    card.style.top = Math.round(top) + 'px'
    card.style.left = Math.round(left) + 'px'
    card.style.visibility = ''
  }

  function show(text, rect) {
    ensureCard()
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    // 换了选区就先清掉上一段的结果，否则会先闪一下旧译文再切成骨架屏
    if (text !== state.text) {
      state.result = null
      state.error = ''
    }
    state.visible = true
    card.style.display = 'block'
    render()
    place(rect)
  }

  function hide() {
    if (!card) return
    state.visible = false
    state.text = ''
    state.result = null
    state.error = ''
    state.token++ // 让在途响应作废：迟到的结果不该画到下一次选区上
    if (inflight) {
      try {
        inflight.abort()
      } catch (err) {}
      inflight = null
    }
    card.style.display = 'none'
  }

  // ------------------------------------------------------------ 取译文
  function doCopy() {
    if (!state.result) return
    var text = state.result.translation
    var done = function () {
      els.copy.setAttribute('data-done', '1')
      els.copy.innerHTML = SVG.check
      setTimeout(function () {
        if (!els) return
        els.copy.removeAttribute('data-done')
        els.copy.innerHTML = SVG.copy
      }, 1100)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback)
    } else {
      fallback()
    }
    function fallback() {
      try {
        var ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        done()
      } catch (err) {}
    }
  }

  function run(text, opts) {
    opts = opts || {}
    state.text = text
    state.error = ''
    state.result = null

    if (!opts.force) {
      var hit = cache.get(text)
      if (hit) {
        state.result = Object.assign({}, hit, { cached: true })
        render()
        return
      }
    }

    render()
    if (inflight) {
      try {
        inflight.abort()
      } catch (err) {}
    }
    var ac = typeof AbortController === 'function' ? new AbortController() : null
    inflight = ac
    var token = ++state.token

    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, force: !!opts.force }),
      signal: ac ? ac.signal : undefined,
      credentials: 'same-origin',
    })
      .then(function (res) {
        return res.json().then(function (j) {
          return { status: res.status, json: j }
        })
      })
      .then(function (r) {
        if (token !== state.token) return // 已经有更新的选区了
        inflight = null
        if (!r.json || !r.json.ok) {
          state.error = (r.json && r.json.error) || 'HTTP ' + r.status
        } else {
          state.result = r.json
          state.to = r.json.to || state.to
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
          cache.set(text, r.json)
        }
        render()
      })
      .catch(function (err) {
        if (token !== state.token) return
        inflight = null
        if (err && err.name === 'AbortError') return
        state.error = (err && err.message) || '网络错误'
        render()
      })
  }

  // ------------------------------------------------------------ 选区监听
  var timer = null

  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(check, DEBOUNCE_MS)
  }

  function inEditable(el) {
    if (!el || !el.closest) return false
    return !!el.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"],.dsh-tg-card')
  }

  function check() {
    var sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
    var raw = sel.toString()
    if (!raw) return
    var text = raw.replace(/^\s+|\s+$/g, '')
    if (text.length < MIN_CHARS) return
    if (text.length > MAX_CHARS) {
      // 太长就不翻，避免把一整篇文档丢出去
      return
    }

    var range = sel.getRangeAt(0)
    var node = range.startContainer
    var el = node && node.nodeType === 1 ? node : node && node.parentElement
    if (inEditable(el)) return
    if (isAlreadyChinese(text)) return

    // Ctrl+A 全选整页时不该弹卡片：那既不是"划词"，也会把整篇内容发出去
    try {
      var bodyText = (document.body && document.body.innerText ? document.body.innerText : '').replace(/^\s+|\s+$/g, '')
      if (bodyText && text === bodyText) return
    } catch (err) {}

    var rects = range.getClientRects ? range.getClientRects() : null
    var rect = null
    if (rects && rects.length) rect = rects[rects.length - 1]
    if (!rect || (!rect.width && !rect.height)) rect = range.getBoundingClientRect()
    if (!rect || (!rect.width && !rect.height)) return

    show(text, rect)
    run(text, {})
  }

  document.addEventListener(
    'mouseup',
    function (e) {
      if (card && card.contains(e.target)) return
      schedule()
    },
    true,
  )

  document.addEventListener(
    'keyup',
    function (e) {
      // 键盘选择（Shift+方向键 / Ctrl+A）也要能触发
      if (e.key === 'Shift' || e.shiftKey || (e.ctrlKey && (e.key === 'a' || e.key === 'A'))) schedule()
    },
    true,
  )

  document.addEventListener(
    'mousedown',
    function (e) {
      if (card && card.contains(e.target)) return
      if (state.visible) hide()
    },
    true,
  )

  document.addEventListener(
    'keydown',
    function (e) {
      if (e.key === 'Escape' && state.visible) hide()
    },
    true,
  )

  // 页面滚动/缩放时选区会跟着动，卡片继续钉在原位就会错位 —— 直接收起最不容易看起来出错。
  // 但卡片自己内部的滚动（长译文）不能把自己关掉，所以要看 e.target。
  window.addEventListener(
    'scroll',
    function (e) {
      if (card && e.target && card.contains(e.target)) return
      if (state.visible) hide()
    },
    true,
  )
  window.addEventListener('resize', function () {
    if (state.visible) hide()
  })

  // 主题切换时跟着变（DSH 的 ui-theme 支持跟随系统）
  if (window.matchMedia) {
    try {
      var mq = window.matchMedia('(prefers-color-scheme: dark)')
      var onTheme = function () {
        if (state.visible) render()
      }
      if (mq.addEventListener) mq.addEventListener('change', onTheme)
      else if (mq.addListener) mq.addListener(onTheme)
    } catch (err) {}
  }

  // 预读一次配置，拿到目标语言（失败也无所谓，translate 会用宿主默认值）
  try {
    fetch(CONFIG_API, { credentials: 'same-origin' })
      .then(function (r) {
        return r.json()
      })
      .then(function (j) {
        if (j && j.ok && j.config && j.config.to) state.to = j.config.to
      })
      .catch(function () {})
  } catch (err) {}
})()
