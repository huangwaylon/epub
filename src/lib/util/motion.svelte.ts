import { cubicIn, cubicOut } from 'svelte/easing'
import type { TransitionConfig } from 'svelte/transition'

/**
 * Motion tokens for Svelte transitions, mirroring the CSS `--dur-*` tokens in app.css,
 * plus a live `prefers-reduced-motion` flag. CSS animations collapse under reduced motion
 * via the media query; Svelte's JS-driven transitions don't see it, so every
 * `transition:`/`in:`/`out:` in the app takes its duration through `dur()`.
 */
export const DUR = { instant: 90, fast: 140, base: 220, slow: 320 } as const

const query =
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null

export const motion = $state({ reduced: query?.matches ?? false })
query?.addEventListener('change', (e) => {
  motion.reduced = e.matches
})

/** A token duration (ms), or 0 when the user asked for reduced motion. */
export function dur(ms: number): number {
  return motion.reduced ? 0 : ms
}

/** Wide (iPad) layout — the same single breakpoint the CSS uses. */
export function isWide(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(min-width: 768px)').matches
}

/**
 * Sheet presentation: a bottom sheet rises from the bottom edge on phones; a centred card
 * (or an anchored popover) scales in on iPad. Enter is slow + ease-out, exit fast +
 * ease-in, so dismissals feel decisive. `origin` picks the popover's growth point.
 */
export function sheetMotion(
  _node: Element,
  { intro = true, popover = false }: { intro?: boolean; popover?: boolean } = {},
): TransitionConfig {
  const duration = dur(intro ? DUR.slow : DUR.base)
  const easing = intro ? cubicOut : cubicIn
  if (!isWide()) {
    return { duration, easing, css: (t, u) => `transform: translateY(${u * 100}%)` }
  }
  if (popover) {
    return {
      duration,
      easing,
      css: (t, u) => `opacity:${t}; transform: translateY(${-u * 8}px) scale(${1 - u * 0.04})`,
    }
  }
  return {
    duration,
    easing,
    css: (t, u) => `opacity:${t}; transform: translate(-50%, calc(-50% + ${u * 16}px)) scale(${1 - u * 0.03})`,
  }
}
