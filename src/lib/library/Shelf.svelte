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
  import { catalog, loadCatalog, entryStatus, availableEntries, downloadBook, downloadAll } from '../../stores/catalog.svelte'
  import { bookUrl, type CatalogEntry } from '../../services/catalog'

  /** Whole KB below 1 MB: catalog sizes don't need a decimal. */
  function fmtSize(n: number): string {
    return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
  }

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

  onMount(() => {
    void refreshLibrary()
    void loadCatalog()
  })

  const books = $derived(library.books.filter((b) => !removing.has(b.id)))
  // A book in its Undo window still counts as present, so it can't be re-downloaded mid-delete.
  const available = $derived(library.loading ? [] : availableEntries())
  const availableBytes = $derived(available.reduce((n, e) => n + e.size, 0))
  let downloadingAll = $state(false)
  const anyDownloading = $derived(available.some((e) => entryStatus(e).kind === 'downloading'))

  async function getAll() {
    downloadingAll = true
    try {
      await downloadAll()
    } finally {
      downloadingAll = false
    }
  }

  /** "EN" alone when (nearly) fully translated, else with the share of text covered. */
  function enLabel(e: CatalogEntry): { text: string; title: string } | null {
    const c = e.translation?.coverage
    if (c == null) return null
    const pct = Math.round(c * 100)
    return c >= 0.995
      ? { text: 'EN', title: 'Includes an English translation' }
      : { text: `EN ${pct}%`, title: `English translation for ${pct}% of the text` }
  }

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
  {:else}
    {#if books.length === 0 && library.importing === 0}
      {#if available.length > 0}
        <!-- Compact, so the included books sit above the fold even on a landscape phone. -->
        <div class="intro">
          <h2>Your shelf is empty</h2>
          <p>
            Download one of the included books, or tap + to add an EPUB of your own. While reading, tap
            any Japanese word to look it up (get the offline dictionary in
            <button class="link" onclick={() => (settingsOpen = true)}>Settings</button>).
          </p>
        </div>
      {:else}
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
      {/if}
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

    {#if available.length > 0}
      <section class="bundled" class:first={books.length === 0 && library.importing === 0} aria-labelledby="bundled-h">
        <div class="section-head">
          <h2 id="bundled-h">Included books</h2>
          {#if available.length > 1}
            <button class="btn btn-tinted get-all" onclick={getAll} disabled={downloadingAll || anyDownloading}>
              <Icon name="download" size="sm" />
              {downloadingAll ? 'Downloading…' : `Download all · ${fmtSize(availableBytes)}`}
            </button>
          {/if}
        </div>
        <p class="section-hint">Japanese novels with English translations. Download to read offline.</p>
        <div class="grid">
          {#each available as entry (entry.id)}
            {@const st = entryStatus(entry)}
            {@const en = enLabel(entry)}
            {@const pct = st.kind === 'downloading' ? Math.round(st.progress * 100) : 0}
            <button
              class="card bundled-card"
              class:busy={st.kind === 'downloading'}
              aria-label={st.kind === 'downloading'
                ? `Downloading ${entry.title}, ${pct}%`
                : st.kind === 'error'
                  ? `${st.message} Retry download of ${entry.title}, ${fmtSize(entry.size)}`
                  : `${st.kind === 'update' ? 'Update' : 'Download'} ${entry.title}, ${fmtSize(entry.size)}`}
              aria-busy={st.kind === 'downloading'}
              onclick={() => {
                if (st.kind !== 'downloading') void downloadBook(entry.id)
              }}
            >
              <div class="cover-wrap">
                <BookCover
                  book={{ id: entry.id, title: entry.title, author: entry.author }}
                  src={entry.cover ? bookUrl(entry.cover) : undefined}
                />
                {#if en}<span class="badge" title={en.title}>{en.text}</span>{/if}
              </div>
              <div class="progress" aria-hidden="true">
                {#if st.kind === 'downloading'}<div class="progress-fill" style="width:{pct}%"></div>{/if}
              </div>
              <div class="meta">
                <div class="title" lang="ja">{entry.title}</div>
                {#if entry.author}<div class="sub-line"><span class="author" lang="ja">{entry.author}</span></div>{/if}
              </div>
              <span class="get" class:err={st.kind === 'error'} aria-hidden="true">
                {#if st.kind === 'downloading'}
                  <span class="spinner small"></span><span class="num">{pct}%</span>
                {:else}
                  <Icon name="download" size="sm" />
                  <span>{st.kind === 'error' ? 'Retry' : st.kind === 'update' ? 'Update' : fmtSize(entry.size)}</span>
                {/if}
              </span>
              <!-- Announced via the toast and the button's label; a button's children are presentational. -->
              {#if st.kind === 'error'}<span class="err-msg" aria-hidden="true">{st.message}</span>{/if}
            </button>
          {/each}
        </div>
      </section>
    {:else if catalog.error && books.length === 0}
      <p class="catalog-err">
        {catalog.error}
        <button class="link" onclick={() => void loadCatalog()}>Try again</button>
      </p>
    {/if}
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
    .state,
    .bundled,
    .intro,
    .catalog-err {
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

  .bundled {
    margin-top: var(--sp-8);
    padding-top: var(--sp-5);
    border-top: 1px solid var(--line);
  }
  .bundled.first {
    margin-top: var(--sp-2);
    padding-top: 0;
    border-top: 0;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--sp-2) var(--sp-4);
  }
  .section-head h2 {
    margin: 0;
    font-size: var(--fs-title);
    font-weight: 650;
  }
  .get-all {
    padding: 0 var(--sp-4);
    font-size: var(--fs-footnote);
    font-variant-numeric: tabular-nums;
  }
  .section-hint {
    margin: var(--sp-1) 0 var(--sp-5);
    font-size: var(--fs-footnote);
    color: var(--ink-faint);
  }
  .cover-wrap {
    position: relative;
  }
  .badge {
    position: absolute;
    top: var(--sp-2);
    inset-inline-end: var(--sp-2);
    padding: 2px 7px;
    border-radius: var(--r-full);
    font-size: var(--fs-caption);
    font-weight: 700;
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
    color: var(--ink);
    background: var(--glass-bg-strong);
    box-shadow: var(--glass-edge);
  }
  .get {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 0 var(--sp-3) 0 10px;
    border-radius: var(--r-full);
    font-size: var(--fs-footnote);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: var(--accent);
    background: var(--accent-soft);
    transition: background var(--dur-fast) var(--ease-out);
  }
  .bundled-card:active .get {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .get.err {
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 12%, transparent);
  }
  .get .num {
    min-width: 4ch;
  }
  .spinner.small {
    --spinner-size: 14px;
    border-width: 2px;
  }
  .busy {
    cursor: progress;
  }
  .busy .cover-wrap {
    opacity: 0.7;
  }
  .err-msg {
    font-size: var(--fs-caption);
    line-height: 1.35;
    color: var(--danger);
  }
  .catalog-err {
    margin: var(--sp-4) auto 0;
    text-align: center;
    font-size: var(--fs-footnote);
    color: var(--ink-faint);
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
  .intro {
    margin-bottom: var(--sp-6);
    padding: var(--sp-4) var(--sp-5);
    border-radius: var(--r-md);
    background: var(--paper-raised);
    box-shadow: var(--shadow-1);
  }
  .intro h2 {
    margin: 0 0 var(--sp-1);
    font-size: var(--fs-callout);
    font-weight: 650;
  }
  .intro p {
    margin: 0;
    max-width: 68ch;
    font-size: var(--fs-footnote);
    line-height: 1.5;
    color: var(--ink-soft);
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
