/** Service-worker update state, surfaced to the UI as a gentle "update ready" toast. */
export const pwa = $state<{
  needRefresh: boolean
  offlineReady: boolean
  update: () => void
}>({
  needRefresh: false,
  offlineReady: false,
  update: () => {},
})
