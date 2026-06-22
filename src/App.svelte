<script lang="ts">
  import { nav, openShelf } from './stores/nav.svelte'
  import Shelf from './lib/library/Shelf.svelte'
  import UpdateToast from './lib/components/UpdateToast.svelte'

  // Lazily load the reader (foliate-js + the reader controller + the dictionary
  // download glue) so the Shelf cold-starts without any of it. The chunk is fetched
  // the first time a book is opened; the heavy kuromoji/JMdict engine is split a step
  // further into its own worker, loaded only on first tap-to-define.
  const ReaderPromise = import('./lib/reader/Reader.svelte').then((m) => m.default)
</script>

{#if nav.route.name === 'reader'}
  {#key nav.route.bookId}
    {#await ReaderPromise then Reader}
      <Reader bookId={nav.route.bookId} />
    {:catch}
      <!-- The reader chunk failed to load — possible offline before the SW cached it,
           or a stale hashed-chunk reference after a deploy. Don't trap the user on a
           blank screen; offer a way back to the shelf. -->
      <div class="chunk-error">
        <p>Couldn’t load the reader. Check your connection and try again.</p>
        <button onclick={openShelf}>← Back to library</button>
      </div>
    {/await}
  {/key}
{:else}
  <Shelf />
{/if}

<UpdateToast />

<style>
  .chunk-error {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    gap: 16px;
    padding: 24px;
    text-align: center;
    background: var(--paper);
    color: var(--ink-soft);
  }
  .chunk-error button {
    color: var(--accent);
    font-weight: 600;
  }
</style>
