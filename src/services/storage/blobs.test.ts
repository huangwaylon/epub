import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

/**
 * blobs.ts memoises its OPFS probe (`opfsProbe`) at module scope, so each
 * availability scenario needs a fresh module instance. We `vi.resetModules()`
 * and dynamically import `./blobs` *after* stubbing `globalThis.navigator`, so
 * the probe latches against the navigator we want for that test.
 */

const EPUB_TYPE = 'application/epub+zip'

/** A minimal in-memory OPFS file handle whose write succeeds. */
function makeWritableFileHandle(store: { bytes?: Uint8Array }) {
  return {
    createWritable: vi.fn(async () => ({
      write: vi.fn(async (blob: Blob) => {
        store.bytes = new Uint8Array(await blob.arrayBuffer())
      }),
      close: vi.fn(async () => {}),
    })),
    getFile: vi.fn(async () => new File([(store.bytes ?? new Uint8Array()) as BlobPart], 'ignored.bin')),
  }
}

/**
 * Builds a fake OPFS directory handle plus the root `getDirectory` it hangs off.
 * `behaviour` lets individual tests break the write path or the createWritable.
 */
function makeFakeOpfs(behaviour: {
  failWrite?: boolean
  noCreateWritable?: boolean
  getDirectoryThrows?: boolean
} = {}) {
  const files = new Map<string, { bytes?: Uint8Array }>()

  const getFileHandle = vi.fn(async (name: string, opts?: { create?: boolean }) => {
    if (!files.has(name)) {
      if (!opts?.create) throw new DOMException('not found', 'NotFoundError')
      files.set(name, {})
    }
    const store = files.get(name)!
    const fh = makeWritableFileHandle(store) as Record<string, unknown>
    if (behaviour.noCreateWritable && name !== '.probe') {
      delete fh.createWritable
    } else if (behaviour.failWrite && name !== '.probe') {
      fh.createWritable = vi.fn(async () => ({
        write: vi.fn(async () => {
          throw new DOMException('quota', 'QuotaExceededError')
        }),
        close: vi.fn(async () => {}),
      }))
    }
    return fh
  })

  const removeEntry = vi.fn(async (name: string) => {
    files.delete(name)
  })

  const booksDir = {
    getFileHandle,
    removeEntry,
    getDirectoryHandle: vi.fn(),
  }

  const root = {
    getDirectoryHandle: vi.fn(async () => booksDir),
  }

  const getDirectory = vi.fn(async () => {
    if (behaviour.getDirectoryThrows) throw new Error('no opfs')
    return root
  })

  return { booksDir, root, getDirectory, getFileHandle, removeEntry, files }
}

function stubNavigator(storage: unknown) {
  vi.stubGlobal('navigator', storage === undefined ? {} : { storage })
}

async function loadBlobs() {
  vi.resetModules()
  return import('./blobs')
}

beforeEach(() => {
  // Fresh IndexedDB so the fallback store is empty per test, and the db.ts
  // module cache is irrelevant because blobs imports it freshly via resetModules.
  globalThis.indexedDB = new IDBFactory()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('blobs OPFS path', () => {
  it('writes via OPFS and getBookFile returns a <id>.epub File', async () => {
    const fake = makeFakeOpfs()
    stubNavigator({ getDirectory: fake.getDirectory })
    const { putBook, getBookFile } = await loadBlobs()

    const payload = new Uint8Array([1, 2, 3, 4])
    await putBook('book1', new Blob([payload]))

    // Written through the fake OPFS dir under the .epub name.
    expect(fake.getFileHandle).toHaveBeenCalledWith('book1.epub', { create: true })
    expect(fake.files.get('book1.epub')?.bytes).toEqual(payload)

    const file = await getBookFile('book1')
    expect(file).not.toBeNull()
    expect(file!.name).toBe('book1.epub')
    expect(file!.type).toBe(EPUB_TYPE)
  })

  it('getBookFile returns null when the OPFS file is absent', async () => {
    const fake = makeFakeOpfs()
    stubNavigator({ getDirectory: fake.getDirectory })
    const { getBookFile } = await loadBlobs()
    expect(await getBookFile('missing')).toBeNull()
  })
})

describe('blobs putBook orphan cleanup', () => {
  it('rejects and removes the partial .epub when the write fails', async () => {
    const fake = makeFakeOpfs({ failWrite: true })
    stubNavigator({ getDirectory: fake.getDirectory })
    const { putBook } = await loadBlobs()

    await expect(putBook('bad', new Blob([new Uint8Array([9])]))).rejects.toBeDefined()

    // The zero-length file created by getFileHandle({create:true}) is cleaned up.
    expect(fake.removeEntry).toHaveBeenCalledWith('bad.epub')
  })
})

describe('blobs IndexedDB fallback path', () => {
  it('falls back when navigator.storage is missing', async () => {
    stubNavigator(undefined)
    const { putBook, getBookFile } = await loadBlobs()

    const payload = new Uint8Array([5, 6, 7])
    await putBook('fb1', new Blob([payload]))

    const file = await getBookFile('fb1')
    expect(file).not.toBeNull()
    expect(file!.name).toBe('fb1.epub')
    expect(file!.type).toBe(EPUB_TYPE)
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(payload)
  })

  it('falls back when getDirectory throws', async () => {
    const fake = makeFakeOpfs({ getDirectoryThrows: true })
    stubNavigator({ getDirectory: fake.getDirectory })
    const { putBook, getBookFile } = await loadBlobs()

    await putBook('fb2', new Blob([new Uint8Array([1])]))
    // OPFS was never written to.
    expect(fake.files.has('fb2.epub')).toBe(false)
    const file = await getBookFile('fb2')
    expect(file).not.toBeNull()
    expect(file!.name).toBe('fb2.epub')
  })

  it('falls back when the probe file lacks createWritable', async () => {
    const fake = makeFakeOpfs({ noCreateWritable: true })
    // Probe must also lack createWritable for canUseOpfs to return false.
    fake.booksDir.getFileHandle.mockImplementation(async (name: string, opts?: { create?: boolean }) => {
      if (!opts?.create) throw new DOMException('not found', 'NotFoundError')
      return { getFile: vi.fn(async () => new File([], name)) } as any
    })
    stubNavigator({ getDirectory: fake.getDirectory })
    const { putBook, getBookFile } = await loadBlobs()

    const payload = new Uint8Array([3, 3, 3])
    await putBook('fb3', new Blob([payload]))
    const file = await getBookFile('fb3')
    expect(file).not.toBeNull()
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(payload)
  })
})

describe('blobs deleteBook', () => {
  it('removes from OPFS and always also attempts the fallback delete', async () => {
    const fake = makeFakeOpfs()
    stubNavigator({ getDirectory: fake.getDirectory })
    const { putBook, deleteBook, getBookFile } = await loadBlobs()

    await putBook('del1', new Blob([new Uint8Array([1, 2])]))
    expect(fake.files.has('del1.epub')).toBe(true)

    await deleteBook('del1')
    expect(fake.removeEntry).toHaveBeenCalledWith('del1.epub')
    expect(await getBookFile('del1')).toBeNull()
  })

  it('attempts the fallback delete even when OPFS is unavailable', async () => {
    stubNavigator(undefined)
    const { putBook, deleteBook, getBookFile } = await loadBlobs()

    await putBook('del2', new Blob([new Uint8Array([1])]))
    expect(await getBookFile('del2')).not.toBeNull()

    await deleteBook('del2')
    expect(await getBookFile('del2')).toBeNull()
  })
})
