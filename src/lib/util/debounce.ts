/** Trailing-edge debounce. The returned function carries a `.cancel()` that drops
 *  any pending trailing call — use it on teardown so a queued callback can't fire
 *  after the owner is gone. */
export interface Debounced<A extends any[]> {
  (...args: A): void
  cancel(): void
}

export function debounce<A extends any[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let t: number | undefined
  const debounced = ((...args: A) => {
    if (t) clearTimeout(t)
    t = window.setTimeout(() => fn(...args), ms)
  }) as Debounced<A>
  debounced.cancel = () => {
    if (t) clearTimeout(t)
    t = undefined
  }
  return debounced
}
