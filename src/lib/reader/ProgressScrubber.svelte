<script lang="ts">
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
    onseek,
  }: {
    fraction?: number
    sectionLabel?: string
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
      <div class="bubble" style="left:{shown * 100}%">{pct}%</div>
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
    gap: 5px;
    padding: 0 6px;
    touch-action: none; /* we own the horizontal drag */
  }
  .lane {
    position: relative;
    height: 3px;
  }
  .track {
    position: absolute;
    inset: 0;
    height: 3px;
    border-radius: 2px;
    background: var(--line-strong);
    overflow: hidden;
    transition: height 0.15s var(--ease);
  }
  .scrubber.active .track {
    height: 5px;
    top: -1px;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s var(--ease);
  }
  /* While dragging the fill must track the finger 1:1 — no width easing. */
  .fill.live {
    transition: none;
  }

  .thumb {
    position: absolute;
    top: 50%;
    width: 12px;
    height: 12px;
    margin-left: -6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow:
      0 0 0 2px var(--paper-raised),
      var(--shadow-1);
    opacity: 0;
    transform: translateY(-50%) scale(0.6);
    transition:
      opacity 0.18s var(--ease),
      transform 0.18s var(--ease),
      left 0.2s var(--ease);
    pointer-events: none;
  }
  .thumb.show {
    opacity: 1;
    transform: translateY(-50%) scale(1);
  }
  .scrubber.active .thumb {
    transition:
      opacity 0.18s var(--ease),
      transform 0.18s var(--ease); /* no left easing while dragging */
  }
  /* Mouse/trackpad users get a discoverable resting dot. */
  @media (hover: hover) {
    .scrubber:hover .thumb {
      opacity: 1;
      transform: translateY(-50%) scale(0.75);
    }
  }

  .bubble {
    position: absolute;
    bottom: 100%;
    margin-bottom: 12px;
    transform: translateX(-50%);
    padding: 5px 11px;
    border-radius: var(--r-md);
    font-size: 15px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
    color: var(--ink);
    background: color-mix(in srgb, var(--paper-raised) 88%, transparent);
    border: 1px solid var(--line);
    box-shadow: var(--shadow-2);
    backdrop-filter: blur(10px) saturate(1.2);
    -webkit-backdrop-filter: blur(10px) saturate(1.2);
    pointer-events: none;
    white-space: nowrap;
    animation: pop 0.14s var(--ease);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translateX(-50%) scale(0.96);
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
    border-radius: 4px;
  }

  .ptext {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    font-size: 11px;
    color: var(--ink-faint);
  }
  .sec {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .pct {
    font-variant-numeric: tabular-nums;
  }
</style>
