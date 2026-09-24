<script lang="ts">
  import type { TocItem } from '../../services/reader'

  let {
    toc,
    currentId,
    currentLabel,
    onnavigate,
  }: {
    toc: TocItem[]
    /** foliate's unique TOC item id for the current position (from `relocate.tocItem`). */
    currentId?: number
    /** Fallback match when the TOC carries no ids. */
    currentLabel?: string
    onnavigate: (href: string) => void
  } = $props()

  type Row = { key: string | number; id?: number; label: string; href?: string; depth: number }
  function flatten(items: TocItem[], depth = 0, path = ''): Row[] {
    const out: Row[] = []
    items.forEach((it, i) => {
      // foliate assigns every TOC item a unique numeric `id`; key on it (labels and
      // hrefs repeat — e.g. two "挿絵" entries — which made the old label+href key collide).
      const pos = `${path}${i}`
      out.push({ key: it.id ?? `p${pos}`, id: it.id, label: it.label?.trim() || '—', href: it.href, depth })
      if (it.subitems?.length) out.push(...flatten(it.subitems, depth + 1, `${pos}.`))
    })
    return out
  }
  const items = $derived(flatten(toc ?? []))
  const isCurrent = (r: Row) => (currentId !== undefined && r.id !== undefined ? r.id === currentId : r.label === currentLabel)

  // The sheet mounts this list each time it opens: bring the current chapter into view so a
  // long TOC doesn't open scrolled to the top, far from where the reader is.
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
        style="padding-inline-start:{14 + item.depth * 16}px"
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
    padding-bottom: 10px;
  }
  .toc-row {
    text-align: start;
    padding: 13px 6px;
    font-size: 15px;
    line-height: 1.4;
    color: var(--ink);
    border-bottom: 1px solid var(--line);
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
    padding: 30px 0;
  }
</style>
