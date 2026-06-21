<script lang="ts">
  import { HIGHLIGHT_HEX, type HighlightColor } from '../../services/types'
  import { placeAnchored } from '../util/anchoredPosition'
  import Icon from '../components/Icon.svelte'

  let {
    open = false,
    rect = { left: 0, top: 0, width: 0, height: 0 },
    activeColor,
    showCopy = true,
    showDelete = false,
    onColor,
    onCopy,
    onDelete,
  }: {
    open?: boolean
    rect?: { left: number; top: number; width: number; height: number }
    activeColor?: HighlightColor
    showCopy?: boolean
    showDelete?: boolean
    onColor?: (c: HighlightColor) => void
    onCopy?: () => void
    onDelete?: () => void
  } = $props()

  const colors: HighlightColor[] = ['yellow', 'green', 'blue', 'pink']

  let bar = $state<HTMLDivElement>()
  let pos = $state({ left: 0, top: 0 })
  $effect(() => {
    if (!open) return
    const r = rect
    requestAnimationFrame(() => {
      const w = bar?.offsetWidth ?? 240
      const h = bar?.offsetHeight ?? 48
      pos = placeAnchored(r.left + r.width / 2, r.top, r.top + r.height, w, h)
    })
  })
</script>

{#if open}
  <div bind:this={bar} class="toolbar" style="left:{pos.left}px; top:{pos.top}px" role="toolbar">
    {#each colors as c}
      <button
        class="swatch"
        class:active={c === activeColor}
        aria-label={`Highlight ${c}`}
        onclick={() => onColor?.(c)}
      >
        <span class="dot" style="--c:{HIGHLIGHT_HEX[c]}"></span>
      </button>
    {/each}
    {#if showCopy || showDelete}<span class="sep"></span>{/if}
    {#if showCopy}
      <button class="act" aria-label="Copy" onclick={onCopy}><Icon name="copy" size={19} /></button>
    {/if}
    {#if showDelete}
      <button class="act danger" aria-label="Delete highlight" onclick={onDelete}><Icon name="trash" size={19} /></button>
    {/if}
  </div>
{/if}

<style>
  .toolbar {
    position: fixed;
    z-index: 52;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 6px;
    border-radius: 100px;
    background: var(--paper-raised);
    border: 1px solid var(--line);
    box-shadow: var(--shadow-2);
    animation: pop 0.13s var(--ease);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translateY(4px) scale(0.96);
    }
  }
  /* 44px hit areas (HIG) with a smaller visible swatch/icon inside. */
  .swatch {
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border-radius: 50%;
  }
  .dot {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--c);
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
  }
  .swatch.active .dot {
    box-shadow:
      inset 0 0 0 1px rgba(0, 0, 0, 0.12),
      0 0 0 2px var(--paper-raised),
      0 0 0 4px var(--ink-soft);
  }
  .sep {
    width: 1px;
    height: 24px;
    margin: 0 4px;
    background: var(--line-strong);
  }
  .act {
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--ink-soft);
  }
  .act:active {
    background: var(--accent-soft);
  }
  .act.danger {
    color: #c0392b;
  }
</style>
