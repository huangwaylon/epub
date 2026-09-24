<script lang="ts">
  import { onMount } from 'svelte'
  import { nav, openShelf, loadReader, warmReader, rememberRouteForReload } from './stores/nav.svelte'
  import Shelf from './lib/library/Shelf.svelte'
  import ToastHost from './lib/components/ToastHost.svelte'
  import LoadingScreen from './lib/components/LoadingScreen.svelte'
  import { library } from './stores/library.svelte'

  // Lazy chunk so the Shelf cold-starts without foliate; warmed after mount and on cover press.
  const readerPromise = $derived(nav.route.name === 'reader' ? loadReader() : null)

  const pendingTitle = $derived(
    nav.route.name === 'reader' ? library.books.find((b) => b.id === (nav.route as { bookId: string }).bookId)?.title : undefined,
  )

  onMount(() => {
    const warm = () =>
      'requestIdleCallback' in window ? requestIdleCallback(warmReader, { timeout: 2000 }) : warmReader()
    const t = setTimeout(warm, 1500)
    return () => clearTimeout(t)
  })
</script>

{#if nav.route.name === 'reader'}
  {#key nav.route.bookId}
    {#await readerPromise}
      <LoadingScreen title={pendingTitle} />
    {:then Reader}
      {#if Reader}<Reader bookId={nav.route.bookId} />{/if}
    {:catch}
      <div class="chunk-state" role="alert">
        <p>Couldn’t load the reader. Check your connection and try again.</p>
        <div class="actions">
          <!-- Full reload: WebKit can replay a failed module fetch, and a stale post-deploy
               chunk name only resolves with fresh HTML. -->
          <button
            class="btn btn-primary"
            onclick={() => {
              rememberRouteForReload()
              location.reload()
            }}>Try again</button
          >
          <button class="btn" onclick={openShelf}>Back to library</button>
        </div>
      </div>
    {/await}
  {/key}
{:else}
  <Shelf />
{/if}

<ToastHost />

<style>
  .chunk-state {
    position: fixed;
    inset: 0;
    height: var(--app-height, 100dvh);
    display: grid;
    place-content: center;
    justify-items: center;
    gap: var(--sp-4);
    padding: var(--sp-6);
    text-align: center;
    background: var(--paper);
    color: var(--ink-soft);
  }
  .chunk-state p {
    margin: 0;
    max-width: 30ch;
  }
  .actions {
    display: flex;
    gap: var(--sp-3);
  }
</style>
