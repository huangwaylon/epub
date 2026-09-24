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

  // Focus the card on open and restore focus on close. Gated on a real closed→open edge:
  // the effect re-runs when `bind:this` sets `card`, which must not re-capture the popup
  // as the restore target. No aria-modal: there is no inert backdrop.
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

  // Show loading UI only after 150 ms; most lookups finish sooner and would just flicker.
  let slow = $state(false)
  $effect(() => {
    if (!open || !loading) {
      slow = false
      return
    }
    const t = setTimeout(() => (slow = true), 150)
    return () => clearTimeout(t)
  })

  const showActions = $derived(!loading && !needsDownload && !!result?.entries.length)
  // Never re-offer Download while one is running, retrying, or preparing.
  const phase = $derived(dictPhase())

  // Place against the word whenever the anchor or content (hence size) changes — in the
  // same flush, before paint, so there is never a frame at 0,0.
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
    <button class="icon-btn close" aria-label="Close" onclick={() => onclose?.()}>
      <Icon name="x" size="sm" />
    </button>
    <div class="body" class:stale={loading && !!result} aria-busy={loading}>
      {#if needsDownload}
        <div class="download">
          {#if phase === 'downloading'}
            <p class="dl-title">Downloading dictionary…</p>
            <div class="track"><div class="fill" style="width:{Math.round(dict.progress * 100)}%"></div></div>
            <p class="dl-sub num">{Math.round(dict.progress * 100)}%</p>
          {:else if phase === 'retrying'}
            <p class="dl-title">Waiting to resume the download…</p>
            {#if dict.error}<p class="dl-sub">{dict.error}</p>{/if}
          {:else if phase === 'preparing' || phase === 'ready' || phase === 'checking'}
            <!-- Installed (or still being checked): never re-offer the download. -->
            <p class="dl-title">Preparing the dictionary…</p>
            <div class="progress-indeterminate prep" role="progressbar" aria-label="Preparing the dictionary"></div>
            <p class="dl-sub">Getting word lookup ready — this only happens once.</p>
          {:else if phase === 'unavailable'}
            <p class="dl-title">Dictionary unavailable</p>
            <p class="dl-sub">This device’s storage couldn’t be opened. Try again after restarting the app.</p>
          {:else}
            <p class="dl-title">Dictionary not installed</p>
            <p class="dl-sub">Look up any word in the book with the Japanese–English dictionary.</p>
            <button class="btn btn-primary dl-btn" onclick={ondownload}>Download dictionary</button>
            <p class="dl-foot">One-time download · works offline</p>
            {#if dict.error}<p class="err">{dict.error}</p>{/if}
          {/if}
        </div>
      {:else if result}
        <div class="entries">
          {#each result.entries as entry, i (entry.id ?? entry.headword + entry.reading + ':' + i)}
            <div class="entry">
              <!-- Per entry: one result can mix した → する "past" with the noun 下. -->
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
        <div class="skel" role="status" aria-label="Looking up" class:show={slow}>
          <div class="skeleton sk-head"></div>
          <div class="skeleton sk-line"></div>
          <div class="skeleton sk-line short"></div>
        </div>
      {:else}
        <div class="none">
          <Icon name="search" size="sm" />
          <span>No dictionary match.</span>
        </div>
      {/if}
    </div>
    {#if loading && result && slow}
      <div class="spin-over" aria-hidden="true"><div class="spinner" style="--spinner-size:20px"></div></div>
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
    z-index: var(--z-popup);
    display: flex;
    flex-direction: column;
    width: min(340px, calc(100vw - 40px - var(--safe-left, 0px) - var(--safe-right, 0px)));
    max-height: 46dvh;
    background: var(--paper-raised);
    border-radius: var(--r-lg);
    box-shadow: var(--glass-edge), var(--shadow-3);
    outline: none;
    animation: pop var(--dur-fast) var(--ease-out);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.96);
    }
  }
  .body {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    padding: var(--sp-3) var(--sp-4);
  }
  /* 44pt × in the corner; the first line of every state leaves room for it, so a long
     headword never runs underneath. */
  .close {
    position: absolute;
    top: 0;
    right: 0;
    z-index: 1;
    color: var(--ink-faint);
  }
  .entry:first-child > :first-child,
  .none,
  .skel {
    padding-inline-end: var(--sp-8);
  }

  /* A re-targeted card: the previous word stays readable, dimmed, while the next loads. */
  .body.stale {
    opacity: 0.45;
    transition: opacity var(--dur-fast) var(--ease-out);
  }
  .spin-over {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
  }

  .skel {
    display: grid;
    gap: var(--sp-2);
    padding-block: var(--sp-1);
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease-out);
  }
  .skel.show {
    opacity: 1;
  }
  .sk-head {
    width: 44%;
    height: 24px;
  }
  .sk-line {
    height: 12px;
  }
  .sk-line.short {
    width: 70%;
  }

  .reasons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
    margin-bottom: var(--sp-2);
  }
  .chip {
    font-size: var(--fs-caption);
    font-weight: 600;
    line-height: 1.4;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 2px var(--sp-2);
    border-radius: var(--r-full);
  }
  .entry {
    padding: var(--sp-3) 0;
    border-top: 1px solid var(--line);
  }
  .entry:first-child {
    border-top: 0;
    padding-top: var(--sp-1);
  }
  .entry:last-child {
    padding-bottom: var(--sp-1);
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: var(--sp-1) var(--sp-3);
    flex-wrap: wrap;
  }
  .word {
    font-family: var(--font-serif);
    font-size: var(--fs-headword);
    font-weight: 600;
    line-height: 1.25;
  }
  .reading {
    font-size: var(--fs-body);
    color: var(--accent);
  }
  .pitch {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    font-size: var(--fs-caption);
    color: var(--ink-soft);
    font-variant-numeric: tabular-nums;
  }
  .pitch-tag {
    font-size: var(--fs-caption);
    font-weight: 600;
    color: var(--ink-faint);
    background: var(--control-track);
    padding: 0 var(--sp-2);
    border-radius: var(--r-full);
  }
  .senses {
    margin: var(--sp-2) 0 0;
    padding-inline-start: var(--sp-5);
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .senses li {
    font-size: var(--fs-body);
    line-height: 1.45;
    color: var(--ink);
  }
  .senses li::marker {
    color: var(--ink-faint);
    font-size: var(--fs-footnote);
    font-variant-numeric: tabular-nums;
  }
  .pos {
    font-size: var(--fs-caption);
    font-style: italic;
    color: var(--ink-faint);
    margin-inline-end: var(--sp-2);
  }
  .none {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: 28px;
    color: var(--ink-soft);
    font-size: var(--fs-body);
  }

  /* Sticky footer action: toggle the word's yellow vocab highlight. */
  .actions {
    flex: none;
    padding: var(--sp-1) var(--sp-2);
    border-top: 1px solid var(--line);
  }
  .hl-toggle {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
    min-height: var(--control-h);
    padding: 0 var(--sp-2);
    border-radius: var(--r-sm);
    font-size: var(--fs-body);
    font-weight: 600;
    color: var(--accent);
  }
  .hl-toggle.on {
    color: var(--ink-soft);
  }
  .hl-toggle:active {
    background: var(--control-track);
  }
  .hl-swatch {
    width: var(--icon-sm);
    height: var(--icon-sm);
    border-radius: var(--r-xs);
    border: 1.5px solid var(--line-strong);
    transition:
      transform var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
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
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-5);
    text-align: center;
  }
  .dl-title {
    margin: 0;
    font-weight: 650;
    font-size: var(--fs-callout);
  }
  .dl-sub {
    margin: 0;
    font-size: var(--fs-footnote);
    line-height: 1.45;
    color: var(--ink-soft);
  }
  .dl-foot {
    margin: 0;
    font-size: var(--fs-caption);
    color: var(--ink-faint);
  }
  .dl-btn {
    align-self: stretch;
    margin-top: var(--sp-2);
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .prep {
    margin: var(--sp-2) 0;
  }
  .track {
    align-self: stretch;
    height: 4px;
    margin-top: var(--sp-1);
    border-radius: var(--r-full);
    background: var(--line-strong);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transition: width var(--dur-base) var(--ease-out);
  }
  .err {
    color: var(--danger);
    font-size: var(--fs-caption);
    margin: 0;
  }
</style>
