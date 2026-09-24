/** Reactive status of the offline Japanese dictionary (download + readiness). */
export const dict = $state<{
  state: 'init' | 'empty' | 'ok' | 'unavailable'
  updating: boolean
  /** 0..1 download progress while updating. */
  progress: number
  /** IPADIC being cached (and, from the reader, kuromoji built) after the JMdict download. */
  warming: boolean
  /** A permanent failure, or — while `updating` — the transient retry message. */
  error?: string
}>({
  state: 'init',
  updating: false,
  progress: 0,
  warming: false,
})
