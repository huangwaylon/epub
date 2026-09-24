<script lang="ts">
  import Icon from './Icon.svelte'

  let { title, onback }: { title?: string; onback?: () => void } = $props()
</script>

<div class="loading-screen" aria-busy="true">
  <div class="stack">
    {#if title}<p class="title" lang="ja">{title}</p>{/if}
    <div class="progress-indeterminate" role="progressbar" aria-label="Opening book"></div>
  </div>
  {#if onback}
    <button class="btn back" onclick={onback}><Icon name="chevron-left" size="sm" /> Library</button>
  {/if}
</div>

<style>
  .loading-screen {
    position: fixed;
    inset: 0;
    height: var(--app-height, 100dvh);
    z-index: var(--z-overlay);
    display: grid;
    place-items: center;
    padding: var(--sp-6);
    background: var(--paper);
    color: var(--ink-soft);
  }
  .stack {
    display: grid;
    justify-items: center;
    gap: var(--sp-5);
    opacity: 0;
    animation: t-fade-in var(--dur-slow) var(--ease-out) 0.25s forwards;
  }
  .title {
    margin: 0;
    max-width: 22em;
    font-family: var(--font-serif);
    font-size: var(--fs-title);
    font-weight: 600;
    line-height: 1.4;
    text-align: center;
    color: var(--ink);
  }
  .back {
    position: absolute;
    left: calc(var(--safe-left) + var(--sp-3));
    top: calc(var(--safe-top) + var(--sp-2));
    padding-inline: var(--sp-3) var(--sp-4);
    gap: var(--sp-1);
  }
</style>
