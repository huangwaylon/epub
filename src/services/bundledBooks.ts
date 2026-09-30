import { importEpub } from './library'
import { getAllBooks } from './storage/db'

interface CatalogEntry {
  id: string
  file: string
}

export async function importBundledBooks() {
  const base = import.meta.env.BASE_URL + 'books/'
  const catalog: CatalogEntry[] = await (await fetch(base + 'catalog.json')).json()
  const have = new Set((await getAllBooks()).map((b) => b.id))
  for (const entry of catalog) {
    if (have.has(entry.id)) continue
    try {
      const res = await fetch(base + entry.file)
      if (!res.ok) continue
      await importEpub(new File([await res.blob()], entry.file, { type: 'application/epub+zip' }))
    } catch (err) {
      console.warn('Failed to import bundled book', entry.file, err)
    }
  }
}
