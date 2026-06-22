<script lang="ts">
  import { nav } from './stores/nav.svelte'
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
    {/await}
  {/key}
{:else}
  <Shelf />
{/if}

<UpdateToast />
