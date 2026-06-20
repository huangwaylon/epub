/** Reactive status of the offline Japanese dictionary (download + readiness). */
export const dict = $state<{
  state: 'init' | 'empty' | 'ok' | 'unavailable'
  updating: boolean
  /** 0..1 download progress while updating. */
  progress: number
  error?: string
}>({
  state: 'init',
  updating: false,
  progress: 0,
})
