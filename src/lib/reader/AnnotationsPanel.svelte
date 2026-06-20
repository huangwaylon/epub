<script lang="ts">
  import { annotations, removeAnnotation } from '../../stores/annotations.svelte'
  import { HIGHLIGHT_HEX } from '../../services/types'
  import Icon from '../components/Icon.svelte'

  let { onnavigate }: { onnavigate: (cfi: string) => void } = $props()

  let tab = $state<'highlights' | 'bookmarks'>('highlights')

  const highlights = $derived(
    annotations.items.filter((a) => a.kind === 'highlight').sort((a, b) => b.createdAt - a.createdAt),
  )
  const bookmarks = $derived(
    annotations.items.filter((a) => a.kind === 'bookmark').sort((a, b) => b.createdAt - a.createdAt),
  )
  const list = $derived(tab === 'highlights' ? highlights : bookmarks)
</script>

<div class="tabs">
  <button class:active={tab === 'highlights'} onclick={() => (tab = 'highlights')}>
    Highlights <span class="count">{highlights.length}</span>
  </button>
  <button class:active={tab === 'bookmarks'} onclick={() => (tab = 'bookmarks')}>
    Bookmarks <span class="count">{bookmarks.length}</span>
  </button>
</div>

{#if list.length === 0}
  <p class="empty">
    {tab === 'highlights' ? 'Select text in the book to highlight it.' : 'Tap the bookmark icon to save your place.'}
  </p>
{:else}
  <ul>
    {#each list as a (a.id)}
      <li>
        <button class="row" onclick={() => onnavigate(a.cfi)}>
          {#if a.kind === 'highlight'}
            <span class="bar" style="background:{a.color ? HIGHLIGHT_HEX[a.color] : 'var(--accent)'}"></span>
          {:else}
            <span class="bm"><Icon name="bookmark" size={16} fill /></span>
          {/if}
          <span class="text" lang="ja">
            {a.text}
            {#if a.sectionLabel && a.kind === 'highlight'}<span class="sec">{a.sectionLabel}</span>{/if}
          </span>
        </button>
        <button class="del" aria-label="Delete" onclick={() => removeAnnotation(a.id)}>
          <Icon name="trash" size={18} />
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .tabs {
    display: flex;
    gap: 4px;
    padding: 2px;
    margin-bottom: 12px;
    border-radius: var(--r-md);
    background: var(--accent-soft);
  }
  .tabs button {
    flex: 1;
    padding: 8px;
    border-radius: calc(var(--r-md) - 2px);
    font-size: 14px;
    font-weight: 550;
    color: var(--ink-soft);
  }
  .tabs button.active {
    color: var(--ink);
    background: var(--paper-raised);
    box-shadow: var(--shadow-1);
  }
  .count {
    font-size: 12px;
    color: var(--ink-faint);
  }
  .empty {
    color: var(--ink-faint);
    text-align: center;
    padding: 28px 10px;
    font-size: 14px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0 0 10px;
  }
  li {
    display: flex;
    align-items: stretch;
    gap: 6px;
    border-bottom: 1px solid var(--line);
  }
  .row {
    flex: 1;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 13px 4px;
    text-align: start;
  }
  .bar {
    flex: none;
    width: 5px;
    align-self: stretch;
    border-radius: 3px;
  }
  .bm {
    flex: none;
    color: var(--accent);
    padding-top: 1px;
  }
  .text {
    font-size: 14px;
    line-height: 1.45;
    color: var(--ink);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .sec {
    display: block;
    font-size: 12px;
    color: var(--ink-faint);
    margin-top: 2px;
  }
  .del {
    flex: none;
    width: 44px;
    display: grid;
    place-items: center;
    color: var(--ink-faint);
  }
  .del:active {
    color: #c0392b;
  }
</style>
