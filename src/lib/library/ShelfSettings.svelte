<script lang="ts">
  import { onMount } from 'svelte'
  import { settings, updateSettings } from '../../stores/settings.svelte'
  import { storageStatus, formatBytes, type StorageStatus } from '../../services/storage/persist'
  import { dict } from '../../stores/dict.svelte'
  import { getDb, cacheIpadic, downloadAndCacheDictionary, dictPhase } from '../../services/jp/dictdb'
  import Segmented from '../components/Segmented.svelte'
  import Icon from '../components/Icon.svelte'
  import type { ThemeName } from '../../services/types'

  let status = $state<StorageStatus | null>(null)
  onMount(async () => {
    // Initialise dict state; if JMdict is installed, top up the IPADIC cache (no-op if full).
    void getDb().then(
      () => {
        if (dict.state === 'ok') void cacheIpadic()
      },
      () => {},
    )
    status = await storageStatus()
  })

  const phase = $derived(dictPhase())
  const pct = $derived(Math.round(dict.progress * 100))

  async function getDict() {
    try {
      await downloadAndCacheDictionary('en') // no kuromoji trie built here; the reader warms it
    } catch {
      /* shown via dict.error */
    }
  }

  const themeOpts: { value: ThemeName; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'light', label: 'Light' },
    { value: 'sepia', label: 'Sepia' },
    { value: 'dark', label: 'Dark' },
  ]
</script>

<div class="settings-stack">
  <section class="settings-section">
    <h3 class="settings-h">Japanese dictionary</h3>
    <div class="settings-row">
      <div class="dict-status" aria-live="polite">
        {#if phase === 'downloading'}
          <span>Downloading… <span class="num">{pct}%</span></span>
        {:else if phase === 'retrying'}
          Waiting to resume download…
        {:else if phase === 'preparing'}
          <span class="spinner" style="--spinner-size:14px"></span><span>Preparing for offline use…</span>
        {:else if phase === 'ready'}
          <span><span class="ok">Installed</span> · works offline</span>
        {:else if phase === 'checking'}
          Checking…
        {:else if phase === 'unavailable'}
          Storage unavailable
        {:else}
          Not installed
        {/if}
      </div>
      {#if phase === 'missing' || phase === 'unavailable'}
        <button class="btn btn-primary" onclick={getDict}>Download</button>
      {:else if phase === 'retrying'}
        <button class="btn btn-tinted" onclick={getDict}>Retry now</button>
      {/if}
    </div>
    {#if phase === 'downloading' || phase === 'retrying'}
      <div class="usebar"><div class="usefill" style="width:{pct}%"></div></div>
    {/if}
    {#if dict.error}<p class="settings-hint" class:err={phase !== 'retrying'}>{dict.error}</p>{/if}
    <p class="settings-hint">
      {phase === 'ready' ? 'Tap any word in a book to look it up.' : 'One-time download · works offline.'}
      JMdict data from the 10ten project, stored on this device.
    </p>
  </section>

  <section class="settings-section">
    <h3 class="settings-h">Appearance</h3>
    <Segmented label="Theme" value={settings.theme} options={themeOpts} onchange={(v) => updateSettings({ theme: v })} />
  </section>

  <section class="settings-section">
    <h3 class="settings-h">About</h3>
    {#if status}
      <p class="settings-hint storage">
        Storage: {formatBytes(status.usage)} used{status.quota ? ` of ${formatBytes(status.quota)}` : ''}{status.persisted
          ? ' · persistent'
          : ''}
      </p>
    {/if}
    <details class="about">
      <summary class="settings-row">
        <span>Tsuzuri <span class="version">{__APP_VERSION__}</span></span>
        <span class="chev"><Icon name="chevron-down" size="sm" /></span>
      </summary>
      <p class="settings-hint">
        A paginated reader for Japanese books. Rendering by
        <a href="https://github.com/johnfactotum/foliate-js" target="_blank" rel="noreferrer">foliate-js</a>;
        dictionary by the
        <a href="https://github.com/birchill/10ten-ja-reader" target="_blank" rel="noreferrer">10ten</a>
        project (JMdict / CC BY-SA); segmentation by kuromoji. Licensed GPL-3.0.
      </p>
    </details>
  </section>
</div>

<style>
  .dict-status {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    color: var(--ink-soft);
  }
  .ok {
    color: var(--accent);
    font-weight: 600;
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .err {
    color: var(--danger);
  }
  .usebar {
    height: 4px;
    border-radius: var(--r-full);
    background: var(--line-strong);
    overflow: hidden;
  }
  .usefill {
    height: 100%;
    background: var(--accent);
    transition: width var(--dur-base) var(--ease-out);
  }
  .storage {
    font-variant-numeric: tabular-nums;
  }
  .about summary {
    list-style: none;
    cursor: pointer;
  }
  .about summary::-webkit-details-marker {
    display: none;
  }
  .version {
    margin-inline-start: var(--sp-1);
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
  }
  .chev {
    display: grid;
    color: var(--ink-faint);
    transition: transform var(--dur-base) var(--ease-out);
  }
  .about[open] .chev {
    transform: rotate(180deg);
  }
  .about a {
    color: var(--accent);
  }
</style>
