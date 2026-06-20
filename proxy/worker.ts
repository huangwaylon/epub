/**
 * Production translation proxy for Tsuzuri.
 *
 * Holds the DeepL API key server-side and exposes a tiny CORS-enabled endpoint
 * that matches the client contract in src/services/translate.ts:
 *
 *   POST /  { text: string, source?: string, target?: string }
 *   ->      { result: string, engine: "deepl" }
 *
 * Deploy with `wrangler deploy` after setting the secret:
 *   wrangler secret put DEEPL_API_KEY
 * Then point the PWA's TRANSLATE_ENDPOINT at this worker's URL (or route it at
 * /api/translate on the same origin).
 */

export interface Env {
  DEEPL_API_KEY: string
  /** Set to "https://api.deepl.com/v2/translate" for a Pro key. */
  DEEPL_API_URL?: string
  /** Optional allow-list origin for CORS; defaults to "*". */
  ALLOW_ORIGIN?: string
}

const DEFAULT_DEEPL_URL = 'https://api-free.deepl.com/v2/translate'

function cors(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOW_ORIGIN ?? '*'
    const headers = { 'Content-Type': 'application/json', ...cors(origin) }

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) })
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers })

    let body: { text?: string; source?: string; target?: string }
    try {
      body = await request.json()
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers })
    }

    const text = (body.text ?? '').slice(0, 5000)
    if (!text.trim()) return new Response(JSON.stringify({ error: 'Empty text' }), { status: 400, headers })

    const params = new URLSearchParams()
    params.append('text', text)
    params.append('target_lang', (body.target ?? 'EN').toUpperCase())
    if (body.source) params.append('source_lang', body.source.toUpperCase())

    const upstream = await fetch(env.DEEPL_API_URL ?? DEFAULT_DEEPL_URL, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${env.DEEPL_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    })

    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: `DeepL ${upstream.status}` }), { status: 502, headers })
    }

    const data = (await upstream.json()) as { translations?: Array<{ text: string }> }
    const result = data.translations?.[0]?.text ?? ''
    return new Response(JSON.stringify({ result, engine: 'deepl' }), { headers })
  },
}
