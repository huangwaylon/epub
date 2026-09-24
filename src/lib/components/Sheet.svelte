<script lang="ts">
  import type { Snippet } from 'svelte'
  import { fade } from 'svelte/transition'
  import Icon from './Icon.svelte'
  import { DUR, dur, sheetMotion } from '../util/motion.svelte'

  let {
    open = $bindable(false),
    title,
    onclose,
    children,
    maxHeight = '85dvh',
    variant = 'sheet',
    anchor,
  }: {
    open?: boolean
    title?: string
    onclose?: () => void
    children: Snippet
    maxHeight?: string
    /** `popover`: clear scrim (live preview); on iPad a glass popover under `anchor`. */
    variant?: 'sheet' | 'popover'
    anchor?: HTMLElement | null
  } = $props()

  function close() {
    open = false
    onclose?.()
  }

  const popover = $derived(variant === 'popover')

  // aria-modal: focus moves in on open and back to the trigger on close. Edge-gated so the
  // `bind:this` re-run doesn't capture the sheet itself as the restore target.
  let sheetEl = $state<HTMLElement>()
  let restoreFocus: HTMLElement | null = null
  let wasOpen = false
  $effect(() => {
    if (open && !wasOpen) restoreFocus = (document.activeElement as HTMLElement) ?? null
    if (open) sheetEl?.focus({ preventScroll: true })
    else if (wasOpen && restoreFocus) {
      restoreFocus.focus?.()
      restoreFocus = null
    }
    wasOpen = open
  })

  // Popover: under the anchor, right edges aligned; measured on open and resize only.
  let popPos = $state<{ top: number; right: number } | null>(null)
  function place() {
    if (!anchor) return (popPos = null)
    const r = anchor.getBoundingClientRect()
    popPos = { top: Math.round(r.bottom + 10), right: Math.max(12, Math.round(window.innerWidth - r.right - 4)) }
  }
  $effect(() => {
    if (!open || !popover) return
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  })
</script>

{#if open}
  <div
    class="scrim"
    class:clear={popover}
    role="presentation"
    onclick={close}
    transition:fade={{ duration: dur(popover ? 0 : DUR.base) }}
  ></div>
  <div
    bind:this={sheetEl}
    class="sheet"
    class:popover
    style="--max:{maxHeight};{popover && popPos ? `--pop-top:${popPos.top}px;--pop-right:${popPos.right}px` : ''}"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    in:sheetMotion={{ intro: true, popover }}
    out:sheetMotion={{ intro: false, popover }}
  >
    <div class="grip-wrap" role="presentation" onclick={close}>
      <div class="grip"></div>
    </div>
    {#if title}
      <header>
        <h2>{title}</h2>
        <button class="icon-btn close" onclick={close} aria-label="Close">
          <Icon name="x" size="sm" />
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
    z-index: var(--z-scrim);
  }
  .scrim.clear {
    background: transparent;
  }
  .sheet {
    position: fixed;
    inset: auto 0 0 0;
    z-index: var(--z-sheet);
    max-height: var(--max);
    display: flex;
    flex-direction: column;
    background: var(--paper-raised);
    border-radius: var(--r-xl) var(--r-xl) 0 0;
    box-shadow: var(--shadow-3);
    padding-bottom: calc(var(--safe-bottom) + var(--sp-2));
    /* Own layer, so WebKit doesn't repaint the shadow blur every transition frame. */
    will-change: transform;
    overscroll-behavior: contain;
    outline: none;
  }
  .grip-wrap {
    display: flex;
    justify-content: center;
    padding: var(--sp-2) 0 var(--sp-1);
    cursor: grab;
  }
  .grip {
    width: 36px;
    height: 5px;
    border-radius: var(--r-full);
    background: var(--line-strong);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--sp-1) var(--sp-3) var(--sp-3) var(--sp-5);
  }
  h2 {
    margin: 0;
    font-size: var(--fs-callout);
    font-weight: 650;
  }
  .close {
    /* 32px disc, 44px hit area */
    width: 32px;
    height: 32px;
    position: relative;
    background: var(--control-track);
  }
  .close::after {
    content: '';
    position: absolute;
    inset: -6px;
  }
  .body {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 0 var(--sp-5);
  }

  /* iPad: centred card or anchored popover (must follow the base rules). */
  @media (min-width: 768px) {
    .sheet {
      inset: auto;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: min(480px, calc(100vw - 96px));
      max-height: min(82dvh, 760px);
      border-radius: var(--r-xl);
      padding-bottom: var(--sp-3);
    }
    .sheet.popover {
      top: var(--pop-top, calc(var(--safe-top) + 76px));
      right: var(--pop-right, calc(var(--safe-right) + 16px));
      left: auto;
      transform: none;
      transform-origin: top right;
      width: 360px;
      max-height: min(calc(100dvh - var(--pop-top, 96px) - var(--safe-bottom) - 16px), 760px);
      background: var(--glass-bg-strong);
      -webkit-backdrop-filter: var(--glass-filter);
      backdrop-filter: var(--glass-filter);
      box-shadow: var(--glass-shadow);
    }
    .grip-wrap {
      display: none;
    }
    header {
      padding-top: var(--sp-4);
    }
  }
</style>
