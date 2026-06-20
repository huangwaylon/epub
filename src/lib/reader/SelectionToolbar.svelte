<script lang="ts">
  import { HIGHLIGHT_HEX, type HighlightColor } from '../../services/types'
  import Icon from '../components/Icon.svelte'

  let {
    open = false,
    rect = { left: 0, top: 0, width: 0, height: 0 },
    activeColor,
    showCopy = true,
    showTranslate = true,
    showDelete = false,
    onColor,
    onCopy,
    onTranslate,
    onDelete,
  }: {
    open?: boolean
    rect?: { left: number; top: number; width: number; height: number }
    activeColor?: HighlightColor
    showCopy?: boolean
    showTranslate?: boolean
    showDelete?: boolean
    onColor?: (c: HighlightColor) => void
    onCopy?: () => void
    onTranslate?: () => void
    onDelete?: () => void
  } = $props()

  const colors: HighlightColor[] = ['yellow', 'green', 'blue', 'pink']

  let bar = $state<HTMLDivElement>()
  let pos = $state({ left: 0, top: 0 })
  $effect(() => {
    if (!open) return
    void rect
    requestAnimationFrame(() => {
      const w = bar?.offsetWidth ?? 240
      const h = bar?.offsetHeight ?? 48
      const m = 10
      let left = rect.left + rect.width / 2 - w / 2
      left = Math.max(m, Math.min(window.innerWidth - w - m, left))
      let top = rect.top - h - 12
      if (top < m + 40) top = rect.top + rect.height + 12
      top = Math.max(m, Math.min(window.innerHeight - h - m, top))
      pos = { left, top }
    })
  })
</script>

{#if open}
  <div bind:this={bar} class="toolbar" style="left:{pos.left}px; top:{pos.top}px" role="toolbar">
    {#each colors as c}
      <button
        class="swatch"
        class:active={c === activeColor}
        style="--c:{HIGHLIGHT_HEX[c]}"
        aria-label={`Highlight ${c}`}
        onclick={() => onColor?.(c)}
      ></button>
    {/each}
    {#if showCopy || showTranslate || showDelete}<span class="sep"></span>{/if}
    {#if showCopy}
      <button class="act" aria-label="Copy" onclick={onCopy}><Icon name="note" size={19} /></button>
    {/if}
    {#if showTranslate}
      <button class="act" aria-label="Translate" onclick={onTranslate}><Icon name="translate" size={19} /></button>
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
    gap: 8px;
    padding: 8px 10px;
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
  .swatch {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--c);
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
  }
  .swatch.active {
    box-shadow:
      inset 0 0 0 1px rgba(0, 0, 0, 0.12),
      0 0 0 2px var(--paper-raised),
      0 0 0 4px var(--ink-soft);
  }
  .sep {
    width: 1px;
    height: 24px;
    background: var(--line-strong);
  }
  .act {
    width: 34px;
    height: 34px;
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
