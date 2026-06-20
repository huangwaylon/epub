/**
 * Storage durability helpers. Installed (home-screen) PWAs on iOS are exempt
 * from WebKit's 7-day script-writable-storage eviction, but we still request
 * persistent storage explicitly and expose usage so the UI can warn near quota.
 */

export interface StorageStatus {
  persisted: boolean
  usage: number
  quota: number
}

/** Ask the browser to keep our data; safe to call repeatedly. Returns the result. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true
    if (navigator.storage?.persist) return await navigator.storage.persist()
  } catch {
    /* not supported — fall through */
  }
  return false
}

export async function storageStatus(): Promise<StorageStatus> {
  let persisted = false
  let usage = 0
  let quota = 0
  try {
    persisted = (await navigator.storage?.persisted?.()) ?? false
    const est = await navigator.storage?.estimate?.()
    usage = est?.usage ?? 0
    quota = est?.quota ?? 0
  } catch {
    /* ignore */
  }
  return { persisted, usage, quota }
}

export function formatBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
