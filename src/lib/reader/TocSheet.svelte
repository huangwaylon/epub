<script lang="ts">
  interface TocItem {
    label?: string
    href?: string
    subitems?: TocItem[]
  }
  let {
    toc,
    currentLabel,
    onnavigate,
  }: { toc: TocItem[]; currentLabel?: string; onnavigate: (href: string) => void } = $props()

  function flatten(items: TocItem[], depth = 0): { label: string; href?: string; depth: number }[] {
    const out: { label: string; href?: string; depth: number }[] = []
    for (const it of items) {
      out.push({ label: it.label?.trim() || '—', href: it.href, depth })
      if (it.subitems?.length) out.push(...flatten(it.subitems, depth + 1))
    }
    return out
  }
  const items = $derived(flatten(toc ?? []))
</script>

{#if items.length === 0}
  <p class="empty">This book has no table of contents.</p>
{:else}
  <nav>
    {#each items as item (item.label + (item.href ?? ''))}
      <button
        class="toc-row"
        class:current={item.label === currentLabel}
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
