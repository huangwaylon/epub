<script lang="ts">
  import { onMount } from 'svelte'
  import { nav, openShelf, loadReader, warmReader } from './stores/nav.svelte'
  import Shelf from './lib/library/Shelf.svelte'
  import UpdateToast from './lib/components/UpdateToast.svelte'

  // The reader (foliate-js + the reader controller + the dictionary download glue) is
  // a lazy chunk so the Shelf cold-starts without any of it. It's fetched on first open
  // — or earlier: warmed once the shelf has settled, and on pointerdown on a cover — and
  // the heavy kuromoji/JMdict engine is split a step further into its own worker.
  // `attempt` is bumped by "Try again" so a failed load re-derives a fresh promise
  // (loadReader drops a rejected promise rather than caching it).
  let attempt = $state(0)
  const readerPromise = $derived.by(() => {
    void attempt
    return nav.route.name === 'reader' ? loadReader() : null
  })

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
      <!-- Calm paper screen while the chunk arrives (usually already warm) — the
           spinner only fades in if it's actually slow, so a fast load never flashes. -->
      <div class="chunk-state" aria-busy="true"><div class="spinner"></div></div>
    {:then Reader}
      {#if Reader}<Reader bookId={nav.route.bookId} />{/if}
    {:catch}
      <!-- The reader chunk failed to load — possibly offline before the SW cached it,
           or a stale hashed-chunk reference after a deploy. Don't trap the user on a
           blank screen: offer a retry and a way back to the shelf. -->
      <div class="chunk-state" role="alert">
        <p>Couldn’t load the reader. Check your connection and try again.</p>
        <div class="actions">
          <button class="primary" onclick={() => attempt++}>Try again</button>
          <button onclick={openShelf}>← Back to library</button>
        </div>
      </div>
    {/await}
  {/key}
{:else}
  <Shelf />
{/if}

<UpdateToast />

<style>
  .chunk-state {
    position: fixed;
    inset: 0;
    height: var(--app-height, 100dvh);
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 16px;
    padding: 24px;
    text-align: center;
    background: var(--paper);
    color: var(--ink-soft);
  }
  .chunk-state p {
    margin: 0;
  }
  .actions {
    display: flex;
    gap: 20px;
  }
  .actions button {
    color: var(--accent);
    font-weight: 600;
  }
  .spinner {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 3px solid var(--line-strong);
    border-top-color: var(--accent);
    opacity: 0;
    animation:
      fade-in 0.3s ease 0.4s forwards,
      spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes fade-in {
    to {
      opacity: 1;
    }
  }
</style>
