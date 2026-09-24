/** Minimal in-memory router. The app has two screens: the shelf and the reader. */
import type { Component } from 'svelte'

export type Route = { name: 'shelf' } | { name: 'reader'; bookId: string }

/**
 * The route survives one deliberate reload (SW update, reader-chunk retry) via
 * sessionStorage. Written only right before such a reload and consumed on read: saving it
 * on every navigation would make WebKit's reload after a memory-kill reopen the crashing book.
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

/** Call right before a deliberate reload. */
export function rememberRouteForReload(): void {
  try {
    sessionStorage.setItem(ROUTE_KEY, JSON.stringify(nav.route))
  } catch {
    /* best effort */
  }
}

export const nav = $state<{ route: Route }>({ route: takeSavedRoute() })

export function openReader(bookId: string): void {
  nav.route = { name: 'reader', bookId }
}

export function openShelf(): void {
  nav.route = { name: 'shelf' }
}

/** Fall back to the shelf if a restored reader route's book no longer exists. */
export async function validateRestoredRoute(exists: (bookId: string) => Promise<boolean>): Promise<void> {
  const r = nav.route
  if (r.name !== 'reader') return
  const ok = await exists(r.bookId).catch(() => false)
  if (!ok && nav.route === r) openShelf()
}

let readerChunk: Promise<Component<{ bookId: string }>> | undefined

/** Load the lazy reader chunk once; a failed load (offline, stale post-deploy chunk)
 *  is not memoised, so the next call retries. */
export function loadReader(): Promise<Component<{ bookId: string }>> {
  return (readerChunk ??= import('../lib/reader/Reader.svelte')
    .then((m) => m.default)
    .catch((err) => {
      readerChunk = undefined
      throw err
    }))
}

/** Fire-and-forget warm-up of the reader chunk. */
export function warmReader(): void {
  loadReader().catch(() => {})
}
