<script lang="ts">
  import { onMount } from 'svelte'
  import type { BookMeta } from '../../services/types'
  import { library, refreshLibrary, importFiles, deleteBook, markOpened } from '../../stores/library.svelte'
  import { openReader } from '../../stores/nav.svelte'
  import { longpress } from '../actions/longpress'
  import Icon from '../components/Icon.svelte'
  import Sheet from '../components/Sheet.svelte'
  import BookCover from './BookCover.svelte'

  let fileInput: HTMLInputElement
  let menuFor = $state<BookMeta | null>(null)
  let settingsOpen = $state(false)

  // Lazy-load the settings sheet: it pulls in the dictionary download code
  // (jpdict-idb), which the shelf never needs at startup. Fetch it the first time the
  // user opens Settings so jpdict-idb stays out of the cold-start chunk.
  let SettingsComp = $state<typeof import('./ShelfSettings.svelte').default | null>(null)
  $effect(() => {
    if (settingsOpen && !SettingsComp) {
      void import('./ShelfSettings.svelte').then((m) => {
        SettingsComp = m.default
      })
    }
  })

  onMount(refreshLibrary)

  function pick(e: Event) {
    const input = e.target as HTMLInputElement
    if (input.files?.length) importFiles(input.files)
    input.value = ''
  }

  async function open(b: BookMeta) {
    await markOpened(b.id)
    openReader(b.id)
  }

  async function confirmDelete(b: BookMeta) {
    menuFor = null
    await deleteBook(b.id)
  }

  function percent(id: string): number {
    return Math.round((library.progress[id]?.fraction ?? 0) * 100)
  }
</script>

<div class="shelf">
  <header class="bar">
    <h1>蔵書<span class="sub">Library</span></h1>
    <div class="actions">
      <button class="icon-btn" onclick={() => (settingsOpen = true)} aria-label="Settings">
        <Icon name="gear" size={22} />
      </button>
      <button class="icon-btn primary" onclick={() => fileInput.click()} aria-label="Import book">
        <Icon name="plus" size={22} />
      </button>
    </div>
  </header>

  {#if library.importing > 0}
    <div class="importing">Importing {library.importing} book{library.importing > 1 ? 's' : ''}…</div>
  {/if}
  {#if library.importError}
    <div class="import-error" role="alert">
      <span>{library.importError}</span>
      <button class="dismiss-err" onclick={() => (library.importError = null)} aria-label="Dismiss">
        <Icon name="x" size={16} />
      </button>
    </div>
  {/if}

  {#if library.loading}
    <div class="state"><div class="spinner"></div></div>
  {:else if library.books.length === 0}
    <div class="state empty">
      <div class="empty-art"><Icon name="book" size={46} stroke={1.4} /></div>
      <h2>Your shelf is empty</h2>
      <p>Add an EPUB from Files, iCloud Drive, or anywhere on your device.</p>
      <button class="cta" onclick={() => fileInput.click()}>
        <Icon name="plus" size={18} /> Add a book
      </button>
    </div>
  {:else}
    <div class="grid">
      {#each library.books as book (book.id)}
        {@const p = percent(book.id)}
        <button
          class="card"
          onclick={() => open(book)}
          use:longpress={{ onlongpress: () => (menuFor = book) }}
          oncontextmenu={(e) => {
            e.preventDefault()
            menuFor = book
          }}
        >
          <div class="cover-wrap">
            <BookCover {book} />
            {#if p > 0}
              <div class="ring" style="--p:{p}">
                <span>{p}%</span>
              </div>
            {/if}
          </div>
          <div class="meta">
            <div class="title" lang="ja">{book.title}</div>
            {#if book.author}<div class="author" lang="ja">{book.author}</div>{/if}
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

<!-- Per-book action sheet (long-press) -->
<Sheet open={menuFor !== null} title={menuFor?.title} onclose={() => (menuFor = null)}>
  {#if menuFor}
    {@const b = menuFor}
    <div class="menu">
      <button class="row" onclick={() => open(b)}>
        <Icon name="book" size={20} /> <span>Read</span>
      </button>
      <button class="row danger" onclick={() => confirmDelete(b)}>
        <Icon name="trash" size={20} /> <span>Remove from library</span>
      </button>
    </div>
  {/if}
</Sheet>

<!-- App settings -->
<Sheet bind:open={settingsOpen} title="Settings">
  {#if SettingsComp}
    <SettingsComp />
  {/if}
</Sheet>

<style>
  .shelf {
    height: 100%;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: calc(var(--safe-top) + 8px) calc(var(--safe-right) + 18px)
      calc(var(--safe-bottom) + 28px) calc(var(--safe-left) + 18px);
  }
  .bar {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    padding: 8px 2px 20px;
  }
  h1 {
    margin: 0;
    font-family: var(--font-serif);
    font-size: 30px;
    font-weight: 650;
    letter-spacing: 0.02em;
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .sub {
    font-family: var(--font-ui);
    font-size: 13px;
    font-weight: 500;
    color: var(--ink-faint);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .actions {
    display: flex;
    gap: 10px;
  }
  .icon-btn {
    width: 42px;
    height: 42px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--ink-soft);
    background: var(--paper-raised);
    box-shadow: var(--shadow-1);
  }
  .icon-btn.primary {
    color: #fff;
    background: var(--accent);
  }
  .importing {
    font-size: 13px;
    color: var(--ink-soft);
    padding: 0 2px 14px;
  }
  .import-error {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
    padding: 10px 10px 10px 14px;
    border-radius: var(--r-md);
    font-size: 13px;
    color: #c0392b;
    background: color-mix(in srgb, #c0392b 10%, var(--paper-raised));
    border: 1px solid color-mix(in srgb, #c0392b 28%, transparent);
  }
  :global([data-theme='dark']) .import-error {
    color: #ff8a7d;
  }
  .import-error span {
    flex: 1;
  }
  .dismiss-err {
    flex: none;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: inherit;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
    gap: 22px 16px;
  }
  @media (min-width: 768px) {
    .shelf {
      padding-left: calc(var(--safe-left) + 40px);
      padding-right: calc(var(--safe-right) + 40px);
    }
    /* Centre the shelf content on wide (iPad) screens with larger covers. */
    .bar,
    .grid,
    .importing,
    .import-error,
    .state {
      max-width: 1120px;
      margin-inline: auto;
    }
    .grid {
      grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
      gap: 38px 28px;
    }
    h1 {
      font-size: 36px;
    }
    .bar {
      padding-top: 16px;
      padding-bottom: 28px;
    }
  }
  .card {
    text-align: start;
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .card:active {
    transform: scale(0.97);
    transition: transform 0.1s;
  }
  .cover-wrap {
    position: relative;
  }
  .ring {
    position: absolute;
    right: 6px;
    bottom: 6px;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 9px;
    font-weight: 700;
    color: var(--ink);
    background:
      radial-gradient(closest-side, var(--paper-raised) 76%, transparent 77%),
      conic-gradient(var(--accent) calc(var(--p) * 1%), var(--line-strong) 0);
    box-shadow: var(--shadow-1);
  }
  .meta {
    padding: 0 2px;
  }
  .title {
    font-family: var(--font-serif);
    font-size: 14px;
    font-weight: 600;
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .author {
    margin-top: 2px;
    font-size: 12px;
    color: var(--ink-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .state {
    display: grid;
    place-items: center;
    min-height: 60dvh;
  }
  .empty {
    text-align: center;
    gap: 6px;
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
    margin-bottom: 14px;
  }
  .empty h2 {
    margin: 0;
    font-size: 19px;
    color: var(--ink);
  }
  .empty p {
    margin: 0;
    max-width: 26ch;
    font-size: 14px;
  }
  .cta {
    margin-top: 18px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 11px 20px;
    border-radius: var(--r-lg);
    font-weight: 600;
    color: #fff;
    background: var(--accent);
    box-shadow: var(--shadow-1);
  }
  .spinner {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 3px solid var(--line-strong);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .menu {
    padding-bottom: 8px;
  }
  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 15px 6px;
    font-size: 16px;
    border-bottom: 1px solid var(--line);
  }
  .row:last-child {
    border-bottom: 0;
  }
  .row.danger {
    color: #c0392b;
  }
  :global([data-theme='dark']) .row.danger {
    color: #ff6b5b;
  }
</style>
