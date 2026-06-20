import { getCachedTranslation, putCachedTranslation } from './storage/db'

/**
 * Sentence/paragraph translation. Calls a same-origin endpoint that proxies a
 * translation API (CORS + API-key hiding can't happen in the browser). In dev a
 * Vite middleware serves `/api/translate`; in production deploy the Cloudflare
 * Worker in /proxy and point TRANSLATE_ENDPOINT at it. Results are cached in
 * IndexedDB so re-opening a translated passage works offline.
 */

export const TRANSLATE_ENDPOINT = '/api/translate'

export interface TranslationResult {
  result: string
  engine: string
  cached: boolean
}

/** Small, stable, non-crypto hash for cache keys. */
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export class TranslateError extends Error {}

export async function translate(
  text: string,
  target: string,
  source = 'ja',
): Promise<TranslationResult> {
  const trimmed = text.trim()
  if (!trimmed) throw new TranslateError('Nothing to translate.')

  const key = `${target}:${hash(trimmed)}`
  const cached = await getCachedTranslation(key)
  if (cached) return { result: cached.result, engine: cached.engine, cached: true }

  if (!navigator.onLine) throw new TranslateError('Offline — connect to translate new text.')

  let res: Response
  try {
    res = await fetch(TRANSLATE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: trimmed, source, target }),
    })
  } catch {
    throw new TranslateError('Could not reach the translation service.')
  }
  if (!res.ok) throw new TranslateError(`Translation failed (${res.status}).`)

  const data = (await res.json()) as { result?: string; engine?: string }
  if (!data.result) throw new TranslateError('No translation returned.')

  const engine = data.engine ?? 'mt'
  await putCachedTranslation({
    key,
    text: trimmed,
    target,
    result: data.result,
    engine,
    createdAt: Date.now(),
  })
  return { result: data.result, engine, cached: false }
}
