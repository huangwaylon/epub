<script lang="ts">
  import { pwa } from '../../stores/pwa.svelte'
  import { nav } from '../../stores/nav.svelte'
  import { toast, actOnToast, dismissToast } from '../../stores/toast.svelte'
  import Toast from './Toast.svelte'

  // The one-time "ready offline" confirmation auto-dismisses; the update prompt stays
  // until the user acts on it. The effect cleanup clears the timer if it's dismissed first.
  $effect(() => {
    if (!pwa.offlineReady) return
    const t = setTimeout(() => (pwa.offlineReady = false), 4000)
    return () => clearTimeout(t)
  })

  const lift = $derived(nav.route.name === 'reader')
</script>

<!-- App messages win over the update prompt, which reappears once they clear. -->
{#if toast.current}
  {#key toast.current.id}
    <Toast
      message={toast.current.message}
      actionLabel={toast.current.action?.label}
      onaction={actOnToast}
      ondismiss={toast.current.action ? dismissToast : undefined}
      {lift}
    />
  {/key}
{:else if pwa.needRefresh}
  <Toast
    message="A new version is ready."
    actionLabel="Refresh"
    onaction={() => pwa.update()}
    ondismiss={() => (pwa.needRefresh = false)}
    {lift}
  />
{:else if pwa.offlineReady}
  <Toast message="Ready to read offline." ondismiss={() => (pwa.offlineReady = false)} {lift} />
{/if}
