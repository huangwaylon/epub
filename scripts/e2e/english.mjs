// English translation check: show-all on/off (page kept), the card's Translation (expand /
// collapse, 't', sticky per unit, page never moves), English taps in show-all are blank, the
// one-time sideways hint, in 縦書き and 横書き, on each device. Screenshots go to /tmp/en-<device>-<mode>-<step>.png.
//
//   node scripts/e2e/english.mjs [ipad|iphone|desktop …]   (default: all three)
//
// Starts `vite` (dev, for `window.__tsuzuri`), downloads the book from the shelf's Included
// books, opens コンビニ人間 (konbini-ningen, ~98% translated) and drives it with synthetic pointer
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
  /** A visible Japanese glyph whose unit has English: iframe-local centre + the unit's tz.
   *  `spanning`: a unit that continues onto the next page (its last character off screen) —
   *  anchoring a reveal on the unit's end would push the tapped word away — else one that
   *  ends on this page (so its revealed English is on screen too). */
  window.__findUnitGlyph = (spanning = false, exclude = null) => {
    const doc = T().doc
    const JA = /[぀-ヿ一-鿿]/
    /** The unit's text nodes (furigana excluded): the siblings before its English, back to
     *  the previous English or <br>. */
    const unitTexts = (en) => {
      const out = []
      const collect = (n) => {
        if (n.nodeType === 3) out.push(n)
        else if (n.nodeType === 1 && !/^(rt|rp)$/i.test(n.localName)) for (const c of n.childNodes) collect(c)
      }
      const nodes = []
      for (let s = en.previousSibling; s && !(s.nodeType === 1 && (s.localName === 'br' || s.classList.contains('tsuzuri-en'))); s = s.previousSibling) nodes.unshift(s)
      nodes.forEach(collect)
      return out
    }
    for (const en of doc.querySelectorAll('.tsuzuri-en')) {
      if (en.dataset.tz === exclude) continue
      const texts = unitTexts(en)
      const last = texts.findLast((t) => JA.test(t.data))
      if (!last) continue
      let li = last.data.length - 1
      while (li > 0 && !JA.test(last.data[li])) li--
      if (!onScreen(charRect(last, li), 0) !== spanning) continue
      for (const n of texts) {
        for (let i = 0; i < n.data.length; i++) {
          if (!JA.test(n.data[i])) continue
          const r = charRect(n, i)
          if (!onScreen(r)) continue
          window.__glyph = { node: n, offset: i }
          return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, tz: en.dataset.tz }
        }
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
    // Fresh profile: download the book from the shelf's Included books, then open it.
    const lib = (t) => [...document.querySelectorAll('button.card:not(.bundled-card)')].find((b) => b.querySelector('.title')?.textContent === t)
    await page.waitForFunction((t) => document.querySelector(`button.bundled-card[aria-label^="Download ${t},"]`), { timeout: 60_000 }, TITLE)
    await page.evaluate((t) => document.querySelector(`button.bundled-card[aria-label^="Download ${t},"]`).click(), TITLE)
    await page.waitForFunction(`(${lib})(${JSON.stringify(TITLE)})`, { timeout: 120_000 })
    await page.evaluate(`(${lib})(${JSON.stringify(TITLE)}).click()`)
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
      if (mode === 'vertical')
        check(`${p}: one-time hint offers horizontal for sideways English`, await page.evaluate(() => document.body.textContent.includes('English runs sideways')))
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
      const start = await page.evaluate(() => window.__pageStart())
      await page.evaluate(({ x, y }) => window.__tapDoc(x, y), g)
      await sleep(600)
      const st = () =>
        page.evaluate((tz) => {
          const s = window.__tsuzuri.dictState
          const en = window.__tsuzuri.doc.querySelector(`.tsuzuri-en[data-tz="${tz}"]`)
          const card = document.querySelector('.popup')?.getBoundingClientRect()
          return {
            open: s.open,
            expanded: s.translationOpen,
            matches: !!en && !!s.translation && s.translation === en.textContent.trim(),
            needsDownload: s.needsDownload,
            text: !!document.querySelector('.popup .tr-text'),
            inView: !!card && card.left >= 0 && card.top >= 0 && card.right <= innerWidth && card.bottom <= innerHeight,
            margins: card ? [Math.round(card.left), Math.round(innerWidth - card.right)] : null,
            hiddenOnPage: !!en && getComputedStyle(en).display === 'none',
          }
        }, g.tz)
      const s1 = await st()
      check(`${p}: the card carries the tapped unit's English`, s1.open && s1.matches, JSON.stringify(s1))
      if (s1.needsDownload) check(`${p}: without the dictionary the translation opens by itself`, s1.expanded && s1.text)
      await shot(`${mode}-card`)
      const toggle = () => page.evaluate(() => document.querySelector('.popup .tr-toggle')?.click())
      if (s1.expanded) {
        await toggle()
        await sleep(250)
      }
      const s2 = await st()
      check(`${p}: Show translation row collapses the English`, s2.open && !s2.expanded && !s2.text, JSON.stringify(s2))
      await toggle()
      await sleep(250)
      const s3 = await st()
      check(`${p}: expanding keeps the card open, on screen`, s3.open && s3.expanded && s3.text && s3.inView, JSON.stringify(s3))
      if (device === 'iphone') check(`${p}: phone card has equal side margins`, !!s3.margins && Math.abs(s3.margins[0] - s3.margins[1]) <= 2, JSON.stringify(s3.margins))
      check(`${p}: the page doesn't move (English stays off the page)`, s3.hiddenOnPage && (await page.evaluate(() => window.__pageStart())) === start)
      check(`${p}: the tapped word is still on screen`, !!(await page.evaluate(() => window.__glyphPoint())))
      await shot(`${mode}-translation`)
      await page.keyboard.press('t')
      await sleep(200)
      const s4 = await st()
      await page.keyboard.press('t')
      await sleep(200)
      const s5 = await st()
      check(`${p}: 't' toggles the card's translation`, !s4.expanded && s5.expanded)

      // Any tap dismisses; the same unit reopens expanded, another unit collapsed.
      await page.evaluate(() => window.__tapHost(5, innerHeight / 2))
      await sleep(300)
      check(`${p}: a tap dismisses the card`, !(await page.evaluate(() => window.__tsuzuri.dictState.open)))
      await page.evaluate(({ x, y }) => window.__tapDoc(x, y), g)
      await sleep(500)
      check(`${p}: the same unit reopens with its translation open`, (await st()).expanded)
      await page.evaluate(() => window.__tapHost(5, innerHeight / 2))
      await sleep(300)
      const other = await page.evaluate((tz) => window.__findUnitGlyph(false, tz), g.tz)
      if (other) {
        await page.evaluate(({ x, y }) => window.__tapDoc(x, y), other)
        await sleep(500)
        const so = await page.evaluate(() => ({ s: window.__tsuzuri.dictState.translationOpen, n: window.__tsuzuri.dictState.needsDownload }))
        check(`${p}: another unit opens collapsed (dictionary installed) or expanded (not)`, so.s === so.n, JSON.stringify(so))
        await page.evaluate(() => window.__tapHost(5, innerHeight / 2))
        await sleep(300)
      }

      // Show-all: every unit on the page; the card has no translation; English taps are blank.
      await page.keyboard.press('e')
      await sleep(900)
      const allShown = await page.evaluate(() => [...window.__tsuzuri.doc.querySelectorAll('.tsuzuri-en')].every((e) => getComputedStyle(e).display === 'block'))
      check(`${p}: show-all shows every unit`, allShown)
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
