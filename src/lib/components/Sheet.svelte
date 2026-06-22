<script lang="ts">
  import type { Snippet } from 'svelte'
  import { fade } from 'svelte/transition'
  import Icon from './Icon.svelte'

  let {
    open = $bindable(false),
    title,
    onclose,
    children,
    maxHeight = '85dvh',
  }: {
    open?: boolean
    title?: string
    onclose?: () => void
    children: Snippet
    maxHeight?: string
  } = $props()

  function close() {
    open = false
    onclose?.()
  }

  // Honour aria-modal: move focus into the sheet on open so VoiceOver / keyboard
  // users land inside it, and restore focus to the trigger on close.
  let sheetEl = $state<HTMLElement>()
  let restoreFocus: HTMLElement | null = null
  $effect(() => {
    if (open) {
      restoreFocus = (document.activeElement as HTMLElement) ?? null
      sheetEl?.focus()
    } else if (restoreFocus) {
      restoreFocus.focus?.()
      restoreFocus = null
    }
  })
</script>

{#if open}
  <div
    class="scrim"
    role="presentation"
    onclick={close}
    transition:fade
  ></div>
  <div
    bind:this={sheetEl}
    class="sheet"
    style="--max:{maxHeight}"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
  >
    <div class="grip-wrap" role="presentation" onclick={close}>
      <div class="grip"></div>
    </div>
    {#if title}
      <header>
        <h2>{title}</h2>
        <button class="close" onclick={close} aria-label="Close">
          <Icon name="x" size={20} />
        </button>
      </header>
    {/if}
    <div class="body">
      {@render children()}
    </div>
  </div>
{/if}

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && close()} />

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    z-index: 40;
  }
  .sheet {
    position: fixed;
    inset: auto 0 0 0;
    z-index: 41;
    max-height: var(--max);
    display: flex;
    flex-direction: column;
    background: var(--paper-raised);
    border-radius: var(--r-xl) var(--r-xl) 0 0;
    box-shadow: var(--shadow-2);
    padding-bottom: calc(var(--safe-bottom) + 8px);
    animation: rise var(--dur) var(--ease);
    /* Promote to its own layer for the rise/pop animation so WebKit doesn't repaint
       the large --shadow-2 blur every frame while the sheet transforms in. */
    will-change: transform;
    overscroll-behavior: contain;
  }
  @keyframes rise {
    from {
      transform: translateY(100%);
    }
  }

  /* On iPad-width screens, present as a centred modal card rather than a
     full-width bottom sheet. */
  @media (min-width: 768px) {
    .sheet {
      inset: auto;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: min(480px, calc(100vw - 96px));
      max-height: min(82dvh, 760px);
      border-radius: var(--r-xl);
      padding-bottom: 10px;
      animation: pop-center var(--dur) var(--ease);
    }
    .grip-wrap {
      display: none;
    }
    header {
      padding-top: 18px;
    }
  }
  @keyframes pop-center {
    from {
      opacity: 0;
      transform: translate(-50%, -46%) scale(0.97);
    }
  }
  .grip-wrap {
    display: flex;
    justify-content: center;
    padding: 10px 0 4px;
    cursor: grab;
  }
  .grip {
    width: 38px;
    height: 5px;
    border-radius: 3px;
    background: var(--line-strong);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 8px 10px 20px;
  }
  h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 650;
  }
  .close {
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--ink-soft);
    background: var(--accent-soft);
  }
  .body {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 0 20px;
  }
</style>
