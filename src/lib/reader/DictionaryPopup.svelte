<script lang="ts">
  import type { LookupResult } from '../../services/jp/lookupTypes'
  import { dictPhase } from '../../services/jp/dictdb'
  import { dict } from '../../stores/dict.svelte'
  import { placeNearWord, type AnchorRect } from '../util/anchoredPosition'
  import Icon from '../components/Icon.svelte'

  let {
    open = false,
    anchor = null,
    vertical = false,
    loading = false,
    needsDownload = false,
    result = null,
    highlighted = false,
    onclose,
    ondownload,
    ontogglehighlight,
  }: {
    open?: boolean
    /** The tapped glyph / matched word, in top-window coords. The card never covers it. */
    anchor?: AnchorRect | null
    /** Vertical (縦書き) text: place beside the column rather than above/below the line. */
    vertical?: boolean
    /** A lookup is in flight. With a previous `result` still set (a re-targeted card),
     *  that result stays visible, dimmed, rather than blanking to a spinner. */
    loading?: boolean
    needsDownload?: boolean
    result?: LookupResult | null
    /** Whether the looked-up word is currently highlighted (drives the footer toggle). */
    highlighted?: boolean
    /** Close request (X). The reader owns closing — it also releases the define context. */
    onclose?: () => void
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
    if (open) card?.focus({ preventScroll: true })
    else if (wasOpen && restoreFocus) {
      restoreFocus.focus?.()
      restoreFocus = null
    }
    wasOpen = open
  })

  // Most lookups resolve well inside 150ms (cached, or a warm worker); flashing a spinner
  // for those reads as flicker. Show one only when a lookup is genuinely slow.
  let slow = $state(false)
  $effect(() => {
    if (!open || !loading) {
      slow = false
      return
    }
    const t = setTimeout(() => (slow = true), 150)
    return () => clearTimeout(t)
  })

  // The highlight toggle only makes sense once we have a real match to anchor it to.
  const showActions = $derived(!loading && !needsDownload && !!result?.entries.length)
  // One status for the not-installed card: never re-offer Download while a download is
  // running, waiting to retry, or the segmenter is being prepared.
  const phase = $derived(dictPhase())

  // Place the card against the word, re-running when the anchor or the content (hence the
  // card's size) changes. Synchronous — measured and placed in the same flush that mounted
  // it, before the browser paints — so the card never shows a first frame at 0,0 and then
  // jumps (the old requestAnimationFrame placement did exactly that).
  let pos = $state<{ left: number; top: number } | null>(null)
  $effect(() => {
    if (!open) {
      pos = null
      return
    }
    if (!card || !anchor) return
    const a = anchor
    const v = vertical
    void loading
    void slow
    void needsDownload
    void result
    void showActions
    void phase
    pos = placeNearWord(a, card.offsetWidth, card.offsetHeight, v, { gap: 16 })
  })
</script>

{#if open}
  <div
    bind:this={card}
    class="popup"
    style="left:{pos?.left ?? 0}px; top:{pos?.top ?? 0}px;{pos ? '' : ' visibility:hidden'}"
    role="dialog"
    aria-label="Dictionary"
    tabindex="-1"
  >
    <button class="close" aria-label="Close" onclick={() => onclose?.()}>
      <Icon name="x" size={16} />
    </button>
    <div class="body" class:stale={loading && !!result} aria-busy={loading}>
      {#if needsDownload}
        <div class="download">
          {#if phase === 'downloading'}
            <p class="dl-title">Downloading dictionary…</p>
            <div class="track"><div class="fill" style="width:{Math.round(dict.progress * 100)}%"></div></div>
            <p class="dl-sub">{Math.round(dict.progress * 100)}%</p>
          {:else if phase === 'retrying'}
            <p class="dl-title">Waiting to resume the download…</p>
            {#if dict.error}<p class="dl-sub">{dict.error}</p>{/if}
          {:else if phase === 'preparing' || phase === 'ready' || phase === 'checking'}
            <!-- Installed (or still being checked), with the segmenter being prepared:
                 never re-offer the download for a dictionary that is already here. -->
            <p class="dl-title">Preparing the dictionary…</p>
            <div class="loading"><div class="spinner"></div></div>
          {:else if phase === 'unavailable'}
            <p class="dl-title">Dictionary unavailable</p>
            <p class="dl-sub">This device’s storage couldn’t be opened. Try again after restarting the app.</p>
          {:else}
            <p class="dl-title">Dictionary not installed</p>
            <p class="dl-sub">Download the Japanese dictionary (~few MB) to look up words offline.</p>
            <button class="dl-btn" onclick={ondownload}>Download dictionary</button>
            {#if dict.error}<p class="err">{dict.error}</p>{/if}
          {/if}
        </div>
      {:else if result}
        <div class="entries">
          {#each result.entries as entry, i (entry.id ?? entry.headword + entry.reading + ':' + i)}
            <div class="entry">
              <!-- Per entry: one result can mix entries reached by different deinflections
                   (した → する "past", alongside the noun 下 with none). -->
              {#if entry.reasons?.length}
                <div class="reasons">
                  {#each entry.reasons as r}<span class="chip">{r}</span>{/each}
                </div>
              {/if}
              <div class="head">
                <span class="word" lang="ja">{entry.headword}</span>
                {#if !entry.kanaOnly && entry.reading}
                  <span class="reading" lang="ja">{entry.reading}</span>
                {/if}
                {#if entry.pitch !== undefined}
                  <span class="pitch" title="Pitch accent (downstep position)" aria-label="pitch accent {entry.pitch}">
                    <span class="pitch-tag" aria-hidden="true">アクセント</span>{entry.pitch}
                  </span>
                {/if}
              </div>
              <ol class="senses">
                {#each entry.senses as sense}
                  <li>
                    {#if sense.pos.length}<span class="pos">{sense.pos.join(', ')}</span>{/if}
                    {#if sense.misc?.length}<span class="pos">{sense.misc.join(', ')}</span>{/if}
                    <span class="gloss">{sense.glosses.join('; ')}</span>
                  </li>
                {/each}
              </ol>
            </div>
          {/each}
        </div>
      {:else if loading}
        <div class="loading">
          {#if slow}<div class="spinner"></div>{/if}
        </div>
      {:else}
        <div class="none">
          <Icon name="search" size={20} />
          <span>No dictionary match.</span>
        </div>
      {/if}
    </div>
    {#if loading && result && slow}
      <div class="spin-over" aria-hidden="true"><div class="spinner"></div></div>
    {/if}
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
    min-height: 22px;
    padding: 18px;
  }
  /* A re-targeted card: the previous word stays readable, dimmed, while the next loads. */
  .body.stale {
    opacity: 0.45;
    transition: opacity 0.12s var(--ease);
  }
  .spin-over {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
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
    margin-bottom: 6px;
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
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--ink-soft);
    font-variant-numeric: tabular-nums;
  }
  .pitch-tag {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
    background: var(--line);
    padding: 1px 5px;
    border-radius: 100px;
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
    color: var(--danger);
    font-size: 12px;
    margin: 0;
  }
</style>
