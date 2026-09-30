// Browser harness for scripted checks: system Chrome via puppeteer-core.
//
//   import { launch, DEVICES, serve } from './lib.mjs'
//   const server = await serve('dev')            // or 'preview' (needs `npm run build`)
//   const { browser, page } = await launch('ipad', server.url)
//
// The content document lives in a closed-shadow iframe; in dev, `window.__tsuzuri`
// exposes it (see docs/development.md).
import { spawn } from 'node:child_process'
import puppeteer from 'puppeteer-core'

export const CHROME =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export const DEVICES = {
  iphone: { width: 393, height: 852, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  'iphone-landscape': { width: 852, height: 393, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: true },
  ipad: { width: 1194, height: 834, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true },
  'ipad-portrait': { width: 834, height: 1194, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
}

const SAFARI_UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
}

/** Start `vite` (dev, base /) or `vite preview` (dist, base /epub/) and wait for its URL.
 *  Spawns the vite binary itself (not npx), so `close()` stops the server that listens. */
export function serve(mode = 'dev', port = mode === 'dev' ? 5199 : 5299, { timeoutMs = 30000 } = {}) {
  const args = [...(mode === 'dev' ? [] : ['preview']), '--port', String(port), '--strictPort']
  const proc = spawn('node_modules/.bin/vite', args, { stdio: ['ignore', 'pipe', 'inherit'] })
  const url = `http://localhost:${port}${mode === 'dev' ? '/' : '/epub/'}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`vite did not start within ${timeoutMs} ms`))
    }, timeoutMs)
    proc.stdout.on('data', (d) => {
      if (!/Local:/.test(String(d))) return
      clearTimeout(timer)
      resolve({ url, close: () => proc.kill() })
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`vite exited ${code}`))
    })
  })
}

/** Fresh profile per launch, so every run is a first visit (empty OPFS/IDB/SW). */
export async function launch(device = 'ipad', url, { headless = true } = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless,
    args: ['--no-first-run', '--no-default-browser-check'],
  })
  const page = await browser.newPage()
  const vp = DEVICES[device]
  await page.setViewport(vp)
  const ua = device.startsWith('iphone') ? SAFARI_UA.iphone : device.startsWith('ipad') ? SAFARI_UA.ipad : undefined
  if (ua) await page.setUserAgent(ua)
  page.on('console', (m) => {
    if (['error', 'warn'].includes(m.type())) console.log(`[console.${m.type()}]`, m.text())
  })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  if (url) await page.goto(url, { waitUntil: 'networkidle0' })
  return { browser, page }
}
