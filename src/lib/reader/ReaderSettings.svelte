<script lang="ts">
  import { settings, updateSettings } from '../../stores/settings.svelte'
  import Segmented from '../components/Segmented.svelte'
  import Icon from '../components/Icon.svelte'
  import type { ThemeName, WritingModePref } from '../../services/types'

  // Notifies the reader which aspect changed, so it can re-apply efficiently.
  let { onchange }: { onchange: (kind: 'appearance' | 'layout' | 'writingmode') => void } = $props()

  const themeOpts: { value: ThemeName; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'sepia', label: 'Sepia' },
    { value: 'dark', label: 'Dark' },
  ]
  const wmOpts: { value: WritingModePref; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'horizontal', label: '横書き' },
    { value: 'vertical', label: '縦書き' },
  ]

  function step(key: 'fontScale' | 'lineHeight' | 'marginScale', delta: number, min: number, max: number) {
    const next = Math.min(max, Math.max(min, Math.round((settings[key] + delta) * 100) / 100))
    updateSettings({ [key]: next })
    onchange(key === 'marginScale' ? 'layout' : 'appearance')
  }
</script>

<div class="rs">
  <section>
    <Segmented value={settings.theme} options={themeOpts} onchange={(v) => { updateSettings({ theme: v }); onchange('appearance') }} />
  </section>

  <section>
    <Segmented
      value={settings.fontFamily}
      options={[{ value: 'serif', label: '明朝 Serif' }, { value: 'sans', label: 'ゴシック Sans' }]}
      onchange={(v) => { updateSettings({ fontFamily: v }); onchange('appearance') }}
    />
  </section>

  <div class="steppers">
    <div class="stepper">
      <span class="lbl">Text size</span>
      <div class="ctl">
        <button onclick={() => step('fontScale', -0.1, 0.7, 2.0)} aria-label="Smaller text"><Icon name="aa" size={16} /></button>
        <span class="val">{Math.round(settings.fontScale * 100)}%</span>
        <button onclick={() => step('fontScale', 0.1, 0.7, 2.0)} aria-label="Larger text"><Icon name="aa" size={24} /></button>
      </div>
    </div>

    <div class="stepper">
      <span class="lbl">Line spacing</span>
      <div class="ctl">
        <button onclick={() => step('lineHeight', -0.1, 1.2, 2.6)} aria-label="Tighter">−</button>
        <span class="val">{settings.lineHeight.toFixed(1)}</span>
        <button onclick={() => step('lineHeight', 0.1, 1.2, 2.6)} aria-label="Looser">+</button>
      </div>
    </div>

    <div class="stepper">
      <span class="lbl">Margins</span>
      <div class="ctl">
        <button onclick={() => step('marginScale', -0.25, 0.5, 2.0)} aria-label="Narrower">−</button>
        <span class="val">{Math.round(settings.marginScale * 100)}%</span>
        <button onclick={() => step('marginScale', 0.25, 0.5, 2.0)} aria-label="Wider">+</button>
      </div>
    </div>
  </div>

  <section>
    <h3>Writing direction</h3>
    <Segmented
      value={settings.writingMode}
      options={wmOpts}
      onchange={(v) => { updateSettings({ writingMode: v }); onchange('writingmode') }}
    />
  </section>

  <section class="toggle">
    <div>
      <div class="tname">Tap to look up</div>
      <div class="thint">Tap a word for its dictionary entry; tap edges to turn the page.</div>
    </div>
    <button
      class="switch"
      class:on={settings.tapToDefine}
      role="switch"
      aria-checked={settings.tapToDefine}
      aria-label="Tap to look up"
      onclick={() => updateSettings({ tapToDefine: !settings.tapToDefine })}
    >
      <span class="knob"></span>
    </button>
  </section>
</div>

<style>
  .rs {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding-bottom: 12px;
  }
  h3 {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .steppers {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .stepper {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 0;
    border-bottom: 1px solid var(--line);
  }
  .lbl {
    font-size: 15px;
  }
  .ctl {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .ctl button {
    width: 44px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: var(--r-sm);
    font-size: 20px;
    color: var(--ink);
    background: var(--accent-soft);
  }
  .ctl .val {
    min-width: 52px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    font-size: 14px;
    color: var(--ink-soft);
  }
  .toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .tname {
    font-size: 15px;
  }
  .thint {
    font-size: 12.5px;
    color: var(--ink-faint);
    margin-top: 2px;
    max-width: 30ch;
  }
  .switch {
    flex: none;
    width: 52px;
    height: 32px;
    border-radius: 100px;
    background: var(--line-strong);
    padding: 3px;
    transition: background var(--dur);
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
    transition: transform var(--dur) var(--ease);
  }
  .switch.on .knob {
    transform: translateX(20px);
  }
</style>
