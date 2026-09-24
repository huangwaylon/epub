/** Minimal in-memory router. The app has two screens: the shelf and the reader. */
import type { Component } from 'svelte'

export type Route = { name: 'shelf' } | { name: 'reader'; bookId: string }

/**
 * The route survives exactly one deliberate reload — the service-worker "update ready"
 * reload (and the reader chunk's "Try again") — via sessionStorage, so the user lands
 * back in the open book instead of on the shelf. It is written only just before such a
 * reload and consumed on read: saving it on every navigation would make WebKit's own
 * reload after a memory-kill reopen the very book that crashed, in a loop.
 */
const ROUTE_KEY = 'tsuzuri:route'

function takeSavedRoute(): Route {
  try {
    const r = JSON.parse(sessionStorage.getItem(ROUTE_KEY) ?? 'null') as Route | null
    sessionStorage.removeItem(ROUTE_KEY)
    if (r?.name === 'reader' && typeof r.bookId === 'string') return r
  } catch {
    /* unavailable / malformed — start at the shelf */
  }
  return { name: 'shelf' }
}

/** Remember the current route for the reload that is about to happen. */
export function rememberRouteForReload(): void {
  try {
    sessionStorage.setItem(ROUTE_KEY, JSON.stringify(nav.route))
  } catch {
    /* best effort */
  }
}

function setRoute(route: Route): void {
  nav.route = route
}

export const nav = $state<{ route: Route }>({ route: takeSavedRoute() })

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
