<script lang="ts">
  import type { TocItem } from '../../services/reader'

  let {
    toc,
    currentId,
    currentLabel,
    onnavigate,
  }: {
    toc: TocItem[]
    /** foliate's TOC item id for the current position (`relocate.tocItem`). */
    currentId?: number
    /** Fallback match when the TOC carries no ids. */
    currentLabel?: string
    onnavigate: (href: string) => void
  } = $props()

  type Row = { key: string | number; id?: number; label: string; href?: string; depth: number }
  function flatten(items: TocItem[], depth = 0, path = ''): Row[] {
    const out: Row[] = []
    items.forEach((it, i) => {
      // Key on foliate's unique id: labels and hrefs repeat (e.g. two "挿絵" entries).
      const pos = `${path}${i}`
      out.push({ key: it.id ?? `p${pos}`, id: it.id, label: it.label?.trim() || '—', href: it.href, depth })
      if (it.subitems?.length) out.push(...flatten(it.subitems, depth + 1, `${pos}.`))
    })
    return out
  }
  const items = $derived(flatten(toc ?? []))
  const isCurrent = (r: Row) => (currentId !== undefined && r.id !== undefined ? r.id === currentId : r.label === currentLabel)

  // Mounted per open: scroll the current chapter into view.
  let navEl = $state<HTMLElement>()
  $effect(() => {
    const el = navEl?.querySelector<HTMLElement>('[aria-current="location"]')
    el?.scrollIntoView({ block: 'center' })
  })
</script>

{#if items.length === 0}
  <p class="empty">This book has no table of contents.</p>
{:else}
  <nav bind:this={navEl} aria-label="Table of contents">
    {#each items as item (item.key)}
      <button
        class="toc-row"
        class:current={isCurrent(item)}
        aria-current={isCurrent(item) ? 'location' : undefined}
        style="padding-inline-start:{4 + item.depth * 16}px"
        onclick={() => item.href && onnavigate(item.href)}
        disabled={!item.href}
      >
        <span lang="ja">{item.label}</span>
      </button>
    {/each}
  </nav>
{/if}

<style>
  nav {
    display: flex;
    flex-direction: column;
    padding-bottom: var(--sp-3);
  }
  .toc-row {
    min-height: var(--control-h);
    display: flex;
    align-items: center;
    text-align: start;
    padding: var(--sp-3) var(--sp-1);
    font-size: var(--fs-body);
    line-height: 1.4;
    color: var(--ink);
    border-bottom: 1px solid var(--line);
  }
  .toc-row:last-child {
    border-bottom: 0;
  }
  .toc-row:active {
    background: var(--control-track);
  }
  .toc-row.current {
    color: var(--accent);
    font-weight: 650;
  }
  .toc-row:disabled {
    color: var(--ink-faint);
  }
  .empty {
    color: var(--ink-faint);
    text-align: center;
    padding: var(--sp-8) 0;
  }
</style>
