<script lang="ts">
  import { pwa } from '../../stores/pwa.svelte'
</script>

{#if pwa.needRefresh}
  <div class="toast" role="status">
    <span>A new version is ready.</span>
    <button onclick={() => pwa.update()}>Refresh</button>
    <button class="dismiss" onclick={() => (pwa.needRefresh = false)} aria-label="Dismiss">✕</button>
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
  }
  @keyframes rise {
    from {
      transform: translate(-50%, 120%);
    }
  }
  button {
    font-weight: 650;
    color: var(--accent);
    padding: 6px 10px;
    border-radius: 100px;
  }
  .dismiss {
    color: var(--ink-faint);
    font-weight: 400;
    padding: 6px 8px;
  }
</style>
