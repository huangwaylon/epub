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
  annotations.items = annotations.items.filter((x) => x.id !== id)
  await deleteAnnotation(id)
}

export function newId(): string {
  return crypto.randomUUID()
}
