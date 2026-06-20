<script lang="ts">
  import type { BookMeta } from '../../services/types'

  let { book }: { book: BookMeta } = $props()

  // Manage the object URL for the cover blob across the component's life.
  let url = $state<string | undefined>()
  $effect(() => {
    if (book.cover) {
      const u = URL.createObjectURL(book.cover)
      url = u
      return () => URL.revokeObjectURL(u)
    }
    url = undefined
  })

  // Stable accent for the placeholder spine, derived from the id.
  const hue = $derived(
    [...book.id].slice(0, 6).reduce((a, c) => a + c.charCodeAt(0), 0) % 360,
  )
</script>

{#if url}
  <img class="cover" src={url} alt={book.title} loading="lazy" />
{:else}
  <div class="cover placeholder" style="--h:{hue}">
    <div class="spine"></div>
    <div class="ptitle" lang="ja">{book.title}</div>
    {#if book.author}<div class="pauthor" lang="ja">{book.author}</div>{/if}
  </div>
{/if}

<style>
  .cover {
    width: 100%;
    aspect-ratio: 2 / 3;
    object-fit: cover;
    border-radius: var(--r-sm);
    background: var(--paper-raised);
    box-shadow: var(--shadow-1);
    display: block;
  }
  .placeholder {
    position: relative;
    overflow: hidden;
    padding: 14px 14px 14px 20px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: linear-gradient(
      150deg,
      hsl(var(--h) 38% 92%),
      hsl(var(--h) 30% 82%)
    );
    color: hsl(var(--h) 45% 24%);
  }
  :global([data-theme='dark']) .placeholder {
    background: linear-gradient(150deg, hsl(var(--h) 22% 26%), hsl(var(--h) 24% 18%));
    color: hsl(var(--h) 30% 84%);
  }
  .spine {
    position: absolute;
    inset: 0 auto 0 0;
    width: 6px;
    background: hsl(var(--h) 45% 40% / 0.55);
  }
  .ptitle {
    font-family: var(--font-serif);
    font-weight: 600;
    font-size: 15px;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 5;
    line-clamp: 5;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .pauthor {
    margin-top: auto;
    font-size: 11px;
    opacity: 0.75;
  }
</style>
