import type { Annotation } from '../services/types'
import { getAnnotations, putAnnotation, deleteAnnotation } from '../services/storage/db'

/** Reactive list of the current book's annotations (highlights + bookmarks). */
export const annotations = $state<{ items: Annotation[] }>({ items: [] })

/**
 * Plain (non-reactive) indexes over `items`, so the hot path doesn't scan the array.
 * Tap-to-define saves an annotation for *every* looked-up word and first asks "is this
 * CFI already highlighted?" — a `.some()` that can't short-circuit, over a
 * `$state`-proxied array, on every tap. These keep those checks O(1); `items` stays the
 * single source of truth for rendering.
 */
const ids = new Set<string>()
const highlightCFIs = new Set<string>()

function reindex(): void {
  ids.clear()
  highlightCFIs.clear()
  for (const a of annotations.items) {
    ids.add(a.id)
    if (a.kind === 'highlight') highlightCFIs.add(a.cfi)
  }
}

export async function loadAnnotations(bookId: string): Promise<void> {
  annotations.items = await getAnnotations(bookId)
  reindex()
}

export function clearAnnotations(): void {
  annotations.items = []
  ids.clear()
  highlightCFIs.clear()
}

/** Whether a highlight already exists at `cfi` (O(1); no array scan). */
export function isHighlighted(cfi: string): boolean {
  return highlightCFIs.has(cfi)
}

export async function saveAnnotation(a: Annotation): Promise<void> {
  if (ids.has(a.id)) {
    const existing = annotations.items.findIndex((x) => x.id === a.id)
    if (existing >= 0) annotations.items[existing] = a
    else annotations.items.push(a)
  } else {
    annotations.items.push(a)
    ids.add(a.id)
  }
  if (a.kind === 'highlight') highlightCFIs.add(a.cfi)
  await putAnnotation(a)
}

export async function removeAnnotation(id: string): Promise<void> {
  // Splice in place rather than reassigning `items = items.filter(...)`: replacing
  // the array re-proxies every element and invalidates all subscribers at once,
  // whereas a targeted splice only signals the removed index — cheaper for the
  // reader overlay and the annotations panel on a heavily-highlighted book.
  const idx = annotations.items.findIndex((x) => x.id === id)
  if (idx >= 0) {
    const [gone] = annotations.items.splice(idx, 1)
    ids.delete(id)
    // Another annotation could share the CFI (a bookmark, or a re-added highlight), so
    // only drop it from the index when no highlight is left at that CFI.
    if (gone?.kind === 'highlight' && !annotations.items.some((x) => x.kind === 'highlight' && x.cfi === gone.cfi))
      highlightCFIs.delete(gone.cfi)
  }
  await deleteAnnotation(id)
}

export function newId(): string {
  return crypto.randomUUID()
}
