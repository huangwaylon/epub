/** Trailing-edge debounce; `cancel()` drops a pending call, `flush()` runs it now. */
export interface Debounced<A extends any[]> {
  (...args: A): void
  cancel(): void
  flush(): void
}

export function debounce<A extends any[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let t: number | undefined
  let pending: A | null = null
  const debounced = ((...args: A) => {
    if (t) clearTimeout(t)
    pending = args
    t = window.setTimeout(() => {
      t = undefined
      const a = pending
      pending = null
      if (a) fn(...a)
    }, ms)
  }) as Debounced<A>
  debounced.cancel = () => {
    if (t) clearTimeout(t)
    t = undefined
    pending = null
  }
  debounced.flush = () => {
    if (t) clearTimeout(t)
    t = undefined
    const a = pending
    pending = null
    if (a) fn(...a)
  }
  return debounced
}
