# Tsuzuri translation proxy

A minimal Cloudflare Worker that lets the PWA translate selected sentences
without exposing an API key or hitting CORS. It proxies [DeepL](https://www.deepl.com/pro-api).

## Why a proxy?
Browsers can't call DeepL/Google/Microsoft translation APIs directly: those APIs
don't send CORS headers and would expose your API key. This worker keeps the key
server-side and returns a small JSON response the app understands.

## Contract
```
POST /
  { "text": "…", "source": "ja", "target": "en" }
->
  { "result": "…", "engine": "deepl" }
```
This matches `src/services/translate.ts` and the dev middleware in
`vite-plugins/dev-translate.ts`.

## Deploy
```sh
cd proxy
npm i -g wrangler            # or: npx wrangler
wrangler secret put DEEPL_API_KEY   # paste your DeepL Free/Pro key
wrangler deploy
```
DeepL's **Free** tier allows 500k characters/month.

## Point the app at it
Either:
- Serve the worker at `/api/translate` on the same origin as the PWA (a route or
  Pages Function), so the default `TRANSLATE_ENDPOINT` just works; or
- Change `TRANSLATE_ENDPOINT` in `src/services/translate.ts` to the worker URL
  and set `ALLOW_ORIGIN` in `wrangler.toml` to your PWA origin.

## Swapping engines
Replace the DeepL call in `worker.ts` with Google Cloud Translation or Microsoft
Translator — keep the `{ result, engine }` response shape and nothing else changes.
