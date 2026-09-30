// English translation check: show-all on/off, single-unit reveal from the card, tap-to-hide,
// in 縦書き and 横書き, on each device. Screenshots go to /tmp/en-<device>-<mode>-<step>.png.
//
//   node scripts/e2e/english.mjs [ipad|iphone|desktop …]   (default: all three)
//
// Starts `vite` (dev, for `window.__tsuzuri`), lets the shelf auto-import the bundled books,
// opens コンビニ人間 (konbini-ningen, ~98% translated) and drives it with synthetic pointer
// events on the content document. Prints one line per check; exits 1 if any failed.
import { launch, serve } from './lib.mjs'

const devices = process.argv.slice(2).length ? process.argv.slice(2) : ['ipad', 'iphone', 'desktop']
const TITLE = 'コンビニ人間'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`)
}

/** In-page helpers, installed once per page. */
const HELPERS = () => {
  const T = () => window.__tsuzuri
  /** A synthetic tap at iframe-local (x, y) on the content document. */
  window.__tapDoc = (x, y) => {
    const doc = T().doc
    const el = doc.elementFromPoint(x, y) ?? doc.body
    const PE = doc.defaultView.PointerEvent
    for (const type of ['pointerdown', 'pointerup'])
      el.dispatchEvent(new PE(type, { bubbles: true, clientX: x, clientY: y, isPrimary: true, pointerType: 'touch', pointerId: 1 }))
  }
  /** A synthetic tap on the host (margins) at top-window (x, y). */
  window.__tapHost = (x, y) => {
    const host = document.querySelector('foliate-view')
    for (const type of ['pointerdown', 'pointerup'])
      host.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, isPrimary: true, pointerType: 'touch', pointerId: 1 }))
  }
  const frameRect = () => T().doc.defaultView.frameElement.getBoundingClientRect()
  const onScreen = (r, edge = 90) => {  // `edge`: keep clear of the chrome bands
    const f = frameRect()
    const x = f.left + (r.left + r.right) / 2
    const y = f.top + (r.top + r.bottom) / 2
    return r.width > 0 && x > 20 && x < innerWidth - 20 && y > edge && y < innerHeight - edge
  }
  const charRect = (t, i) => {
    const r = t.ownerDocument.createRange()
    r.setStart(t, i)
    r.setEnd(t, i + 1)
    return r.getBoundingClientRect()
  }
  /** A visible Japanese glyph whose unit has English: iframe-local centre + the unit's tz. */
  window.__findUnitGlyph = () => {
    const doc = T().doc
    for (const en of doc.querySelectorAll('.tsuzuri-en')) {
      let n = en.previousSibling
      while (n && !(n.nodeType === 3 && /[぀-ヿ一-鿿]/.test(n.data))) n = n.previousSibling
      if (!n) continue
      for (let i = 0; i < n.data.length; i++) {
        if (!/[぀-ヿ一-鿿]/.test(n.data[i])) continue
        const r = charRect(n, i)
        if (!onScreen(r)) continue
        window.__glyph = { node: n, offset: i }
        return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, tz: en.dataset.tz }
      }
    }
    return null
  }
  /** That glyph's current iframe-local centre (in an rtl section the iframe widens as
   *  English is revealed, so iframe-local coordinates shift), or null if off screen. */
  window.__glyphPoint = () => {
    const { node, offset } = window.__glyph
    const r = charRect(node, offset)
    return onScreen(r) ? { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } : null
  }
  /** Centre of the first on-screen glyph of unit `tz`'s English. */
  window.__englishPoint = (tz) => {
    const en = T().doc.querySelector(`.tsuzuri-en[data-tz="${tz}"]`)
    const t = en?.firstChild
    if (!t) return null
    for (let i = 0; i < t.data.length; i++) {
      if (t.data[i] === ' ') continue
      const r = charRect(t, i)
      if (onScreen(r)) return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }
    }
    return null
  }
  /** Remember the character at the centre of the page; later, is it still on screen?
   *  (`null` = it was English that is now hidden.) */
  window.__saveCentre = () => {
    const doc = T().doc
    const f = frameRect()
    const c = doc.caretRangeFromPoint(innerWidth / 2 - f.left, innerHeight / 2 - f.top)
    const node = c?.startContainer
    window.__centre = node?.nodeType === 3 && node.data.length ? { node, offset: Math.min(c.startOffset, node.data.length - 1) } : null
  }
  window.__centreOnScreen = () => {
    const s = window.__centre
    if (!s) return null
    const en = s.node.parentElement.closest('.tsuzuri-en')
    if (en && getComputedStyle(en).display === 'none') return null
    return onScreen(charRect(s.node, s.offset), 0)
  }
  window.__enState = (tz) => {
    const en = T().doc.querySelector(`.tsuzuri-en[data-tz="${tz}"]`)
    return { shown: en?.classList.contains('tsuzuri-shown'), display: en && getComputedStyle(en).display }
  }
  /** First visible text of the page (to judge that toggles don't jump). */
  window.__pageStart = () => {
    const r = T().controller?.view.lastLocation?.range
    if (!r) return ''
    const c = r.startContainer // an element boundary when a whole block starts the page
    return c.nodeType === 3 ? c.data.slice(r.startOffset, r.startOffset + 12) : (c.childNodes[r.startOffset]?.textContent ?? '').trim().slice(0, 12)
  }
}

async function run(device, url) {
  const { browser, page } = await launch(device, url)
  const shot = (name) => page.screenshot({ path: `/tmp/en-${device}-${name}.png` })
  try {
    // First run: the shelf imports the bundled books.
    await page.waitForFunction((t) => [...document.querySelectorAll('button.card .title')].some((e) => e.textContent === t), { timeout: 120_000 }, TITLE)
    await page.evaluate((t) => [...document.querySelectorAll('button.card')].find((b) => b.querySelector('.title')?.textContent === t).click(), TITLE)
    await page.waitForFunction(() => window.__tsuzuri?.doc && window.__tsuzuri.controller, { timeout: 60_000 })
    await page.evaluate(HELPERS)
    await sleep(1500)
    check(`${device}: hasEnglish known at the cover`, await page.evaluate(() => window.__tsuzuri.controller.hasEnglish))
    check(`${device}: top-bar English button`, !!(await page.$('button[aria-label="Hide English"]')))
    await shot('cover')

    for (const mode of ['vertical', 'horizontal']) {
      if (mode === 'horizontal') {
        // Bars → Display → 横書き; the book re-opens.
        await page.evaluate(() => window.__tapHost(innerWidth / 2, 30))
        await sleep(400)
        if (!(await page.$('button[aria-label="Display settings"]'))) {
          await page.evaluate(() => window.__tapHost(innerWidth / 2, 30))
          await sleep(400)
        }
        await page.click('button[aria-label="Display settings"]')
        await sleep(500)
        await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '横書き').click())
        await sleep(300)
        await page.keyboard.press('Escape')
        await sleep(2500)
        await page.evaluate(HELPERS)
      }
      const p = `${device}: ${mode}`
      // Into the main chapter, a few pages in.
      await page.evaluate(async () => {
        const c = window.__tsuzuri.controller
        const i = c.view.book.sections.findIndex((s) => /p-002/.test(s.id))
        await c.goTo(i)
      })
      await sleep(1200)
      for (let k = 0; k < 3; k++) {
        await page.evaluate(() => window.__tsuzuri.controller.goForward())
        await sleep(500)
      }
      await sleep(800)
      await shot(`${mode}-all`)
      const start0 = await page.evaluate(() => window.__pageStart())
      await page.evaluate(() => window.__saveCentre())

      await page.keyboard.press('e')
      await sleep(1200)
      const kept = await page.evaluate(() => window.__centreOnScreen())
      check(`${p}: hiding keeps the page centre on screen`, kept !== false, kept === null ? 'centre was English' : '')
      await shot(`${mode}-hidden`)
      const start1 = await page.evaluate(() => window.__pageStart())
      check(`${p}: 'e' hides all English`, await page.evaluate(() => [...window.__tsuzuri.doc.querySelectorAll('.tsuzuri-en')].every((e) => getComputedStyle(e).display === 'none')))
      console.log(`     page start: all=${JSON.stringify(start0)} hidden=${JSON.stringify(start1)}`)

      const g = await page.evaluate(() => window.__findUnitGlyph())
      check(`${p}: a translated unit is on screen`, !!g)
      if (!g) continue
      await page.evaluate(({ x, y }) => window.__tapDoc(x, y), g)
      await sleep(600)
      const ds = await page.evaluate(() => ({ open: window.__tsuzuri.dictState.open, english: window.__tsuzuri.dictState.english }))
      check(`${p}: tap opens the card with Show English`, ds.open && ds.english === 'show', JSON.stringify(ds))
      await shot(`${mode}-card`)
      await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Show English')?.click())
      await sleep(900)
      const st = await page.evaluate((tz) => window.__enState(tz), g.tz)
      const closed = !(await page.evaluate(() => window.__tsuzuri.dictState.open))
      check(`${p}: Show English reveals the unit and closes the card`, st.shown && st.display === 'block' && closed, JSON.stringify(st))
      const g2 = await page.evaluate(() => window.__glyphPoint())
      check(`${p}: the tapped word stays on screen after the reveal`, !!g2)
      if (g2) Object.assign(g, g2)
      await shot(`${mode}-revealed`)

      // Tapping the same word again offers Hide English.
      await page.evaluate(({ x, y }) => window.__tapDoc(x, y), g)
      await sleep(500)
      const ds2 = await page.evaluate(() => window.__tsuzuri.dictState.english)
      check(`${p}: card offers Hide English for a revealed unit`, ds2 === 'hide', ds2)
      await page.evaluate(() => window.__tapHost(5, innerHeight / 2)) // dismiss
      await sleep(300)

      const ep = await page.evaluate((tz) => window.__englishPoint(tz), g.tz)
      check(`${p}: revealed English is on screen`, !!ep)
      if (ep) {
        await page.evaluate(({ x, y }) => window.__tapDoc(x, y), ep)
        await sleep(700)
        const st2 = await page.evaluate((tz) => window.__enState(tz), g.tz)
        const open = await page.evaluate(() => window.__tsuzuri.dictState.open)
        check(`${p}: tapping revealed English hides it (no lookup)`, !st2.shown && st2.display === 'none' && !open, JSON.stringify(st2))
        await shot(`${mode}-rehidden`)
      }

      // Reveal again, then show-all clears individual reveals.
      Object.assign(g, (await page.evaluate(() => window.__glyphPoint())) ?? {})
      await page.evaluate(({ x, y }) => window.__tapDoc(x, y), g)
      await sleep(500)
      await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Show English')?.click())
      await sleep(400)
      await page.keyboard.press('e')
      await sleep(900)
      const cleared = await page.evaluate(() => window.__tsuzuri.doc.querySelectorAll('.tsuzuri-shown').length === 0)
      const allShown = await page.evaluate(() => [...window.__tsuzuri.doc.querySelectorAll('.tsuzuri-en')].every((e) => getComputedStyle(e).display === 'block'))
      check(`${p}: show-all shows every unit and clears reveals`, cleared && allShown)
      const ept = await page.evaluate((tz) => window.__englishPoint(tz), g.tz)
      if (ept) {
        await page.evaluate(({ x, y }) => window.__tapDoc(x, y), ept)
        await sleep(500)
        const s3 = await page.evaluate(() => ({ open: window.__tsuzuri.dictState.open, all: getComputedStyle(window.__tsuzuri.doc.querySelector('.tsuzuri-en')).display }))
        check(`${p}: English tap in show-all is a blank tap`, !s3.open && s3.all === 'block', JSON.stringify(s3))
      }
      await shot(`${mode}-all-again`)
    }
  } finally {
    await browser.close()
  }
}

const server = await serve('dev')
try {
  for (const d of devices) await run(d, server.url)
} finally {
  server.close()
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
process.exit(failed ? 1 : 0)
