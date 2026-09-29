import { importEpub } from './library'
import { getAllBooks } from './storage/db'

const BUNDLED_BOOKS = [
  '/books/コンビニ人間 (村田沙耶香)-translated.epub',
  '/books/森崎書店の日々 (八木沢里志)-translated.epub',
  '/books/成瀬は天下を取りにいく (宮島未奈)-translated.epub',
  '/books/成瀬は信じた道をいく (宮島未奈)-translated.epub',
  '/books/成瀬は都を駆け抜ける (宮島未奈)-translated.epub',
  '/books/木曜日にはココアを-translated.epub'
]

export async function importBundledBooks() {
  const books = await getAllBooks()
  const existingTitles = new Set(books.map(b => b.title))

  for (const url of BUNDLED_BOOKS) {
    try {
      const fileName = decodeURIComponent(url.split('/').pop() || '')
      // Simple heuristic: if the filename matches a book title (minus .epub), skip it
      const title = fileName.replace(/\.epub$/i, '')
      if (existingTitles.has(title)) continue
      
      const res = await fetch(import.meta.env.BASE_URL + url.replace(/^\//, ''))
      if (!res.ok) continue
      const blob = await res.blob()
      const file = new File([blob], fileName, { type: 'application/epub+zip' })
      await importEpub(file)
    } catch (err) {
      console.warn('Failed to import bundled book', url, err)
    }
  }
}
