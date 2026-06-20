<script lang="ts">
  import { nav } from './stores/nav.svelte'
  import Shelf from './lib/library/Shelf.svelte'
  import Reader from './lib/reader/Reader.svelte'
  import UpdateToast from './lib/components/UpdateToast.svelte'
</script>

{#if nav.route.name === 'reader'}
  {#key nav.route.bookId}
    <Reader bookId={nav.route.bookId} />
  {/key}
{:else}
  <Shelf />
{/if}

<UpdateToast />
