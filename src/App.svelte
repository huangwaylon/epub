<script lang="ts">
  import { onMount } from 'svelte'
  import { nav, openShelf, loadReader, warmReader, rememberRouteForReload } from './stores/nav.svelte'
  import Shelf from './lib/library/Shelf.svelte'
  import ToastHost from './lib/components/ToastHost.svelte'
  import LoadingScreen from './lib/components/LoadingScreen.svelte'
  import { library } from './stores/library.svelte'

  // The reader (foliate-js + the reader controller + the dictionary download glue) is
  // a lazy chunk so the Shelf cold-starts without any of it. It's fetched on first open
  // — or earlier: warmed once the shelf has settled, and on pointerdown on a cover — and
  // the heavy kuromoji/JMdict engine is split a step further into its own worker.
  const readerPromise = $derived(nav.route.name === 'reader' ? loadReader() : null)

  // The shelf already knows the title, so the pending screen matches the reader's own.
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
      <!-- Calm paper screen while the chunk arrives (usually already warm) — it only
           fades in if it's actually slow, so a fast load never flashes. Same look as
           the reader's own opening screen, so the hand-off is seamless. -->
      <LoadingScreen title={pendingTitle} />
    {:then Reader}
      {#if Reader}<Reader bookId={nav.route.bookId} />{/if}
    {:catch}
      <!-- The reader chunk failed to load — possibly offline before the SW cached it,
           or a stale hashed-chunk reference after a deploy. Don't trap the user on a
           blank screen: offer a retry and a way back to the shelf. -->
      <div class="chunk-state" role="alert">
        <p>Couldn’t load the reader. Check your connection and try again.</p>
        <div class="actions">
          <!-- A full reload: WebKit can keep replaying a failed module fetch for the same
               URL, and a stale post-deploy chunk name only resolves with fresh HTML. -->
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
