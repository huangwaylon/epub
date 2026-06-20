<script lang="ts">
  import { translate, TranslateError } from '../../services/translate'
  import { settings } from '../../stores/settings.svelte'
  import Icon from '../components/Icon.svelte'

  let { open = $bindable(false), text = '' }: { open?: boolean; text?: string } = $props()

  let result = $state('')
  let engine = $state('')
  let loading = $state(false)
  let error = $state('')

  // Re-run whenever a new selection opens the sheet.
  let lastKey = ''
  $effect(() => {
    const key = `${open}:${settings.translationTargetLang}:${text}`
    if (open && text && key !== lastKey) {
      lastKey = key
      void run()
    }
    if (!open) lastKey = ''
  })

  async function run() {
    loading = true
    error = ''
    result = ''
    try {
      const r = await translate(text, settings.translationTargetLang)
      result = r.result
      engine = r.engine
    } catch (e) {
      error = e instanceof TranslateError ? e.message : 'Translation failed.'
    } finally {
      loading = false
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(result)
    } catch {
      /* ignore */
    }
  }
</script>

<div class="tr">
  <div class="source" lang="ja">{text}</div>

  <div class="arrow"><Icon name="translate" size={18} /></div>

  {#if loading}
    <div class="state"><div class="spinner"></div></div>
  {:else if error}
    <div class="state err">
      <p>{error}</p>
      <button class="retry" onclick={run}>Try again</button>
    </div>
  {:else}
    <div class="result">{result}</div>
    <div class="foot">
      <span class="engine">{engine}</span>
      <button class="copy" onclick={copy} aria-label="Copy translation">
        <Icon name="note" size={16} /> Copy
      </button>
    </div>
  {/if}
</div>

<style>
  .tr {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-bottom: 14px;
  }
  .source {
    font-family: var(--font-serif);
    font-size: 17px;
    line-height: 1.7;
    color: var(--ink);
    max-height: 28dvh;
    overflow-y: auto;
  }
  .arrow {
    color: var(--ink-faint);
    display: flex;
    justify-content: center;
  }
  .result {
    font-size: 16px;
    line-height: 1.6;
    color: var(--ink);
  }
  .state {
    display: grid;
    place-items: center;
    gap: 12px;
    padding: 14px;
    text-align: center;
  }
  .err p {
    margin: 0;
    color: var(--ink-soft);
    font-size: 14px;
  }
  .retry {
    color: var(--accent);
    font-weight: 600;
  }
  .spinner {
    width: 24px;
    height: 24px;
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
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-top: 1px solid var(--line);
    padding-top: 10px;
  }
  .engine {
    font-size: 12px;
    color: var(--ink-faint);
  }
  .copy {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    font-weight: 600;
    color: var(--accent);
  }
</style>
