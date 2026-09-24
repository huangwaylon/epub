import type { Annotation } from '../services/types'
import { getAnnotations, putAnnotation, deleteAnnotation } from '../services/storage/db'

/**
 * The current book's annotations (highlights + bookmarks).
 *
 * `items` is a `$state.raw` **immutable** array: every change replaces it wholesale, so
 * nothing is deep-proxied (tap-to-define records *every* looked-up word, and proxying a
 * few thousand records — then re-proxying on each splice — was pure overhead for data the
 * UI only ever reads) and a single reassignment is the one signal subscribers get.
 * Read it as `annotations.items`; mutate only through the functions below.
 */
let items = $state.raw<readonly Annotation[]>([])

export const annotations = {
  get items(): readonly Annotation[] {
    return items
  },
}

/**
 * Plain (non-reactive) indexes derived from `items`, rebuilt on every replacement, so the
 * hot path never scans the array: the per-tap "is this CFI already highlighted?" check,
 * and the highlight record for a CFI (tapping a highlight reopens its stored word).
 */
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

/** Persist in the background: the in-memory state (and the painted overlay) must never
 *  wait on IndexedDB, and a failed write shouldn't reject into a tap handler. */
function persist(p: Promise<void>): void {
  p.catch((err) => console.warn('Could not persist annotation', err))
}

/** Bumped by every load/clear, so a slow `getAnnotations` for a book the reader already
 *  left can't land in (and overwrite) the next book's state. */
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

/** Whether a highlight already exists at `cfi` (O(1); no array scan). */
export function isHighlighted(cfi: string): boolean {
  return highlightsByCFI.has(cfi)
}

/** The (first) highlight record at `cfi`, if any. */
export function highlightAt(cfi: string): Annotation | undefined {
  return highlightsByCFI.get(cfi)?.[0]
}

/**
 * Record a highlight at `cfi`, **deduped on CFI**: if one already exists there it is
 * returned unchanged and nothing is written. The in-memory state updates synchronously;
 * the IndexedDB write happens in the background. Returns the record and whether it was
 * newly created. The single create path for tap-to-define, the popup's "Highlight"
 * toggle, and drag-select → Highlight.
 */
export function addHighlightRecord(o: {
  bookId: string
  cfi: string
  text: string
  sectionLabel?: string
}): { annotation: Annotation; created: boolean } {
  const existing = highlightAt(o.cfi)
  if (existing) return { annotation: existing, created: false }
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
  return { annotation, created: true }
}

/** Remove every highlight record at `cfi` (older data may hold duplicates). Returns
 *  whether any existed. In-memory state updates synchronously; deletes persist behind. */
export function removeHighlightRecord(cfi: string): boolean {
  const gone = highlightsByCFI.get(cfi)
  if (!gone?.length) return false
  const ids = new Set(gone.map((a) => a.id))
  setItems(items.filter((a) => !ids.has(a.id)))
  for (const id of ids) persist(deleteAnnotation(id))
  return true
}

/** Insert or replace an annotation by id (bookmarks; highlights go through
 *  `addHighlightRecord`). */
export async function saveAnnotation(a: Annotation): Promise<void> {
  setItems(byId.has(a.id) ? items.map((x) => (x.id === a.id ? a : x)) : [...items, a])
  await putAnnotation(a)
}

/** Remove one annotation by id. Returns the removed record (so a caller deleting a
 *  highlight can tell whether its CFI is still highlighted by another record). */
export async function removeAnnotation(id: string): Promise<Annotation | undefined> {
  const gone = byId.get(id)
  if (gone) setItems(items.filter((x) => x.id !== id))
  await deleteAnnotation(id)
  return gone
}

export function newId(): string {
  return crypto.randomUUID()
}
