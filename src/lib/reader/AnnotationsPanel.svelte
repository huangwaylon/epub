<script lang="ts">
  import { annotations } from '../../stores/annotations.svelte'
  import { HIGHLIGHT_HEX, type Annotation } from '../../services/types'
  import Icon from '../components/Icon.svelte'
  import Segmented from '../components/Segmented.svelte'
  // `onremove` is owned by the reader: deleting a highlight must also unpaint its overlay
  // (which only the reader controller can do), not just drop the stored record.
  let {
    onnavigate,
    onremove,
    chapterOrder = [],
  }: {
    onnavigate: (cfi: string) => void
    onremove: (a: Annotation) => void
    /** TOC labels in reading order — highlight groups follow the book, not the clock. */
    chapterOrder?: string[]
  } = $props()

  let tab = $state<'highlights' | 'bookmarks'>('highlights')

  // Newest first, with a stable id tiebreaker so items sharing a createdAt ms
  // (rapid/batch highlights) keep a deterministic order across re-renders.
  const newestFirst = (a: Annotation, b: Annotation) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)
  const highlights = $derived(annotations.items.filter((a) => a.kind === 'highlight').sort(newestFirst))
  const bookmarks = $derived(annotations.items.filter((a) => a.kind === 'bookmark').sort(newestFirst))

  /** Highlights grouped by chapter, chapters in reading order (unknown ones last). */
  const groups = $derived.by(() => {
    const rank = new Map<string, number>()
    chapterOrder.forEach((l, i) => rank.has(l) || rank.set(l, i))
    const by = new Map<string, Annotation[]>()
    for (const a of highlights) {
      const k = a.sectionLabel?.trim() || ''
      const g = by.get(k)
      if (g) g.push(a)
      else by.set(k, [a])
    }
    return [...by.entries()]
      .map(([label, items]) => ({ label, items }))
      .sort((a, b) => (rank.get(a.label) ?? 1e9) - (rank.get(b.label) ?? 1e9))
  })

  /** A single looked-up word (vs. a drag-selected passage) renders as a headword. */
  const isWord = (t: string) => t.length <= 12 && !/\s/.test(t)
</script>

<div class="panel">
  <Segmented
    label="Show"
    bind:value={tab}
    options={[
      { value: 'highlights', label: 'Highlights', count: highlights.length },
      { value: 'bookmarks', label: 'Bookmarks', count: bookmarks.length },
    ]}
  />

  <div class="list">
    {#if tab === 'highlights'}
      {#if highlights.length === 0}
        <div class="empty">
          <span class="empty-icon"><Icon name="highlighter" stroke={1.6} /></span>
          <p>Tap a word to look it up — it’s highlighted here as you read.</p>
        </div>
      {:else}
        {#each groups as g (g.label)}
          <section>
            {#if g.label}<h4 lang="ja">{g.label}</h4>{/if}
            <ul>
              {#each g.items as a (a.id)}
                <li>
                  <button class="row" onclick={() => onnavigate(a.cfi)}>
                    <span class="mark" style="--hl:{HIGHLIGHT_HEX}"></span>
                    <span class="text" class:word={isWord(a.text)} lang="ja">{a.text}</span>
                  </button>
                  <button class="icon-btn del" aria-label="Delete highlight" onclick={() => onremove(a)}>
                    <Icon name="trash" size="sm" />
                  </button>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      {/if}
    {:else if bookmarks.length === 0}
      <div class="empty">
        <span class="empty-icon"><Icon name="bookmark" stroke={1.6} /></span>
        <p>Tap the bookmark button to save your place.</p>
      </div>
    {:else}
      <ul>
        {#each bookmarks as a (a.id)}
          <li>
            <button class="row" onclick={() => onnavigate(a.cfi)}>
              <span class="bm"><Icon name="bookmark" size="sm" fill /></span>
              <span class="text" lang="ja">{a.text}</span>
            </button>
            <button class="icon-btn del" aria-label="Delete bookmark" onclick={() => onremove(a)}>
              <Icon name="trash" size="sm" />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }
  /* Stable height across tabs, so switching doesn't make the sheet jump. */
  .list {
    min-height: min(360px, 50dvh);
    padding-bottom: var(--sp-3);
  }
  section + section {
    margin-top: var(--sp-4);
  }
  h4 {
    margin: 0;
    padding: var(--sp-2) var(--sp-1) var(--sp-1);
    font-size: var(--fs-footnote);
    font-weight: 600;
    color: var(--ink-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    border-bottom: 1px solid var(--line);
  }
  li:last-child {
    border-bottom: 0;
  }
  .row {
    flex: 1;
    min-width: 0;
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-1);
    text-align: start;
  }
  .mark {
    flex: none;
    width: 4px;
    align-self: stretch;
    border-radius: var(--r-full);
    background: var(--hl);
  }
  .bm {
    flex: none;
    display: grid;
    color: var(--accent);
  }
  .text {
    font-size: var(--fs-body);
    line-height: 1.5;
    color: var(--ink);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .text.word {
    font-family: var(--font-serif);
    font-size: var(--fs-title);
    font-weight: 600;
    line-height: 1.3;
  }
  .del {
    color: var(--ink-faint);
  }
  .del:active {
    color: var(--danger);
  }
  .empty {
    display: grid;
    justify-items: center;
    gap: var(--sp-3);
    padding: var(--sp-10) var(--sp-4);
    text-align: center;
    color: var(--ink-faint);
  }
  .empty-icon {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    color: var(--accent);
    background: var(--accent-soft);
  }
  .empty p {
    margin: 0;
    max-width: 30ch;
    font-size: var(--fs-body);
    line-height: 1.45;
    color: var(--ink-soft);
  }
</style>
