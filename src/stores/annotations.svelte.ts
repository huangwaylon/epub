import type { Annotation } from '../services/types'
import { getAnnotations, putAnnotation, deleteAnnotation } from '../services/storage/db'

/** Reactive list of the current book's annotations (highlights + bookmarks). */
export const annotations = $state<{ items: Annotation[] }>({ items: [] })

export async function loadAnnotations(bookId: string): Promise<void> {
  annotations.items = await getAnnotations(bookId)
}

export function clearAnnotations(): void {
  annotations.items = []
}

export async function saveAnnotation(a: Annotation): Promise<void> {
  const existing = annotations.items.findIndex((x) => x.id === a.id)
  if (existing >= 0) annotations.items[existing] = a
  else annotations.items.push(a)
  await putAnnotation(a)
}

export async function removeAnnotation(id: string): Promise<void> {
  // Splice in place rather than reassigning `items = items.filter(...)`: replacing
  // the array re-proxies every element and invalidates all subscribers at once,
  // whereas a targeted splice only signals the removed index — cheaper for the
  // reader overlay and the annotations panel on a heavily-highlighted book.
  const idx = annotations.items.findIndex((x) => x.id === id)
  if (idx >= 0) annotations.items.splice(idx, 1)
  await deleteAnnotation(id)
}

export function newId(): string {
  return crypto.randomUUID()
}
