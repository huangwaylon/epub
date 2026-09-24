import type { Annotation } from '../services/types'
import { getAnnotations, putAnnotation, deleteAnnotation } from '../services/storage/db'

/**
 * The open book's highlights + bookmarks. An immutable `$state.raw` array, replaced on
 * every change: it can hold thousands of records, so nothing is deep-proxied.
 * Mutate only through the functions below.
 */
let items = $state.raw<readonly Annotation[]>([])

export const annotations = {
  get items(): readonly Annotation[] {
    return items
  },
}

/** Non-reactive indexes rebuilt with `items`, so per-tap checks never scan the array. */
const byId = new Map<string, Annotation>()
const highlightsByCFI = new Map<string, Annotation[]>()

function setItems(next: readonly Annotation[]): void {
  items = next
  byId.clear()
  highlightsByCFI.clear()
  for (const a of next) {
    byId.set(a.id, a)
    if (a.kind === 'highlight') {
      const list = highlightsByCFI.get(a.cfi)
      if (list) list.push(a)
      else highlightsByCFI.set(a.cfi, [a])
    }
  }
}

/** Background write: in-memory state never waits on IndexedDB. */
function persist(p: Promise<void>): void {
  p.catch((err) => console.warn('Could not persist annotation', err))
}

/** A slow load for a book already left must not land in the next one. */
let loadGen = 0

export async function loadAnnotations(bookId: string): Promise<void> {
  const gen = ++loadGen
  const loaded = await getAnnotations(bookId)
  if (gen !== loadGen) return
  setItems(loaded)
}

export function clearAnnotations(): void {
  loadGen++
  setItems([])
}

/** Whether a highlight exists at `cfi`. */
export function isHighlighted(cfi: string): boolean {
  return highlightsByCFI.has(cfi)
}

/** The (first) highlight record at `cfi`, if any. */
export function highlightAt(cfi: string): Annotation | undefined {
  return highlightsByCFI.get(cfi)?.[0]
}

/** The single highlight create path, deduped on CFI; persists in the background. */
export function addHighlightRecord(o: { bookId: string; cfi: string; text: string; sectionLabel?: string }): void {
  if (highlightsByCFI.has(o.cfi)) return
  const annotation: Annotation = {
    id: newId(),
    bookId: o.bookId,
    kind: 'highlight',
    cfi: o.cfi,
    text: o.text.slice(0, 240),
    sectionLabel: o.sectionLabel,
    createdAt: Date.now(),
  }
  setItems([...items, annotation])
  persist(putAnnotation(annotation))
}

/** Remove every highlight record at `cfi` (older data may hold duplicates). */
export function removeHighlightRecord(cfi: string): void {
  const gone = highlightsByCFI.get(cfi)
  if (!gone?.length) return
  const ids = new Set(gone.map((a) => a.id))
  setItems(items.filter((a) => !ids.has(a.id)))
  for (const id of ids) persist(deleteAnnotation(id))
}

/** Insert or replace by id (bookmarks, undo). */
export async function saveAnnotation(a: Annotation): Promise<void> {
  setItems(byId.has(a.id) ? items.map((x) => (x.id === a.id ? a : x)) : [...items, a])
  await putAnnotation(a)
}

/** Remove by id; the in-memory list updates synchronously. */
export async function removeAnnotation(id: string): Promise<void> {
  if (byId.has(id)) setItems(items.filter((x) => x.id !== id))
  await deleteAnnotation(id)
}

export function newId(): string {
  return crypto.randomUUID()
}
