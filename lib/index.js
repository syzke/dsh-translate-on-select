// dsh-translate-on-select —— 宿主侧插件。
//
// 职责：① 往页面注入前端脚本；② 提供一个把选中文本翻译成中文的本地接口。
// 真正的翻译在后端 providers.mjs 里做（公共接口，无需 key），这样既绕开 CORS，
// 也能把缓存/分片/多后端回退集中在一处。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { translate } from './providers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const CLIENT_PATH = '/dsh-translate/client.js'
const API_PATH = '/dsh-translate/translate'
const CONFIG_PATH = '/dsh-translate/config'

// 前端脚本的候选位置（link 安装时 assets/ 与 lib/ 是兄弟目录；直接铺平时也能找到）
const CLIENT_FILE_CANDIDATES = [
  path.join(HERE, '..', 'assets', 'translate.js'),
  path.join(HERE, 'translate.js'),
]

// 每次请求按 mtime 判断是否重读，改完前端硬刷新即可生效，不必重启客户端。
let clientCache = null
function loadClientJs() {
  for (const p of CLIENT_FILE_CANDIDATES) {
    try {
      const st = fs.statSync(p)
      if (clientCache && clientCache.mtimeMs === st.mtimeMs) return clientCache.text
      const text = fs.readFileSync(p, 'utf8')
      clientCache = { text, mtimeMs: st.mtimeMs }
      return text
    } catch (err) {
      /* 试下一个候选 */
    }
  }
  return clientCache ? clientCache.text : ''
}

// 桌面端唯一可用的注入通道是 webserver/index-inject 的结构化行，而且**宿主启动时只收集一次**。
// 行必须是内联脚本（kind:'script'）：页面侧解释器对 kind:'script-src' 是“加载失败即 reject 整个
// boot”，插件被停用/路由注销时会直接把应用拖死。内联行里我们自己建 <script src> 并吞掉 onerror，
// 路由在就正常加载，不在就静默失败，宿主永远不会因为我们起不来。
const INJECT_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'if(window.__dshTranslateOnSelect)return;' +
  'var s=document.createElement("script");s.src="' + CLIENT_PATH + '";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

// ------------------------------------------------------------------ 配置
// 只存目标语言与总开关，放 $DSH_HOME 下，跟其他 DSH 插件数据保持一致。
const CONFIG_FILE = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.dsh-translate.json')
const DEFAULT_CONFIG = { to: 'zh-Hans', enabled: true }

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return Object.assign({}, DEFAULT_CONFIG, parsed && typeof parsed === 'object' ? parsed : {})
  } catch (err) {
    return Object.assign({}, DEFAULT_CONFIG)
  }
}

function writeConfig(patch) {
  const next = Object.assign(readConfig(), patch || {})
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    /* 落盘失败不致命：本次仍按 next 返回 */
  }
  return next
}

// ------------------------------------------------------------------ 信任栅栏
// 与 dsh-whale-widget 同款三层策略：自身校验 → 宿主栅栏 → fail-closed。
function makeFence(ctx) {
  const trusted = String(process.env.DSH_TRANSLATE_TRUSTED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

  function isLoopbackHostname(hn) {
    const h = String(hn || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
    if (!h) return false
    if (h === 'localhost' || h.endsWith('.localhost')) return true
    if (h === '::1') return true
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
    if (!m || Number(m[1]) !== 127) return false
    return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
  }

  function connectionFence() {
    try {
      const conn = ctx.get('connection') || ctx.connection
      return conn && typeof conn.requestRejection === 'function' ? conn : null
    } catch (err) {
      return null
    }
  }

  return function rejection(req) {
    try {
      const headers = (req && req.headers) || {}
      // 跨站标记一律拒（防恶意网页借浏览器打本机接口）
      if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403

      let hostUrl = null
      try {
        hostUrl = new URL('http://' + String(headers.host || ''))
      } catch (err) {
        return 403
      }
      const authority = hostUrl.host.toLowerCase()

      // Origin 与 Host 必须同源（Origin 为 'null' 时跳过，桌面外壳是自定义协议）
      const origin = headers.origin
      if (typeof origin === 'string' && origin && origin !== 'null') {
        let originUrl = null
        try {
          originUrl = new URL(origin)
        } catch (err) {
          return 403
        }
        if (originUrl.host.toLowerCase() !== authority) return 403
      }

      const conn = connectionFence()
      if (!conn) {
        // 没有宿主栅栏时，只放行回环或显式声明的主机
        if (!isLoopbackHostname(hostUrl.hostname)) {
          const ok = trusted.some((e) =>
            e.indexOf(':') >= 0 ? e === authority : e === hostUrl.hostname.toLowerCase(),
          )
          if (!ok) return 403
        }
        return 0
      }
      let code
      try {
        code = conn.requestRejection(req)
      } catch (err) {
        return 403 // 栅栏自己抛异常 → 按拒绝处理
      }
      if (code === undefined || code === null || code === false) return 0
      return typeof code === 'number' ? code : 403
    } catch (err) {
      return 403
    }
  }
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export default {
  name: 'dsh-translate-on-select',
  apply(root) {
    const rowDisposers = []
    root.effect(() => () => {
      for (const d of rowDisposers) {
        try {
          d()
        } catch (err) {}
      }
    })

    // ① 注入行必须**尽早**注册（桌面端的注入表是宿主启动时一次性收集的），
    //    它不依赖任何服务，所以放在 apply 的最前面，不进 root.inject。
    rowDisposers.push(
      root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script-src' && row.src === CLIENT_PATH) return
            if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(CLIENT_PATH) >= 0) return
          }
          table.push({ kind: 'script', placement: 'body', text: INJECT_TEXT })
        } catch (err) {}
      }),
    )

    // ② 其余逻辑等 webServer 就绪（局部等待，不阻塞 ①）
    root.inject(['webServer'], (ctx) => {
      const rejection = makeFence(ctx)
      const disposers = []

      // 统一注册入口：所有路由自动套上信任栅栏
      function registerRoute(route) {
        const inner = route && route.handler
        return ctx.webServer.register(
          Object.assign({}, route, {
            handler: async (req, res) => {
              const code = rejection(req)
              if (code) {
                try {
                  res.statusCode = code
                  res.end()
                } catch (err) {}
                return
              }
              return inner(req, res)
            },
          }),
        )
      }

      // 前端脚本
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: CLIENT_PATH,
          handler: (req, res) => {
            res.writeHead(200, {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            res.end(loadClientJs())
          },
        }),
      )

      // 当前配置（只读，方便前端显示目标语言）
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: CONFIG_PATH,
          handler: (req, res) => sendJson(res, 200, { ok: true, config: readConfig() }),
        }),
      )

      // 翻译
      disposers.push(
        registerRoute({
          kind: 'exact',
          path: API_PATH,
          handler: async (req, res) => {
            if (String(req.method || 'GET').toUpperCase() !== 'POST') {
              sendJson(res, 405, { ok: false, error: '只支持 POST' })
              return
            }
            let payload = null
            try {
              payload = JSON.parse(await readBody(req))
            } catch (err) {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
              return
            }
            const text = typeof payload.text === 'string' ? payload.text : ''
            if (!text.trim()) {
              sendJson(res, 400, { ok: false, error: '没有要翻译的文本' })
              return
            }
            if (text.length > 20000) {
              sendJson(res, 413, { ok: false, error: '选中内容太长（上限 20000 字符）' })
              return
            }
            const config = readConfig()
            if (!config.enabled) {
              sendJson(res, 200, { ok: false, error: '插件已在配置里关闭', disabled: true })
              return
            }
            try {
              const result = await translate(text, { to: config.to || 'zh-Hans', force: !!payload.force })
              sendJson(res, 200, Object.assign({ ok: true, to: config.to || 'zh-Hans' }, result))
            } catch (err) {
              sendJson(res, 502, { ok: false, error: (err && err.message) || String(err) })
            }
          },
        }),
      )

      // web（dsh web / 浏览器）形态：桌面端走不到这里，它从静态 dist 直出 index.html
      disposers.push(
        ctx.webServer.tapIndex((html) => {
          if (typeof html !== 'string' || html.indexOf(CLIENT_PATH) !== -1) return html
          const tag = '<script defer src="' + CLIENT_PATH + '"></script>'
          if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
          return html + tag
        }),
      )

      ctx.effect(() => () => {
        for (const d of disposers) {
          try {
            d()
          } catch (err) {}
        }
      })
    })
  },
}
