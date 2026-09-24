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
  // Measured and placed synchronously in the flush that mounts it (before paint), so the
  // toolbar never shows a first frame at 0,0 (mirrors DictionaryPopup).
  let pos = $state<{ left: number; top: number } | null>(null)
  $effect(() => {
    if (!open) {
      pos = null
      return
    }
    if (!bar) return
    const r = rect
    pos = placeAnchored(r.left + r.width / 2, r.top, r.top + r.height, bar.offsetWidth, bar.offsetHeight)
  })
</script>

{#if open}
  <div bind:this={bar} class="toolbar glass" style="left:{pos?.left ?? 0}px; top:{pos?.top ?? 0}px;{pos ? '' : ' visibility:hidden'}" role="toolbar">
    <button class="act" onclick={onHighlight}>
      <span class="swatch" style="--c:{HIGHLIGHT_HEX}"></span>
      Highlight
    </button>
    <span class="sep"></span>
    <button class="icon-btn" aria-label="Copy" onclick={onCopy}><Icon name="copy" size="sm" /></button>
  </div>
{/if}

<style>
  .toolbar {
    position: fixed;
    z-index: var(--z-toolbar);
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border-radius: var(--r-full);
    background: var(--glass-bg-strong);
    animation: pop var(--dur-fast) var(--ease-out);
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
    gap: var(--sp-2);
    height: var(--control-h);
    padding: 0 var(--sp-4) 0 var(--sp-3);
    border-radius: var(--r-full);
    font-size: var(--fs-body);
    font-weight: 600;
    color: var(--ink);
  }
  .act:active {
    background: var(--control-track);
  }
  .swatch {
    width: var(--icon-sm);
    height: var(--icon-sm);
    border-radius: var(--r-xs);
    background: var(--c);
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.16);
  }
  .sep {
    width: 1px;
    height: 24px;
    background: var(--line-strong);
  }
</style>
