<script lang="ts">
  import { HIGHLIGHT_HEX } from '../../services/types'
  import { placeAnchored } from '../util/anchoredPosition'
  import Icon from '../components/Icon.svelte'

  let {
    open = false,
    rect = { left: 0, top: 0, width: 0, height: 0 },
    onHighlight,
    onCopy,
  }: {
    open?: boolean
    rect?: { left: number; top: number; width: number; height: number }
    onHighlight?: () => void
    onCopy?: () => void
  } = $props()

  let bar = $state<HTMLDivElement>()
  let pos = $state({ left: 0, top: 0 })
  $effect(() => {
    if (!open) return
    const r = rect
    requestAnimationFrame(() => {
      const w = bar?.offsetWidth ?? 200
      const h = bar?.offsetHeight ?? 48
      pos = placeAnchored(r.left + r.width / 2, r.top, r.top + r.height, w, h)
    })
  })
</script>

{#if open}
  <div bind:this={bar} class="toolbar" style="left:{pos.left}px; top:{pos.top}px" role="toolbar">
    <button class="act" onclick={onHighlight}>
      <span class="swatch" style="--c:{HIGHLIGHT_HEX}"></span>
      Highlight
    </button>
    <span class="sep"></span>
    <button class="icon" aria-label="Copy" onclick={onCopy}><Icon name="copy" size={19} /></button>
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
  .act {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 40px;
    padding: 0 12px 0 10px;
    border-radius: 100px;
    font-size: 14px;
    font-weight: 600;
    color: var(--ink);
  }
  .act:active {
    background: var(--accent-soft);
  }
  .swatch {
    width: 18px;
    height: 18px;
    border-radius: 5px;
    background: var(--c);
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.16);
  }
  .sep {
    width: 1px;
    height: 24px;
    margin: 0 2px;
    background: var(--line-strong);
  }
  .icon {
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--ink-soft);
  }
  .icon:active {
    background: var(--accent-soft);
  }
</style>
