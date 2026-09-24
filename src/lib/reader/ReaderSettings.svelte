<script lang="ts">
  import { settings, updateSettings } from '../../stores/settings.svelte'
  import Segmented from '../components/Segmented.svelte'
  import Icon from '../components/Icon.svelte'
  import type { ThemeName, WritingModePref } from '../../services/types'

  // Notifies the reader which aspect changed, so it can re-apply efficiently.
  let { onchange }: { onchange: (kind: 'appearance' | 'layout' | 'writingmode') => void } = $props()

  const themeOpts: { value: ThemeName; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'light', label: 'Light' },
    { value: 'sepia', label: 'Sepia' },
    { value: 'dark', label: 'Dark' },
  ]
  const fontOpts: { value: 'serif' | 'sans'; label: string; lang: string; ariaLabel: string }[] = [
    { value: 'serif', label: '明朝', lang: 'ja', ariaLabel: 'Mincho (serif)' },
    { value: 'sans', label: 'ゴシック', lang: 'ja', ariaLabel: 'Gothic (sans-serif)' },
  ]
  const wmOpts: { value: WritingModePref; label: string; lang?: string }[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'horizontal', label: '横書き', lang: 'ja' },
    { value: 'vertical', label: '縦書き', lang: 'ja' },
  ]

  type StepKey = 'fontScale' | 'lineHeight' | 'marginScale'
  const LIMITS: Record<StepKey, { delta: number; min: number; max: number }> = {
    fontScale: { delta: 0.1, min: 0.7, max: 2.0 },
    lineHeight: { delta: 0.1, min: 1.2, max: 2.6 },
    marginScale: { delta: 0.25, min: 0.5, max: 2.0 },
  }

  function step(key: StepKey, dir: 1 | -1) {
    const { delta, min, max } = LIMITS[key]
    const next = Math.min(max, Math.max(min, Math.round((settings[key] + dir * delta) * 100) / 100))
    if (next === settings[key]) return
    updateSettings({ [key]: next })
    onchange(key === 'marginScale' ? 'layout' : 'appearance')
  }
  const atMin = (k: StepKey) => settings[k] <= LIMITS[k].min + 1e-9
  const atMax = (k: StepKey) => settings[k] >= LIMITS[k].max - 1e-9
</script>

{#snippet stepper(key: StepKey, name: string, value: string, less: string, more: string)}
  <div class="settings-row">
    <span>{name}</span>
    <div class="ctl">
      <button class="icon-btn step" onclick={() => step(key, -1)} disabled={atMin(key)} aria-label={less}>
        <Icon name="minus" size="sm" />
      </button>
      <span class="val">{value}</span>
      <button class="icon-btn step" onclick={() => step(key, 1)} disabled={atMax(key)} aria-label={more}>
        <Icon name="plus" size="sm" />
      </button>
    </div>
  </div>
{/snippet}

<div class="settings-stack">
  <section class="settings-section">
    <h3 class="settings-h">Theme</h3>
    <Segmented
      label="Theme"
      value={settings.theme}
      options={themeOpts}
      onchange={(v) => {
        updateSettings({ theme: v })
        onchange('appearance')
      }}
    />
  </section>

  <section class="settings-section">
    <h3 class="settings-h">Text</h3>
    <Segmented
      label="Typeface"
      value={settings.fontFamily}
      options={fontOpts}
      onchange={(v) => {
        updateSettings({ fontFamily: v })
        onchange('appearance')
      }}
    />
    <div class="rows">
      {@render stepper('fontScale', 'Text size', `${Math.round(settings.fontScale * 100)}%`, 'Smaller text', 'Larger text')}
      {@render stepper('lineHeight', 'Line spacing', settings.lineHeight.toFixed(1), 'Tighter lines', 'Looser lines')}
      {@render stepper('marginScale', 'Margins', `${Math.round(settings.marginScale * 100)}%`, 'Narrower margins', 'Wider margins')}
    </div>
  </section>

  <section class="settings-section">
    <h3 class="settings-h">Writing direction</h3>
    <Segmented
      label="Writing direction"
      value={settings.writingMode}
      options={wmOpts}
      onchange={(v) => {
        updateSettings({ writingMode: v })
        onchange('writingmode')
      }}
    />
  </section>

  <section class="settings-section">
    <h3 class="settings-h">Dictionary</h3>
    <div class="settings-row">
      <span id="hl-lookups">Highlight looked-up words</span>
      <button
        class="switch"
        class:on={settings.highlightLookups}
        role="switch"
        aria-checked={settings.highlightLookups}
        aria-labelledby="hl-lookups"
        onclick={() => updateSettings({ highlightLookups: !settings.highlightLookups })}
      >
        <span class="knob"></span>
      </button>
    </div>
    <p class="settings-hint">Tap any word to look it up. When on, each word you look up is marked yellow and saved to Highlights &amp; Bookmarks.</p>
  </section>
</div>

<style>
  .rows {
    display: flex;
    flex-direction: column;
    margin-top: var(--sp-1);
  }
  .ctl {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
  }
  .step {
    color: var(--ink);
    background: var(--control-track);
  }
  .step:disabled {
    opacity: 0.35;
  }
  .val {
    min-width: 52px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    font-size: var(--fs-body);
    color: var(--ink-soft);
  }
  .switch {
    flex: none;
    position: relative;
    width: 52px;
    height: 32px;
    border-radius: var(--r-full);
    background: var(--line-strong);
    padding: 3px;
    transition: background var(--dur-base) var(--ease-out);
  }
  /* 44pt hit area around the 32pt track. */
  .switch::after {
    content: '';
    position: absolute;
    inset: -6px;
  }
  .switch.on {
    background: var(--accent);
  }
  .knob {
    display: block;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: #fff;
    box-shadow: var(--shadow-1);
    transition: transform var(--dur-base) var(--ease-spring);
  }
  .switch.on .knob {
    transform: translateX(20px);
  }
</style>
