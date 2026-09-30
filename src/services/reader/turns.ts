/**
 * The page-turn animation. foliate's own `animated` turn slides vertically for 縦書き, so
 * it stays off (the jump is instant) and the whole `<foliate-view>` is pushed horizontally
 * here: drift + fade out, jump, drift in + fade up; an end bounce at the first/last page.
 */
import { reducedMotion } from './styles'
import type { Timers } from './timers'
import type { TurnDir } from './types'

/** Page-turn push: old page drifts + fades out, new page drifts in + fades up. */
const TURN_OUT_MS = 90
const TURN_IN_MS = 170
const TURN_SHIFT_PX = 36
/** First/last page: nudge and return. */
const BOUNCE_PX = 28
const BOUNCE_MS = 110
/** `Timers` key of the in-flight transition's fallback. */
const SLIDE = 'slide'

export interface PageTurnerDeps {
  /** The instant jump (`view.goLeft` / `view.goRight`). */
  go: (dir: TurnDir) => Promise<void>
  /** Nowhere to turn `dir` to. */
  atEdge: (dir: TurnDir) => boolean
  /** False once the reader is destroyed (re-checked after every await). */
  alive: () => boolean
  timers: Timers
  /** Lifetime of the `transitionend` listeners. */
  signal: AbortSignal
}

/** Animated, coalescing page turns of one element. */
export class PageTurner {
  #el: HTMLElement
  #d: PageTurnerDeps
  #turning = false
  /** Latest turn requested during a turn (rapid swipes coalesce to one). */
  #pendingDir: TurnDir | null = null

  constructor(el: HTMLElement, deps: PageTurnerDeps) {
    this.#el = el
    this.#d = deps
  }

  /** Drop a coalesced turn that hasn't started. */
  cancelPending(): void {
    this.#pendingDir = null
  }

  async turn(dir: TurnDir): Promise<void> {
    if (this.#turning) {
      this.#pendingDir = dir
      return
    }
    this.#turning = true
    try {
      if (this.#d.atEdge(dir)) await this.#bounce(dir)
      else await this.#slide(dir)
    } finally {
      this.#turning = false
      const next = this.#pendingDir
      this.#pendingDir = null
      if (next && this.#d.alive()) void this.turn(next)
    }
  }

  async #slide(dir: TurnDir): Promise<void> {
    const el = this.#el
    // Both pages travel the way the content moves (goLeft ⇐ finger dragged right).
    const sign = dir === 'left' ? 1 : -1
    const shift = reducedMotion() ? 0 : TURN_SHIFT_PX
    await this.#transition(TURN_OUT_MS, 'cubic-bezier(.4, 0, 1, 1)', `translateX(${sign * shift}px)`, 0)
    if (!this.#d.alive()) return
    el.style.transition = 'none' // jump while invisible (instant: `animated` is off)
    try {
      await this.#d.go(dir)
    } catch {
      /* view may be tearing down */
    }
    if (!this.#d.alive()) return
    el.style.transform = `translateX(${-sign * shift}px)`
    // Commit the start position with transitions off, or the page animates in from the exit side.
    void el.offsetWidth
    await this.#transition(TURN_IN_MS, 'cubic-bezier(0, 0, .2, 1)', 'translateX(0)', 1)
    el.style.transition = ''
    el.style.transform = ''
    el.style.opacity = ''
  }

  async #bounce(dir: TurnDir): Promise<void> {
    const el = this.#el
    const px = dir === 'left' ? BOUNCE_PX : -BOUNCE_PX
    await this.#transition(BOUNCE_MS, 'cubic-bezier(.3, 0, .5, 1)', `translateX(${px}px)`)
    if (!this.#d.alive()) return
    await this.#transition(BOUNCE_MS * 1.4, 'cubic-bezier(.2, 0, .2, 1)', 'translateX(0)')
    el.style.transition = ''
    el.style.transform = ''
  }

  /** Transition the element and resolve on `transitionend` (or a fallback timeout). */
  #transition(ms: number, easing: string, transform: string, opacity?: number): Promise<void> {
    const el = this.#el
    const timers = this.#d.timers
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        timers.clear(SLIDE)
        el.removeEventListener('transitionend', onEnd)
        resolve()
      }
      const onEnd = (e: TransitionEvent) => {
        // Key off opacity when animated: a reduced-motion turn has no transform change.
        if (e.propertyName === (opacity === undefined ? 'transform' : 'opacity')) finish()
      }
      el.addEventListener('transitionend', onEnd, { signal: this.#d.signal })
      el.style.transition =
        opacity === undefined ? `transform ${ms}ms ${easing}` : `transform ${ms}ms ${easing}, opacity ${ms}ms ${easing}`
      void el.offsetWidth // commit the transition before the new transform
      el.style.transform = transform
      if (opacity !== undefined) el.style.opacity = String(opacity)
      timers.set(SLIDE, finish, ms + 120)
    })
  }
}
