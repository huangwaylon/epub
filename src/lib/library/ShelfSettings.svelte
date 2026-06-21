<script lang="ts">
  import { onMount } from 'svelte'
  import { settings, updateSettings } from '../../stores/settings.svelte'
  import { storageStatus, formatBytes, type StorageStatus } from '../../services/storage/persist'
  import { dict } from '../../stores/dict.svelte'
  import { getDb, downloadDictionary } from '../../services/jp/dictdb'
  import Segmented from '../components/Segmented.svelte'
  import type { ThemeName } from '../../services/types'

  let status = $state<StorageStatus | null>(null)
  onMount(async () => {
    status = await storageStatus()
    void getDb() // initialise dictionary state for the status readout
  })

  async function getDict() {
    try {
      await downloadDictionary('en')
    } catch {
      /* error shown via store */
    }
  }

  const themeOpts: { value: ThemeName; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'sepia', label: 'Sepia' },
    { value: 'dark', label: 'Dark' },
  ]
</script>

<div class="settings">
  <section>
    <h3>Appearance</h3>
    <Segmented
      value={settings.theme}
      options={themeOpts}
      onchange={(v) => updateSettings({ theme: v })}
    />
  </section>

  <section>
    <h3>Japanese dictionary</h3>
    <div class="dict-row">
      <div class="dict-status">
        {#if dict.updating}
          Downloading… {Math.round(dict.progress * 100)}%
        {:else if dict.state === 'ok'}
          <span class="ok">Installed</span> · tap any word to look it up
        {:else}
          Not installed
        {/if}
      </div>
      {#if !dict.updating && dict.state !== 'ok'}
        <button class="dict-btn" onclick={getDict}>Download</button>
      {/if}
    </div>
    {#if dict.updating}
      <div class="usebar"><div class="usefill" style="width:{Math.round(dict.progress * 100)}%"></div></div>
    {/if}
    {#if dict.error}<p class="hint err">{dict.error}</p>{/if}
    <p class="hint">JMdict data from the 10ten project. Stored on-device for offline lookups.</p>
  </section>

  {#if status}
    <section>
      <h3>Storage</h3>
      <div class="storage">
        <div class="usebar">
          <div
            class="usefill"
            style="width:{status.quota ? Math.min(100, (status.usage / status.quota) * 100) : 0}%"
          ></div>
        </div>
        <div class="usetext">
          {formatBytes(status.usage)} used{status.quota ? ` of ${formatBytes(status.quota)}` : ''}
          {#if status.persisted}<span class="badge">Persistent</span>{/if}
        </div>
      </div>
    </section>
  {/if}

  <section class="about">
    <h3>About</h3>
    <p>
      <strong>Tsuzuri</strong> — a paginated reader for Japanese books. Rendering by
      <a href="https://github.com/johnfactotum/foliate-js" target="_blank" rel="noreferrer">foliate-js</a>;
      dictionary by the
      <a href="https://github.com/birchill/10ten-ja-reader" target="_blank" rel="noreferrer">10ten</a>
      project (JMdict / CC BY-SA).
    </p>
  </section>
</div>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: 26px;
    padding-bottom: 16px;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .hint {
    margin: 0;
    font-size: 12.5px;
    color: var(--ink-faint);
  }
  .err {
    color: #c0392b;
  }
  .dict-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .dict-status {
    font-size: 14px;
    color: var(--ink-soft);
  }
  .dict-status .ok {
    color: var(--accent);
    font-weight: 600;
  }
  .dict-btn {
    flex: none;
    padding: 8px 16px;
    border-radius: var(--r-md);
    font-weight: 600;
    color: #fff;
    background: var(--accent);
  }
  .storage {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .usebar {
    height: 8px;
    border-radius: 4px;
    background: var(--line-strong);
    overflow: hidden;
  }
  .usefill {
    height: 100%;
    background: var(--accent);
  }
  .usetext {
    font-size: 13px;
    color: var(--ink-soft);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .badge {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 2px 7px;
    border-radius: 100px;
  }
  .about p {
    margin: 0;
    font-size: 13px;
    line-height: 1.6;
    color: var(--ink-soft);
  }
  .about a {
    color: var(--accent);
  }
</style>
