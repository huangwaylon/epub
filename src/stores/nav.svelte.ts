/** Minimal in-memory router. The app has two screens: the shelf and the reader. */

export type Route = { name: 'shelf' } | { name: 'reader'; bookId: string }

export const nav = $state<{ route: Route }>({ route: { name: 'shelf' } })

export function openReader(bookId: string): void {
  nav.route = { name: 'reader', bookId }
}

export function openShelf(): void {
  nav.route = { name: 'shelf' }
}
