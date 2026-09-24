<script lang="ts" module>
  import { SvelteSet } from 'svelte/reactivity'
  // Books in their Undo window; module-level so it survives the Shelf unmounting.
  const removing = new SvelteSet<string>()
</script>

<script lang="ts">
  import { onMount } from 'svelte'
  import type { BookMeta } from '../../services/types'
  import { library, refreshLibrary, importFiles, deleteBook, markOpened } from '../../stores/library.svelte'
  import { openReader, warmReader } from '../../stores/nav.svelte'
  import { showToast } from '../../stores/toast.svelte'
  import { longpress } from '../actions/longpress'
  import Icon from '../components/Icon.svelte'
  import Sheet from '../components/Sheet.svelte'
  import BookCover from './BookCover.svelte'

  let fileInput: HTMLInputElement
  let menuFor = $state<BookMeta | null>(null)
  let settingsOpen = $state(false)

  // Lazy: ShelfSettings pulls in jpdict-idb, which stays out of the cold-start chunk.
  let SettingsComp = $state<typeof import('./ShelfSettings.svelte').default | null>(null)
  $effect(() => {
    if (settingsOpen && !SettingsComp) {
      void import('./ShelfSettings.svelte').then((m) => {
        SettingsComp = m.default
      })
    }
  })

  onMount(refreshLibrary)

  const books = $derived(library.books.filter((b) => !removing.has(b.id)))

  function pick(e: Event) {
    const input = e.target as HTMLInputElement
    if (input.files?.length) importFiles(input.files)
    input.value = ''
  }

  function open(b: BookMeta) {
    menuFor = null
    openReader(b.id)
    void markOpened(b.id).catch(() => {})
  }

  /** Hidden at once; the real delete runs when the Undo toast expires. */
  function remove(b: BookMeta) {
    menuFor = null
    removing.add(b.id)
    showToast({
      message: 'Book removed',
      action: { label: 'Undo', run: () => removing.delete(b.id) },
      onexpire: () => {
        void deleteBook(b.id)
          .catch((err) => console.warn('Could not remove book', err))
          .finally(() => removing.delete(b.id))
      },
    })
  }

  /** null = never opened ("New"). */
  function percent(id: string): number | null {
    const p = library.progress[id]
    return p ? Math.round((p.fraction ?? 0) * 100) : null
  }
</script>

<div class="shelf">
  <header class="bar">
    <h1>蔵書<span class="sub">Library</span></h1>
    <div class="actions">
      <button class="icon-btn raised" onclick={() => (settingsOpen = true)} aria-label="Settings">
        <Icon name="gear" />
      </button>
      <button class="icon-btn btn-primary" onclick={() => fileInput.click()} aria-label="Import book">
        <Icon name="plus" />
      </button>
    </div>
  </header>

  {#if library.importError}
    <div class="import-error" role="alert">
      <span>{library.importError}</span>
      <button class="icon-btn dismiss-err" onclick={() => (library.importError = null)} aria-label="Dismiss">
        <Icon name="x" size="sm" />
      </button>
    </div>
  {/if}

  {#if library.loading}
    <div class="state"><div class="spinner delayed"></div></div>
  {:else if books.length === 0 && library.importing === 0}
    <div class="state empty">
      <div class="empty-art"><Icon name="book" size="lg" stroke={1.4} /></div>
      <h2>Your shelf is empty</h2>
      <p>Add an EPUB from Files, iCloud Drive, or anywhere on your device.</p>
      <button class="btn btn-primary cta" onclick={() => fileInput.click()}>
        <Icon name="plus" size="sm" /> Add a book
      </button>
      <p class="hint">
        Tip: tap any Japanese word while reading to look it up. Get the offline dictionary in
        <button class="link" onclick={() => (settingsOpen = true)}>Settings</button>.
      </p>
    </div>
  {:else}
    <div class="grid" aria-busy={library.importing > 0}>
      {#each { length: library.importing } as _, i (i)}
        <div class="card skeleton-card" aria-hidden="true">
          <div class="skeleton cover-skel"></div>
          <div class="meta">
            <div class="skeleton line"></div>
            <div class="skeleton line short"></div>
          </div>
        </div>
      {/each}
      {#each books as book (book.id)}
        {@const p = percent(book.id)}
        <button
          class="card"
          onclick={() => open(book)}
          onpointerdown={warmReader}
          use:longpress={{ onlongpress: () => (menuFor = book) }}
          oncontextmenu={(e) => {
            e.preventDefault()
            menuFor = book
          }}
        >
          <div class="cover-wrap">
            <BookCover {book} />
          </div>
          <div class="progress" aria-hidden="true">
            {#if p !== null && p > 0}<div class="progress-fill" style="width:{p}%"></div>{/if}
          </div>
          <div class="meta">
            <div class="title" lang="ja">{book.title}</div>
            <div class="sub-line">
              {#if book.author}<span class="author" lang="ja">{book.author}</span>{/if}
              <span class="pct" class:new={p === null}>{p === null ? 'New' : p >= 100 ? 'Finished' : `${p}%`}</span>
            </div>
          </div>
        </button>
      {/each}
    </div>
  {/if}
</div>

<input
  bind:this={fileInput}
  type="file"
  accept=".epub,application/epub+zip"
  multiple
  hidden
  onchange={pick}
/>

<Sheet open={menuFor !== null} title={menuFor?.title} onclose={() => (menuFor = null)}>
  {#if menuFor}
    {@const b = menuFor}
    <div class="menu">
      <button class="row" onclick={() => open(b)}>
        <Icon name="book" /> <span>Read</span>
      </button>
      <button class="row danger" onclick={() => remove(b)}>
        <Icon name="trash" /> <span>Remove from library</span>
      </button>
    </div>
  {/if}
</Sheet>

<Sheet bind:open={settingsOpen} title="Settings">
  {#if SettingsComp}
    <SettingsComp />
  {:else}
    <div class="state small"><div class="spinner delayed"></div></div>
  {/if}
</Sheet>

<style>
  .shelf {
    height: 100%;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: calc(var(--safe-top) + var(--sp-2)) calc(var(--safe-right) + var(--sp-5))
      calc(var(--safe-bottom) + var(--sp-7)) calc(var(--safe-left) + var(--sp-5));
  }
  .bar {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    padding: var(--sp-2) 0 var(--sp-5);
  }
  h1 {
    margin: 0;
    font-family: var(--font-serif);
    font-size: var(--fs-display);
    font-weight: 650;
    letter-spacing: 0.02em;
    display: flex;
    align-items: baseline;
    gap: var(--sp-3);
  }
  .sub {
    font-family: var(--font-ui);
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--ink-faint);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .actions {
    display: flex;
    gap: var(--sp-3);
  }
  .raised {
    background: var(--paper-raised);
    box-shadow: var(--shadow-1);
  }
  .import-error {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin-bottom: var(--sp-4);
    padding: var(--sp-1) var(--sp-1) var(--sp-1) var(--sp-4);
    border-radius: var(--r-md);
    font-size: var(--fs-footnote);
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, var(--paper-raised));
    border: 1px solid color-mix(in srgb, var(--danger) 28%, transparent);
  }
  .import-error span {
    flex: 1;
  }
  .dismiss-err {
    color: inherit;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
    gap: var(--sp-6) var(--sp-4);
  }
  @media (min-width: 768px) {
    .shelf {
      padding-left: calc(var(--safe-left) + var(--sp-10));
      padding-right: calc(var(--safe-right) + var(--sp-10));
    }
    .bar,
    .grid,
    .import-error,
    .state {
      max-width: 1120px;
      margin-inline: auto;
    }
    .grid {
      grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
      gap: var(--sp-10) var(--sp-7);
    }
    .bar {
      padding-top: var(--sp-4);
      padding-bottom: var(--sp-7);
    }
  }
  .card {
    text-align: start;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    /* Skip off-screen cards; the padding/negative margin keeps the paint-contained shadow. */
    content-visibility: auto;
    contain-intrinsic-size: auto 150px auto 280px;
    padding: var(--sp-3);
    margin: calc(-1 * var(--sp-3));
  }
  .cover-wrap {
    transition: transform var(--dur-fast) var(--ease-out);
  }
  .card:active .cover-wrap {
    transform: scale(var(--press-scale));
    transition-duration: var(--dur-instant);
  }
  .progress {
    height: 3px;
    border-radius: var(--r-full);
    background: var(--line);
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .title {
    font-family: var(--font-serif);
    font-size: var(--fs-body);
    font-weight: 600;
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .sub-line {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    font-size: var(--fs-caption);
    color: var(--ink-faint);
  }
  .author {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pct {
    flex: none;
    margin-inline-start: auto;
    font-variant-numeric: tabular-nums;
  }
  .pct.new {
    color: var(--accent);
    font-weight: 600;
  }

  .skeleton-card {
    pointer-events: none;
  }
  .cover-skel {
    aspect-ratio: 2 / 3;
    border-radius: var(--r-sm);
  }
  .line {
    height: 12px;
    margin-top: var(--sp-1);
  }
  .line.short {
    width: 55%;
  }

  .state {
    display: grid;
    place-items: center;
    min-height: 60dvh;
  }
  .state.small {
    min-height: 160px;
  }
  .empty {
    align-content: center;
    gap: var(--sp-2);
    text-align: center;
    color: var(--ink-soft);
  }
  .empty-art {
    width: 96px;
    height: 96px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--accent);
    background: var(--accent-soft);
    margin-bottom: var(--sp-3);
  }
  .empty h2 {
    margin: 0;
    font-size: var(--fs-title);
    font-weight: 650;
    color: var(--ink);
  }
  .empty p {
    margin: 0;
    max-width: 30ch;
    font-size: var(--fs-body);
    line-height: 1.45;
  }
  .cta {
    margin-top: var(--sp-4);
  }
  .empty .hint {
    margin-top: var(--sp-6);
    max-width: 36ch;
    font-size: var(--fs-footnote);
    color: var(--ink-faint);
  }
  .link {
    padding: 0;
    color: var(--accent);
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 2px;
    /* 44pt target */
    position: relative;
  }
  .link::after {
    content: '';
    position: absolute;
    inset: -12px -6px;
  }

  .menu {
    padding-bottom: var(--sp-2);
  }
  .row {
    width: 100%;
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    padding: 0 var(--sp-1);
    font-size: var(--fs-callout);
    border-bottom: 1px solid var(--line);
  }
  .row:last-child {
    border-bottom: 0;
  }
  .row.danger {
    color: var(--danger);
  }
</style>
