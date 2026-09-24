/**
 * App-wide transient message ("Copied", "Book removed · Undo"). One toast at a time —
 * a new one replaces the current (its `onexpire` still runs, so a deferred delete behind
 * a replaced "Undo" toast is committed, never lost). Rendered by `ToastHost`.
 */
export interface ToastSpec {
  message: string
  /** Optional single action, e.g. Undo. */
  action?: { label: string; run: () => void }
  /** Auto-dismiss after this many ms (default 2.4 s; 5 s when there's an action). */
  duration?: number
  /** Runs when the toast leaves without its action being taken (timeout, replace, dismiss). */
  onexpire?: () => void
}

type Live = ToastSpec & { id: number }

export const toast = $state<{ current: Live | null }>({ current: null })

let nextId = 1
let timer: ReturnType<typeof setTimeout> | undefined

function settle(took: boolean) {
  const t = toast.current
  if (!t) return
  if (timer) clearTimeout(timer)
  timer = undefined
  toast.current = null
  if (!took) t.onexpire?.()
}

export function showToast(spec: ToastSpec): number {
  settle(false)
  const id = nextId++
  toast.current = { ...spec, id }
  timer = setTimeout(() => settle(false), spec.duration ?? (spec.action ? 5000 : 2400))
  return id
}

/** Run the current toast's action and close it. */
export function actOnToast(): void {
  const t = toast.current
  if (!t?.action) return
  settle(true)
  t.action.run()
}

export function dismissToast(): void {
  settle(false)
}
