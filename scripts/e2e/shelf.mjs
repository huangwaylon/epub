// Shelf + bundled-book downloads, end to end in real Chrome (fresh profile = first visit).
//
//   npm run build && node scripts/e2e/shelf.mjs [dev]
//
// Per device preset: load metrics (navigation timing, FCP/LCP, transferred bytes) and a
// screenshot at /tmp/shelf-<device>.png. On iPad: download one book (progress screenshot
// under a throttled network), open it (reader text present), delete it (returns to
// "available"), fail a download with the server down (offline), then time "Download all".
import { launch, serve, DEVICES } from './lib.mjs'

const mode = process.argv[2] === 'dev' ? 'dev' : 'preview'
// A port of its own: other checkouts' harness runs use the defaults.
const port = Number(process.env.PORT ?? (mode === 'dev' ? 5317 : 5318))
let server = await serve(mode, port)
const url = server.url
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = { mode, devices: {}, flow: {} }

/** Collects paint + LCP entries from the very first byte. */
async function observePaint(page) {
  page.on('response', (r) => {
    if (r.status() >= 400) console.log(`[http ${r.status()}]`, r.url())
  })
  await page.evaluateOnNewDocument(() => {
    window.__lcp = 0
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__lcp = e.startTime
    }).observe({ type: 'largest-contentful-paint', buffered: true })
  })
}

async function loadMetrics(page) {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0]
    const res = performance.getEntriesByType('resource')
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]
    const bytes = res.reduce((n, r) => n + (r.transferSize || 0), nav.transferSize || 0)
    return {
      ttfb: Math.round(nav.responseStart - nav.startTime),
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
      load: Math.round(nav.loadEventEnd),
      fcp: fcp ? Math.round(fcp.startTime) : null,
      lcp: Math.round(window.__lcp),
      transferredKB: Math.round(bytes / 1024),
      requests: res.length + 1,
      foliateLoaded: res.some((r) => /foliate-|\/view-/.test(r.name)),
    }
  })
}

const countBundled = (page) => page.$$eval('.bundled-card', (els) => els.length)
const countLibrary = (page) => page.$$eval('.card:not(.bundled-card):not(.skeleton-card)', (els) => els.length)
async function waitFor(fn, timeout = 20000, step = 50) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return Date.now() - t0
    if (Date.now() - t0 > timeout) throw new Error('timeout: ' + fn.toString())
    await sleep(step)
  }
}

try {
  // 1. First-visit load + screenshot per device.
  for (const device of Object.keys(DEVICES)) {
    const { browser, page } = await launch(device)
    await observePaint(page)
    await page.goto(url, { waitUntil: 'networkidle0' })
    await page.waitForSelector('.bundled-card img')
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))))
    await sleep(300)
    results.devices[device] = await loadMetrics(page)
    await sleep(4200) // let the first-visit "Ready to read offline" toast clear
    await page.screenshot({ path: `/tmp/shelf-${device}.png` })
    // Scrolled view for the phones (the bundled grid runs below the fold).
    if (device.startsWith('iphone')) {
      await page.$eval('.shelf', (el) => el.scrollTo(0, el.scrollHeight))
      await sleep(200)
      await page.screenshot({ path: `/tmp/shelf-${device}-scrolled.png` })
    }
    await browser.close()
  }

  // 2. The download flow on iPad.
  const { browser, page } = await launch('ipad')
  const cdp = await page.createCDPSession()
  await page.goto(url, { waitUntil: 'networkidle0' })
  await page.waitForSelector('.bundled-card')
  // Let the SW finish precaching (catalog + covers) before the offline step.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
    for (let i = 0; i < 100; i++) {
      const keys = await caches.keys()
      const pre = keys.find((k) => k.includes('precache'))
      if (pre && (await (await caches.open(pre)).keys()).some((r) => r.url.endsWith('.webp'))) return
      await new Promise((r) => setTimeout(r, 100))
    }
  })
  const total = await countBundled(page)
  results.flow.bundledOnFirstVisit = total
  results.flow.libraryOnFirstVisit = await countLibrary(page)

  // One download, throttled so the progress state is visible. The EPUB fetch goes through
  // the service worker, so throttle its target too.
  const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker')).createCDPSession()
  await sw.send('Network.enable')
  const throttle = async (on) => {
    const cond = on
      ? { offline: false, latency: 40, downloadThroughput: 250_000, uploadThroughput: 250_000 }
      : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
    await Promise.all([cdp.send('Network.emulateNetworkConditions', cond), sw.send('Network.emulateNetworkConditions', cond)])
  }
  await throttle(true)
  const firstTitle = await page.$eval('.bundled-card .title', (el) => el.textContent)
  let t0 = Date.now()
  await page.click('.bundled-card')
  await waitFor(() => page.$eval('.bundled-card .get', (el) => /\d+%/.test(el.textContent) && parseInt(el.textContent) >= 20).catch(() => false))
  await page.screenshot({ path: '/tmp/shelf-downloading.png' })
  await waitFor(async () => (await countLibrary(page)) === 1)
  results.flow.oneDownloadThrottledMs = Date.now() - t0
  await throttle(false)
  await sleep(300)
  await page.screenshot({ path: '/tmp/shelf-after-download.png' })
  results.flow.afterOne = { library: await countLibrary(page), bundled: await countBundled(page) }

  // Open it: the content iframe (closed shadow root, but a real frame) must show text.
  t0 = Date.now()
  await page.click('.card:not(.bundled-card)')
  const textLen = await (async () => {
    for (let i = 0; i < 200; i++) {
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue
        const n = await f.evaluate(() => document.body?.innerText.trim().length ?? 0).catch(() => 0)
        if (n > 50) return n
      }
      await sleep(100)
    }
    return 0
  })()
  results.flow.openMs = Date.now() - t0
  results.flow.readerTextChars = textLen
  await sleep(800)
  await page.screenshot({ path: '/tmp/shelf-reader.png' })

  // Back to the shelf and remove it; after the Undo window it's available again.
  await page.$eval('[aria-label="Library"]', (el) => el.click())
  await page.waitForSelector('.card:not(.bundled-card)')
  await page.$eval('.card:not(.bundled-card)', (el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  await page.waitForSelector('.row.danger')
  await page.click('.row.danger')
  await waitFor(async () => (await countBundled(page)) === total, 12000)
  const titles = await page.$$eval('.bundled-card .title', (els) => els.map((e) => e.textContent))
  results.flow.deletedReturnsToAvailable = titles.includes(firstTitle) && (await countLibrary(page)) === 0
  // Reload: still not auto-imported.
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector('.bundled-card')
  results.flow.afterReload = { library: await countLibrary(page), bundled: await countBundled(page) }

  // Offline: stop the server. The shell, catalog and covers come from the precache;
  // a download fails with a visible message.
  server.close()
  await sleep(500)
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector('.bundled-card img')
  results.flow.offline = {
    covers: await page.$$eval('.bundled-card img', (imgs) => imgs.filter((i) => i.complete && i.naturalWidth > 0).length),
  }
  await page.click('.bundled-card')
  await page.waitForSelector('.err-msg', { timeout: 10000 })
  results.flow.offline.error = await page.$eval('.err-msg', (el) => el.textContent)
  await sleep(200)
  await page.screenshot({ path: '/tmp/shelf-offline.png' })
  server = await serve(mode, port)

  // Download all (unthrottled, localhost).
  t0 = Date.now()
  await page.click('.get-all')
  await waitFor(async () => (await countBundled(page)) === 0, 60000)
  results.flow.downloadAllMs = Date.now() - t0
  results.flow.downloadAllCount = await countLibrary(page)
  await sleep(500)
  await page.screenshot({ path: '/tmp/shelf-all-downloaded.png' })
  results.flow.storage = await page.evaluate(async () => {
    const e = await navigator.storage.estimate()
    return { usageMB: +(e.usage / 1e6).toFixed(2), persisted: await navigator.storage.persisted() }
  })
  await browser.close()
} finally {
  server.close()
}

console.log(JSON.stringify(results, null, 2))
