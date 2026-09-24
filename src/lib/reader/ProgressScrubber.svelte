<script lang="ts">
  import { onDestroy } from 'svelte'
  /**
   * The bottom-bar reading-progress control. At rest it's a calm hairline track
   * with the section label + percentage. Press-and-drag turns it into a scrubber
   * for fast-scrolling the whole book: an 8px (touch) / 4px (mouse) dead-zone has
   * to be crossed before it arms (so a stray graze never skips), the seek is
   * committed only on release (no re-paginating on every move), and a clean tap
   * is a no-op that just flashes the thumb to teach the affordance. Apple-Books-ish.
   */
  let {
    fraction = 0,
    sectionLabel = '',
    labelAt,
    onseek,
  }: {
    fraction?: number
    sectionLabel?: string
    /** Chapter title at an overall-book fraction — previewed above the % while dragging. */
    labelAt?: (frac: number) => string
    onseek?: (frac: number) => void
  } = $props()

  let track = $state<HTMLDivElement>()
  let scrubbing = $state(false)
  let flashing = $state(false)
  let previewFraction = $state(0)

  // Non-reactive gesture bookkeeping.
  let armed = false
  let startX = 0
  let armThreshold = 8
  let flashTimer: number | undefined

  // The fraction we render: the live preview while scrubbing, else the real one.
  const shown = $derived(scrubbing ? previewFraction : fraction)
  const pct = $derived(Math.round(shown * 100))
  const previewLabel = $derived(scrubbing && labelAt ? labelAt(previewFraction) : '')

  function fractionFromX(clientX: number): number {
    const r = track?.getBoundingClientRect()
    if (!r || r.width === 0) return fraction
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  }

  function onPointerDown(e: PointerEvent) {
    if (!e.isPrimary) return
    // Keep the press from bubbling to the bar's chrome-dismiss handler.
    e.stopPropagation()
    armed = true
    startX = e.clientX
    armThreshold = e.pointerType === 'mouse' ? 4 : 8
    previewFraction = fraction
    if (flashTimer) {
      clearTimeout(flashTimer)
      flashing = false
    }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    } catch {
      /* capture is best-effort */
    }
  }

  function onPointerMove(e: PointerEvent) {
    if (!armed) return
    if (!scrubbing && Math.abs(e.clientX - startX) < armThreshold) return
    scrubbing = true
    previewFraction = fractionFromX(e.clientX)
  }

  function onPointerUp(e: PointerEvent) {
    if (!armed) return
    armed = false
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
    } catch {
      /* nothing captured */
    }
    if (scrubbing) {
      scrubbing = false
      onseek?.(fractionFromX(e.clientX))
    } else {
      // A clean tap: don't seek (that's the big accidental-skip risk). Briefly
      // reveal the thumb so the drag affordance is discoverable.
      flashing = true
      flashTimer = window.setTimeout(() => (flashing = false), 650)
    }
  }

  function onPointerCancel() {
    armed = false
    scrubbing = false
  }

  // The thumb-flash timer can outlive the component: hiding the chrome unmounts this
  // scrubber, and a clean tap right before that leaves a pending 650ms timer. Clear it
  // so it can't fire into a destroyed component (and so its closure is released).
  onDestroy(() => {
    if (flashTimer) clearTimeout(flashTimer)
  })

  // Keyboard a11y: arrow keys nudge (±1%, ±5% with shift); Home/End jump.
  function onKeyDown(e: KeyboardEvent) {
    let next: number | null = null
    const step = e.shiftKey ? 0.05 : 0.01
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = fraction + step
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = fraction - step
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = 1
    if (next === null) return
    e.preventDefault()
    onseek?.(Math.max(0, Math.min(1, next)))
  }
</script>

<!-- onclick stops the synthesized click from reaching the bar's dismiss handler.
     The real control is the .hit slider inside; this wrapper is presentational. -->
<div class="scrubber" class:active={scrubbing} role="presentation" onclick={(e) => e.stopPropagation()}>
  <div class="lane">
    <div bind:this={track} class="track">
      <div class="fill" class:live={scrubbing} style="width:{shown * 100}%"></div>
    </div>
    <div class="thumb" class:show={scrubbing || flashing} style="left:{shown * 100}%"></div>
    {#if scrubbing}
      <div class="bubble" style="--x:{shown}">
        {#if previewLabel}<span class="chap" lang="ja">{previewLabel}</span>{/if}
        <span class="bpct">{pct}%</span>
      </div>
    {/if}
    <!-- 44px invisible hit band carrying all the pointer logic + a11y role. -->
    <div
      class="hit"
      role="slider"
      tabindex="0"
      aria-label="Reading position"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext="{pct}%"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerCancel}
      onkeydown={onKeyDown}
    ></div>
  </div>
  <div class="ptext">
    {#if sectionLabel}<span class="sec" lang="ja">{sectionLabel}</span>{/if}
    <span class="pct">{pct}%</span>
  </div>
</div>

<style>
  .scrubber {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 6px;
    padding: var(--sp-1) var(--sp-2) 2px;
    touch-action: none; /* we own the horizontal drag */
  }
  .lane {
    position: relative;
    height: 4px;
  }
  .track {
    position: absolute;
    inset: 0;
    border-radius: var(--r-full);
    background: var(--line-strong);
    overflow: hidden;
    transition: transform var(--dur-fast) var(--ease-out);
  }
  .scrubber.active .track {
    transform: scaleY(1.6);
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transition: width var(--dur-base) var(--ease-out);
  }
  /* While dragging the fill must track the finger 1:1 — no width easing. */
  .fill.live {
    transition: none;
  }

  .thumb {
    position: absolute;
    top: 50%;
    width: 14px;
    height: 14px;
    margin-left: -7px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow:
      0 0 0 2px var(--paper-raised),
      var(--shadow-1);
    opacity: 0;
    transform: translateY(-50%) scale(0.6);
    transition:
      opacity var(--dur-fast) var(--ease-out),
      transform var(--dur-fast) var(--ease-out),
      left var(--dur-base) var(--ease-out);
    pointer-events: none;
  }
  .thumb.show {
    opacity: 1;
    transform: translateY(-50%) scale(1);
  }
  .scrubber.active .thumb {
    transition:
      opacity var(--dur-fast) var(--ease-out),
      transform var(--dur-fast) var(--ease-out); /* no left easing while dragging */
  }
  /* Mouse/trackpad users get a discoverable resting dot. */
  @media (hover: hover) {
    .scrubber:hover .thumb {
      opacity: 1;
      transform: translateY(-50%) scale(0.75);
    }
  }

  /* Preview bubble: chapter title over the target %. Follows the thumb but is clamped so
     a long title never runs off the capsule's ends. */
  .bubble {
    position: absolute;
    bottom: 100%;
    margin-bottom: var(--sp-5);
    left: clamp(0px, calc(var(--x) * 100%), 100%);
    translate: calc(var(--x) * -100%) 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    max-width: min(320px, 70vw);
    padding: var(--sp-2) var(--sp-3);
    border-radius: var(--r-md);
    color: var(--ink);
    background: var(--glass-bg-strong);
    -webkit-backdrop-filter: var(--glass-filter);
    backdrop-filter: var(--glass-filter);
    box-shadow: var(--glass-shadow);
    pointer-events: none;
    white-space: nowrap;
    animation: pop var(--dur-fast) var(--ease-out);
  }
  .chap {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--font-serif);
    font-size: var(--fs-footnote);
    font-weight: 600;
    color: var(--ink-soft);
  }
  .bpct {
    font-size: var(--fs-callout);
    font-weight: 650;
    font-variant-numeric: tabular-nums;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translateY(4px) scale(0.96);
    }
  }

  .hit {
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: var(--tap);
    transform: translateY(-50%);
    cursor: pointer;
  }
  .hit:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 4px;
    border-radius: var(--r-xs);
  }

  .ptext {
    display: flex;
    justify-content: space-between;
    gap: var(--sp-3);
    font-size: var(--fs-caption);
    line-height: 16px;
    color: var(--ink-soft);
  }
  .sec {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .pct {
    flex: none;
    font-variant-numeric: tabular-nums;
  }
</style>
