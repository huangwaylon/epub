import type { Plugin } from 'vite'

/**
 * Dev-only translation endpoint. Mirrors the production Cloudflare Worker's
 * contract (POST {text, source, target} -> {result, engine}) but uses Google's
 * keyless gtx endpoint server-side so the reader's translate flow is testable
 * locally without deploying the proxy. NOT for production use.
 */
export function devTranslate(): Plugin {
  return {
    name: 'dev-translate',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/translate', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end('Method Not Allowed')
        }
        try {
          const body = await readJson(req)
          const { text, source = 'ja', target = 'en' } = body
          const url =
            `https://translate.googleapis.com/translate_a/single?client=gtx` +
            `&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`
          const upstream = await fetch(url)
          const data: any = await upstream.json()
          const result = (data?.[0] ?? []).map((seg: any[]) => seg[0]).join('')
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ result, engine: 'google (dev)' }))
        } catch (err) {
          res.statusCode = 502
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}

function readJson(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c))
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}
