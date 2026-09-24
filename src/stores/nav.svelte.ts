/** Minimal in-memory router. The app has two screens: the shelf and the reader. */
import type { Component } from 'svelte'

export type Route = { name: 'shelf' } | { name: 'reader'; bookId: string }

/**
 * The route is mirrored to sessionStorage so a reload inside the same session — above
 * all the service-worker "update ready" reload — lands back in the open book instead
 * of on the shelf. A cold launch is a new session, so it still starts at the shelf.
 */
const ROUTE_KEY = 'tsuzuri:route'

function savedRoute(): Route {
  try {
    const r = JSON.parse(sessionStorage.getItem(ROUTE_KEY) ?? 'null') as Route | null
    if (r?.name === 'reader' && typeof r.bookId === 'string') return r
  } catch {
    /* unavailable / malformed — start at the shelf */
  }
  return { name: 'shelf' }
}

function setRoute(route: Route): void {
  nav.route = route
  try {
    sessionStorage.setItem(ROUTE_KEY, JSON.stringify(route))
  } catch {
    /* best effort */
  }
}

export const nav = $state<{ route: Route }>({ route: savedRoute() })

export function openReader(bookId: string): void {
  setRoute({ name: 'reader', bookId })
}

export function openShelf(): void {
  setRoute({ name: 'shelf' })
}

/**
 * Validate a route restored from sessionStorage: if the book it points at has since
 * been removed, fall back to the shelf. `exists` is injected (the caller passes the
 * storage lookup) to keep this store free of the storage layer.
 */
export async function validateRestoredRoute(exists: (bookId: string) => Promise<boolean>): Promise<void> {
  const r = nav.route
  if (r.name !== 'reader') return
  const ok = await exists(r.bookId).catch(() => false)
  if (!ok && nav.route === r) openShelf()
}

/* ── Reader chunk ──────────────────────────────────────────────────────── */

let readerChunk: Promise<Component<{ bookId: string }>> | undefined

/**
 * Load the (lazy) reader chunk — foliate-js, the reader controller and its UI — once.
 * A failed load (offline before the SW cached it, or a stale hashed-chunk name after a
 * deploy) clears the cache so the next call retries instead of replaying the rejection.
 */
export function loadReader(): Promise<Component<{ bookId: string }>> {
  return (readerChunk ??= import('../lib/reader/Reader.svelte')
    .then((m) => m.default)
    .catch((err) => {
      readerChunk = undefined
      throw err
    }))
}

/** Fire-and-forget warm-up of the reader chunk (idle after mount, pointerdown on a cover). */
export function warmReader(): void {
  loadReader().catch(() => {})
}
