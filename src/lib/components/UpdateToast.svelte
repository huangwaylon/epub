<script lang="ts">
  import { pwa } from '../../stores/pwa.svelte'

  // Auto-dismiss the one-time "ready offline" confirmation (the update prompt stays
  // until the user acts on it). The effect's cleanup clears the timer if the toast is
  // dismissed or the component unmounts, so no stray timer survives.
  $effect(() => {
    if (!pwa.offlineReady) return
    const t = setTimeout(() => (pwa.offlineReady = false), 4000)
    return () => clearTimeout(t)
  })
</script>

{#if pwa.needRefresh}
  <div class="toast" role="status">
    <span>A new version is ready.</span>
    <button onclick={() => pwa.update()}>Refresh</button>
    <button class="dismiss" onclick={() => (pwa.needRefresh = false)} aria-label="Dismiss">✕</button>
  </div>
{:else if pwa.offlineReady}
  <div class="toast" role="status">
    <span>Ready to read offline.</span>
    <button class="dismiss" onclick={() => (pwa.offlineReady = false)} aria-label="Dismiss">✕</button>
  </div>
{/if}

<style>
  .toast {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: calc(var(--safe-bottom) + 18px);
    z-index: 60;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px 10px 18px;
    border-radius: 100px;
    font-size: 14px;
    color: var(--ink);
    background: var(--paper-raised);
    box-shadow: var(--shadow-2);
    animation: rise 0.25s var(--ease);
    /* Layer-promote during the rise so the large shadow isn't repainted per frame. */
    will-change: transform;
  }
  @keyframes rise {
    from {
      transform: translate(-50%, 120%);
    }
  }
  button {
    font-weight: 650;
    color: var(--accent);
    min-height: 44px;
    padding: 6px 14px;
    border-radius: 100px;
  }
  .dismiss {
    color: var(--ink-faint);
    font-weight: 400;
    display: grid;
    place-items: center;
    width: 44px;
    min-height: 44px;
    padding: 0;
  }
</style>
