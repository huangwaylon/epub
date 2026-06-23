/** Reactive status of the offline Japanese dictionary (download + readiness). */
export const dict = $state<{
  state: 'init' | 'empty' | 'ok' | 'unavailable'
  updating: boolean
  /** 0..1 download progress while updating. */
  progress: number
  /** True while the ~19 MB kuromoji IPADIC dict is being fetched + SW-cached for
   *  offline use, right after the JMdict download. Until this clears, segmentation
   *  isn't guaranteed to work offline yet. */
  warming: boolean
  error?: string
}>({
  state: 'init',
  updating: false,
  progress: 0,
  warming: false,
})
