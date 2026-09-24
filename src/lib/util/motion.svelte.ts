import { cubicIn, cubicOut } from 'svelte/easing'
import type { TransitionConfig } from 'svelte/transition'

// Mirrors the CSS --dur-* tokens. Svelte's JS transitions don't see the reduced-motion
// media query, so every transition takes its duration through `dur()`.
export const DUR = { instant: 90, fast: 140, base: 220, slow: 320 } as const

const query =
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null

const motion = $state({ reduced: query?.matches ?? false })
query?.addEventListener('change', (e) => {
  motion.reduced = e.matches
})

/** A token duration (ms), or 0 when the user asked for reduced motion. */
export function dur(ms: number): number {
  return motion.reduced ? 0 : ms
}

/** The CSS breakpoint. */
function isWide(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(min-width: 768px)').matches
}

/** Sheet enter/exit: rise on phones, scale+fade on iPad (card or popover). */
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
