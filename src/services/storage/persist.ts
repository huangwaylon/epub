/** Installed iOS PWAs are exempt from WebKit's 7-day eviction; we still request
 *  persistence, and expose usage for the settings sheet. */

export interface StorageStatus {
  persisted: boolean
  usage: number
  quota: number
}

/** Safe to call repeatedly. */
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
