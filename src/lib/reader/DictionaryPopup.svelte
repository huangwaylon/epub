<script lang="ts">
  import type { LookupResult } from '../../services/jp/lookupTypes'
  import { dict } from '../../stores/dict.svelte'
  import { placeAnchored } from '../util/anchoredPosition'
  import Icon from '../components/Icon.svelte'

  let {
    open = $bindable(false),
    x = 0,
    y = 0,
    loading = false,
    needsDownload = false,
    result = null,
    highlighted = false,
    ondownload,
    ontogglehighlight,
  }: {
    open?: boolean
    x?: number
    y?: number
    loading?: boolean
    needsDownload?: boolean
    result?: LookupResult | null
    /** Whether the looked-up word is currently highlighted (drives the footer toggle). */
    highlighted?: boolean
    ondownload?: () => void
    ontogglehighlight?: () => void
  } = $props()

  let card = $state<HTMLDivElement>()

  // Move focus into the popup on open (so VoiceOver / keyboard users land inside it)
  // and restore it to the trigger on close. Edge-gated on a real closed→open
  // transition: the effect also re-runs when `bind:this` sets `card` while `open` is
  // still true, and without the gate that pass would re-capture the now-focused popup
  // as the restore target. Mirrors Sheet.svelte. (No aria-modal: this is a
  // tap-anywhere-to-dismiss popover with no inert backdrop, so it must not advertise
  // background inertness it doesn't implement.)
  let restoreFocus: HTMLElement | null = null
  let wasOpen = false
  $effect(() => {
    if (open && !wasOpen) restoreFocus = (document.activeElement as HTMLElement) ?? null
    if (open) card?.focus()
    else if (wasOpen && restoreFocus) {
      restoreFocus.focus?.()
      restoreFocus = null
    }
    wasOpen = open
  })

  // The highlight toggle only makes sense once we have a real match to anchor it to.
  const showActions = $derived(!loading && !needsDownload && !!result?.entries.length)

  // Position near the tap, re-running when the anchor (x/y) or the content — hence
  // the card's size — changes, so a re-tap on another word or a loaded result is
  // placed correctly rather than left at the first position.
  let pos = $state({ left: 0, top: 0 })
  $effect(() => {
    if (!open) return
    const ax = x
    const ay = y
    void loading
    void needsDownload
    void result
    void showActions
    const id = requestAnimationFrame(() => {
      if (!open) return // a dismiss tap may have landed before this frame
      const w = card?.offsetWidth ?? 300
      const h = card?.offsetHeight ?? 160
      pos = placeAnchored(ax, ay, ay, w, h, { gap: 16 })
    })
    // Cancel a queued frame when the anchor/content changes again (rapid re-tap) or
    // the popup closes, so stale frames don't pile up forcing extra layout reads.
    return () => cancelAnimationFrame(id)
  })
</script>

{#if open}
  <div
    bind:this={card}
    class="popup"
    style="left:{pos.left}px; top:{pos.top}px"
    role="dialog"
    aria-label="Dictionary"
    tabindex="-1"
  >
    <button class="close" aria-label="Close" onclick={() => (open = false)}>
      <Icon name="x" size={16} />
    </button>
    <div class="body">
      {#if loading}
        <div class="loading"><div class="spinner"></div></div>
      {:else if needsDownload}
        <div class="download">
          <p class="dl-title">Dictionary not installed</p>
          <p class="dl-sub">Download the Japanese dictionary (~few MB) to look up words offline.</p>
          {#if dict.updating}
            <div class="track"><div class="fill" style="width:{Math.round(dict.progress * 100)}%"></div></div>
            <p class="dl-sub">Downloading… {Math.round(dict.progress * 100)}%</p>
          {:else}
            <button class="dl-btn" onclick={ondownload}>Download dictionary</button>
            {#if dict.error}<p class="err">{dict.error}</p>{/if}
          {/if}
        </div>
      {:else if result}
        <div class="entries">
          {#if result.reasons.length}
            <div class="reasons">
              {#each result.reasons as r}<span class="chip">{r}</span>{/each}
            </div>
          {/if}
          {#each result.entries as entry, i (entry.headword + entry.reading + ':' + i)}
            <div class="entry">
              <div class="head">
                <span class="word" lang="ja">{entry.headword}</span>
                {#if !entry.kanaOnly && entry.reading}
                  <span class="reading" lang="ja">{entry.reading}</span>
                {/if}
                {#if entry.pitch !== undefined}<span class="pitch">[{entry.pitch}]</span>{/if}
              </div>
              <ol class="senses">
                {#each entry.senses as sense}
                  <li>
                    {#if sense.pos.length}<span class="pos">{sense.pos.join(', ')}</span>{/if}
                    <span class="gloss">{sense.glosses.join('; ')}</span>
                  </li>
                {/each}
              </ol>
            </div>
          {/each}
        </div>
      {:else}
        <div class="none">
          <Icon name="search" size={20} />
          <span>No dictionary match.</span>
        </div>
      {/if}
    </div>
    {#if showActions}
      <div class="actions">
        <button class="hl-toggle" class:on={highlighted} onclick={ontogglehighlight}>
          <span class="hl-swatch" class:filled={highlighted}></span>
          {highlighted ? 'Remove highlight' : 'Highlight'}
        </button>
      </div>
    {/if}
  </div>
{/if}

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && (open = false)} />

<style>
  .popup {
    position: fixed;
    z-index: 50;
    display: flex;
    flex-direction: column;
    width: min(340px, calc(100vw - 40px - var(--safe-left, 0px) - var(--safe-right, 0px)));
    max-height: 46dvh;
    background: var(--paper-raised);
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-2);
    animation: pop 0.14s var(--ease);
  }
  .body {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    padding: 14px 16px;
  }
  .close {
    position: absolute;
    /* 44×44 hit target (Apple HIG min); top:0/right:0 keeps the 16px icon's centre at
       the same spot the old 36px@4px button had it, so nothing shifts visually. */
    top: 0;
    right: 0;
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--ink-faint);
    z-index: 1;
  }
  .close:active {
    background: var(--accent-soft);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.96);
    }
  }
  .loading {
    display: grid;
    place-items: center;
    padding: 18px;
  }
  .spinner {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 2.5px solid var(--line-strong);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .reasons {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-bottom: 10px;
  }
  .chip {
    font-size: 11px;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 3px 8px;
    border-radius: 100px;
  }
  .entry {
    padding: 8px 0;
    border-top: 1px solid var(--line);
  }
  .entry:first-child {
    border-top: 0;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }
  .word {
    font-family: var(--font-serif);
    font-size: 23px;
    font-weight: 600;
    line-height: 1.2;
  }
  .reading {
    font-size: 15px;
    color: var(--accent);
  }
  .pitch {
    font-size: 12px;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
  }
  .senses {
    margin: 6px 0 0;
    padding-inline-start: 18px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .senses li {
    font-size: 14px;
    line-height: 1.45;
    color: var(--ink);
  }
  .pos {
    font-size: 11px;
    font-style: italic;
    color: var(--ink-faint);
    margin-inline-end: 6px;
  }
  .none {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--ink-faint);
    font-size: 14px;
    padding: 4px;
  }

  /* Sticky footer action: toggle the word's yellow vocab highlight. */
  .actions {
    flex: none;
    padding: 6px 10px;
    border-top: 1px solid var(--line);
    background: var(--paper-raised);
    border-radius: 0 0 var(--r-lg) var(--r-lg);
  }
  .hl-toggle {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 40px;
    padding: 0 8px;
    border-radius: var(--r-md);
    font-size: 14px;
    font-weight: 600;
    color: var(--accent);
  }
  .hl-toggle.on {
    color: var(--ink-soft);
  }
  .hl-toggle:active {
    background: var(--accent-soft);
  }
  .hl-swatch {
    width: 16px;
    height: 16px;
    border-radius: 5px;
    border: 1.5px solid var(--line-strong);
    transition:
      transform 0.16s var(--ease),
      background 0.16s var(--ease);
  }
  .hl-swatch.filled {
    background: #ffd54a;
    border-color: color-mix(in srgb, #ffd54a 65%, var(--ink));
  }
  .hl-toggle:active .hl-swatch {
    transform: scale(0.85);
  }

  .download {
    display: flex;
    flex-direction: column;
    gap: 8px;
    text-align: center;
  }
  .dl-title {
    margin: 0;
    font-weight: 650;
    font-size: 15px;
  }
  .dl-sub {
    margin: 0;
    font-size: 12.5px;
    color: var(--ink-soft);
  }
  .dl-btn {
    margin-top: 4px;
    padding: 10px;
    border-radius: var(--r-md);
    font-weight: 600;
    color: #fff;
    background: var(--accent);
  }
  .track {
    height: 6px;
    border-radius: 3px;
    background: var(--line-strong);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s;
  }
  .err {
    color: #c0392b;
    font-size: 12px;
    margin: 0;
  }
</style>
