// Reader timing on a long chapter with 4× CPU throttling: section load, page turns with
// English hidden / shown, the show-all toggle's long tasks, JS heap. Also fails on any
// unhandled rejection.
//
//   node scripts/e2e/perf.mjs [iphone|ipad|desktop]   (default: iphone)
import { launch, serve } from './lib.mjs'

const device = process.argv[2] ?? 'iphone'
const TITLE = 'コンビニ人間'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const server = await serve('dev')
const { browser, page } = await launch(device)
let rejections = 0
page.on('console', (m) => m.text().startsWith('UR ') && rejections++)
await page.evaluateOnNewDocument(() => addEventListener('unhandledrejection', (e) => console.error('UR', e.reason?.stack)))
try {
  await page.goto(server.url, { waitUntil: 'networkidle0' })
  const lib = (t) => [...document.querySelectorAll('button.card:not(.bundled-card)')].find((b) => b.querySelector('.title')?.textContent === t)
  await page.waitForFunction((t) => document.querySelector(`button.bundled-card[aria-label^="Download ${t},"]`), { timeout: 60_000 }, TITLE)
  await page.evaluate((t) => document.querySelector(`button.bundled-card[aria-label^="Download ${t},"]`).click(), TITLE)
  await page.waitForFunction(`(${lib})(${JSON.stringify(TITLE)})`, { timeout: 120_000 })
  await page.evaluate(`(${lib})(${JSON.stringify(TITLE)}).click()`)
  await page.waitForFunction(() => window.__tsuzuri?.doc && window.__tsuzuri.controller, { timeout: 60_000 })
  await sleep(1500)
  const cdp = await page.createCDPSession()
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await page.evaluate(() => {
    window.__lt = []
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(Math.round(e.duration)))).observe({ type: 'longtask' })
  })
  const time = async (name, fn) => {
    const s = Date.now()
    await page.evaluate(fn)
    console.log(`${name}: ${Date.now() - s} ms`)
  }
  const longTasks = async (name, fn) => {
    await page.evaluate(() => (window.__lt = []))
    await fn()
    await sleep(2500)
    console.log(`${name}: long tasks ${JSON.stringify(await page.evaluate(() => window.__lt))}`)
  }
  await time('open the long chapter', async () => {
    const c = window.__tsuzuri.controller
    await c.goTo(c.view.book.sections.findIndex((s) => /p-002/.test(s.id)))
  })
  for (let i = 0; i < 3; i++) await time('turn (English shown)', () => window.__tsuzuri.controller.goForward())
  await longTasks('hide all English', () => page.keyboard.press('e'))
  for (let i = 0; i < 3; i++) await time('turn (English hidden)', () => window.__tsuzuri.controller.goForward())
  await longTasks('show all English', () => page.keyboard.press('e'))
  await longTasks('5 key turns', async () => {
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('ArrowLeft')
      await sleep(400)
    }
  })
  console.log(`JS heap: ${Math.round((await page.evaluate(() => performance.memory.usedJSHeapSize)) / 1e6)} MB`)
  console.log(rejections ? `FAIL ${rejections} unhandled rejection(s)` : 'no unhandled rejections')
} finally {
  await browser.close()
  server.close()
}
process.exit(rejections ? 1 : 0)
