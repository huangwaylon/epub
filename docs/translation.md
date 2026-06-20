# Translation (sentence / paragraph)

Machine translation of **selected text** in the reader. This is distinct from the
Japanese **dictionary** (word-level glosses): the dictionary runs fully on-device
(JMdict in its own IndexedDB) and always returns **English**; translation sends a
whole selection to a network service and targets `settings.translationTargetLang`.

| Concern | Word lookup (dictionary) | Sentence translation (this doc) |
| --- | --- | --- |
| Trigger | tap a Japanese word | select text → "Translate" in the toolbar |
| Source | `src/services/jp/*`, JMdict (10ten) | `src/services/translate.ts` → `/api/translate` |
| Network | none (offline) | required for new text; cached results work offline |
| Target language | always English | `settings.translationTargetLang` (en/zh/ko/es) |

---

## 1. Overview & why a proxy

Browsers **cannot** call DeepL / Google Cloud Translation / Microsoft Translator
directly:

- Those APIs send **no CORS headers**, so a browser `fetch` is blocked.
- Calling them from the client would **expose the API key** in shipped JS / network
  traffic.
- Safari (the primary target — this is an iOS-installable PWA) has **no on-device or
  Web translation API** the app could use instead.

So translation goes through a **same-origin** endpoint, `POST /api/translate`, that
holds the key server-side and re-emits a small CORS-friendly JSON response. The
client (`translate.ts`) never knows which engine is behind the endpoint — it only
speaks the contract below.

Two implementations of that endpoint exist:

| Environment | Implementation | Engine | Notes |
| --- | --- | --- | --- |
| `vite dev` | `vite-plugins/dev-translate.ts` (Vite middleware) | Google keyless `gtx` | dev/testing only |
| production | `proxy/worker.ts` (Cloudflare Worker) | DeepL | holds `DEEPL_API_KEY` secret |

---

## 2. The contract

A single request/response shape, implemented by **both** the dev middleware and the
production worker. `translate.ts` depends only on this.

```
POST /api/translate
Content-Type: application/json
  { "text": "…", "source": "ja", "target": "en" }   // source/target optional
->
  { "result": "…", "engine": "deepl" }               // engine is a free-form label
```

- `source` defaults to `'ja'` (client sends it explicitly; both servers default it
  too — worker omits `source_lang` if absent, middleware uses `'ja'`).
- `target` defaults to `'en'` server-side; the client always sends
  `settings.translationTargetLang`.
- `engine` is a human-readable label surfaced in the UI footer
  (`'deepl'`, `'google (dev)'`, or the client fallback `'mt'`).
- Non-2xx responses and error bodies (`{ "error": "…" }`) are treated by the client
  as failures (see error paths). Status codes used by the servers: `400` invalid/empty,
  `405` non-POST, `502` upstream failure.

---

## 3. Client — `src/services/translate.ts`

```ts
export const TRANSLATE_ENDPOINT = '/api/translate'

export interface TranslationResult { result: string; engine: string; cached: boolean }

export class TranslateError extends Error {}

export async function translate(
  text: string,
  target: string,
  source = 'ja',
): Promise<TranslationResult>
```

**Cache key.** A small, stable, non-crypto **djb2** hash (`hash(s)`, seed `5381`,
base-36) of the *trimmed* text, namespaced by target language:

```
key = `${target}:${hash(trimmedText)}`
```

Same text + same target → same key, so `en:` and `zh:` translations of one passage
coexist. (Note: the comments in `db.ts` say `sha1(text)`; the actual code uses djb2.
The hash is for cache identity only, not security, so collisions are merely a
theoretical cache mix-up.)

**Control flow** (in order):

1. `trimmed = text.trim()`; if empty → `throw new TranslateError('Nothing to translate.')`.
2. Look up `getCachedTranslation(key)` in the IndexedDB `translations` store. On a hit,
   return `{ result, engine, cached: true }` immediately — **no network, works offline.**
3. If `!navigator.onLine` → `throw new TranslateError('Offline — connect to translate new text.')`.
4. `POST` JSON `{ text: trimmed, source, target }` to `TRANSLATE_ENDPOINT`.
5. On success, `putCachedTranslation({ key, text, target, result, engine, createdAt })`
   and return `{ result, engine, cached: false }`.

**Error paths** (all throw `TranslateError`, except the empty-string guard which
throws before any I/O):

| Condition | Message |
| --- | --- |
| empty after trim | `Nothing to translate.` |
| `!navigator.onLine` (and no cache hit) | `Offline — connect to translate new text.` |
| `fetch` itself rejects (network/DNS/CORS) | `Could not reach the translation service.` |
| `!res.ok` | `Translation failed (<status>).` |
| 2xx but no `result` field | `No translation returned.` |

`engine` falls back to `'mt'` if the server omits it. Callers distinguish expected
failures (`e instanceof TranslateError`, show `e.message`) from unexpected ones.

---

## 4. Dev middleware — `vite-plugins/dev-translate.ts`

A Vite plugin (`name: 'dev-translate'`, `apply: 'serve'`) whose `configureServer`
mounts a middleware on `/api/translate`. **Dev/testing only** — it is *not* part of a
production build (`apply: 'serve'` means it exists only under `vite dev`).

Behaviour:

1. Non-`POST` → `405 Method Not Allowed`.
2. Reads + JSON-parses the request body (`readJson` helper: streams `data` chunks,
   parses on `end`; empty body → `{}`).
3. Destructures `{ text, source = 'ja', target = 'en' }`.
4. Calls Google's **keyless** endpoint **server-side** (no CORS / no key needed there):
   ```
   https://translate.googleapis.com/translate_a/single?client=gtx&sl=<source>&tl=<target>&dt=t&q=<text>
   ```
5. Flattens the nested array response into one string:
   ```ts
   const result = (data?.[0] ?? []).map((seg) => seg[0]).join('')
   ```
6. Returns `{ result, engine: 'google (dev)' }`.
7. Any throw → `502` with `{ error: String(err) }`.

Wired in `vite.config.ts`:

```ts
import { devTranslate } from './vite-plugins/dev-translate'
export default defineConfig({
  plugins: [ svelte(), devTranslate(), VitePWA({ /* … */ }) ],
})
```

The keyless `gtx` endpoint is undocumented/unstable and unsuitable for production —
hence the explicit `'(dev)'` engine label and the production worker.

---

## 5. Production worker — `proxy/`

A Cloudflare Worker (`proxy/worker.ts`) implementing the same contract against
**DeepL**. Files: `worker.ts`, `wrangler.toml`, `README.md`.

**Environment / bindings (`Env`):**

| Name | Kind | Purpose |
| --- | --- | --- |
| `DEEPL_API_KEY` | **secret** (required) | `Authorization: DeepL-Auth-Key <key>` |
| `DEEPL_API_URL` | var (optional) | override endpoint; set to `https://api.deepl.com/v2/translate` for a **Pro** key. Default: `https://api-free.deepl.com/v2/translate` |
| `ALLOW_ORIGIN` | var (optional) | CORS allow-origin; defaults to `*` |

**Request handling (`fetch(request, env)`):**

1. CORS headers built from `env.ALLOW_ORIGIN ?? '*'`:
   `Access-Control-Allow-{Origin,Methods: 'POST, OPTIONS',Headers: 'Content-Type'}`.
2. `OPTIONS` → `204`-style empty `Response(null, { headers: cors })` (preflight).
3. Non-`POST` → `405`.
4. `request.json()`; parse failure → `400 { error: 'Invalid JSON' }`.
5. **Caps text at 5000 chars**: `text = (body.text ?? '').slice(0, 5000)`; empty after
   trim → `400 { error: 'Empty text' }`.
6. Builds form-encoded body: `text`, `target_lang = (target ?? 'EN').toUpperCase()`,
   and `source_lang` only if `body.source` is present (upper-cased).
7. `POST` to DeepL form-encoded with `Authorization: DeepL-Auth-Key ${env.DEEPL_API_KEY}`.
8. `!upstream.ok` → `502 { error: 'DeepL <status>' }`.
9. Else parse `{ translations: [{ text }] }`, return `{ result: translations[0]?.text ?? '', engine: 'deepl' }`.

**`wrangler.toml`:**

```toml
name = "tsuzuri-translate"
main = "worker.ts"
compatibility_date = "2024-11-01"
# [vars]
# DEEPL_API_URL = "https://api.deepl.com/v2/translate"   # Pro key
# ALLOW_ORIGIN  = "https://your-pwa.example"             # lock CORS
```

**Deploy (`proxy/README.md`):**

```sh
cd proxy
npm i -g wrangler                  # or: npx wrangler
wrangler secret put DEEPL_API_KEY  # paste DeepL Free/Pro key
wrangler deploy
```

Then either (a) serve the worker at **`/api/translate` on the same origin** as the
PWA (a route / Pages Function) so the default `TRANSLATE_ENDPOINT` just works, or
(b) change `TRANSLATE_ENDPOINT` in `src/services/translate.ts` to the worker URL and
set `ALLOW_ORIGIN` in `wrangler.toml` to your PWA origin (cross-origin requires the
CORS headers the worker already emits).

---

## 6. UI integration

```
text selection  →  SelectionToolbar (Translate button)
                →  Reader.translateSelection()
                →  TranslationSheet (inside a Sheet)
                →  translate(text, settings.translationTargetLang)
```

- **`SelectionToolbar.svelte`** renders a floating bar over the selection. The
  translate button (`Icon name="translate"`) is shown when `showTranslate` (default
  `true`) and calls `onTranslate`. (For the *highlight-edit* toolbar Reader passes
  `showTranslate={false}`.)
- **`Reader.svelte` → `translateSelection()`** copies the selection text into local
  state and opens the sheet:
  ```ts
  function translateSelection() {
    translateText = sel.text
    translateOpen = true
    controller?.clearSelection()
    sel.open = false
  }
  ```
  Rendered as: `<Sheet bind:open={translateOpen} title="Translation"><TranslationSheet bind:open={translateOpen} text={translateText} /></Sheet>`.
- **`TranslationSheet.svelte`** props: `open` (bindable) and `text`. A `$effect`
  re-runs `run()` whenever the composite key `${open}:${settings.translationTargetLang}:${text}`
  changes while `open && text` (deduped via `lastKey`, reset when closed) — so
  changing the target language or selecting new text re-translates, but merely
  re-rendering does not. States rendered: **loading** (spinner), **error** (message +
  "Try again" button calling `run`), **result** (translation + `engine` label +
  "Copy" via `navigator.clipboard.writeText`). Errors that are `TranslateError` show
  `e.message`; anything else shows `'Translation failed.'`.

The target language is chosen in **Settings** (`ShelfSettings.svelte` → "Translation
language" `Segmented`): `en` / `zh` / `ko` / `es`, written via
`updateSettings({ translationTargetLang: v })`. A hint there notes word lookups stay
English.

---

## 7. Configuration

| What | How |
| --- | --- |
| Point app at a deployed proxy (same origin) | Serve the worker at `/api/translate`; leave `TRANSLATE_ENDPOINT` default. |
| Point app at a cross-origin proxy | Edit `TRANSLATE_ENDPOINT` in `translate.ts` to the worker URL **and** set `ALLOW_ORIGIN` in `wrangler.toml`. |
| Target language | Settings → Translation language (persists in IndexedDB `settings`/`reader` via `updateSettings`). Add options by editing `langOpts` in `ShelfSettings.svelte`. |
| Use DeepL Pro | Set `DEEPL_API_URL = https://api.deepl.com/v2/translate` var; Pro key in the same `DEEPL_API_KEY` secret. |
| Cache | `translations` object store, keyed by `${target}:${hash(text)}`; never auto-evicted in code (see Gotchas). |

---

## 8. How to extend / swap engines

Because the client only depends on the §2 contract, you can replace the engine
without touching `translate.ts` or the UI — **keep the `{ result, engine }` shape.**

- **Swap DeepL for another engine.** In `worker.ts`, replace the DeepL `fetch` +
  response parsing with the target API (e.g. Google Cloud Translation `v2/v3` or
  Microsoft Translator), map the app's `{ text, source, target }` to that API's
  params, and return `{ result: <translated string>, engine: '<label>' }`. Update
  env/secret bindings accordingly. Nothing downstream changes (the UI just shows the
  new `engine` label).
- **Add a glossary.** For DeepL, append `glossary_id` (Pro) to the form params, or
  pre/post-process `result` in the worker. App-side caching is keyed only on
  `target` + text, so changing glossary behaviour may warrant bumping the cache key
  scheme.
- **Per-book source-language override.** `BookMeta.language` (BCP-47, e.g. `"ja"`) is
  available in `Reader.svelte` (`meta`). Pass it down to `TranslationSheet` and into
  `translate(text, target, source)` (third arg, default `'ja'`) so non-Japanese books
  translate from their declared language. The worker already forwards `source_lang`
  when `source` is present.

---

## 9. Gotchas

- **Dev middleware exists only under `vite dev`.** A `vite build` / `vite preview`
  output (the real installed PWA) has **no** `/api/translate` unless you deploy the
  worker — otherwise translation requests `fetch` a non-existent route and fail with
  "Could not reach the translation service." / a non-2xx.
- **Cache works offline; new text does not.** Re-opening a previously translated
  passage returns the cached result with no network. Translating *new* text requires
  connectivity (`navigator.onLine`); offline it throws the "Offline" error before any
  request.
- **DeepL Free ≈ 500k characters/month.** The worker caps each request at 5000 chars;
  there is no app-side monthly accounting. Watch quota on the DeepL dashboard.
- **The dictionary is independent.** Word-level lookups (tap-to-define) work fully
  offline via on-device JMdict regardless of whether translation is configured or the
  device is online.
- **Stale comment.** `db.ts` / `CachedTranslation.key` comments say `sha1(text)`; the
  implementation in `translate.ts` is djb2 (`hash`). Identity only — not security.
- **No cache eviction.** The `translations` store grows unbounded; entries carry
  `createdAt` but nothing prunes them. Counts against IndexedDB quota.

---

## 10. Cross-references

These are sibling docs under `docs/` (create-as-you-go; see flags at file end):

- `docs/architecture.md` — overall app structure (where translation fits among
  reader / storage / dictionary services).
- `docs/storage-pwa-ios.md` — the `translations` IndexedDB store and PWA/iOS offline
  caching model (`src/services/storage/db.ts`).
- `docs/reader-engine.md` — text selection (`SelectionInfo`, `SelectionToolbar`) that
  feeds `Reader.translateSelection()`.
- `docs/development.md` — running `vite dev` (where `dev-translate` is active),
  `vite build` / `vite preview`, and deploying the `proxy/` worker.
