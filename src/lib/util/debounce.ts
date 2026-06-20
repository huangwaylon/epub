/** Trailing-edge debounce. */
export function debounce<A extends any[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: number | undefined
  return (...args: A) => {
    if (t) clearTimeout(t)
    t = window.setTimeout(() => fn(...args), ms)
  }
}
