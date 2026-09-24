<script lang="ts" generics="T extends string | number">
  import Icon from './Icon.svelte'

  type Option = {
    value: T
    label?: string
    icon?: string
    count?: number
    lang?: string
    ariaLabel?: string
  }
  let {
    value = $bindable(),
    options,
    onchange,
    label,
  }: { value: T; options: Option[]; onchange?: (v: T) => void; label?: string } = $props()

  function select(v: T) {
    value = v
    onchange?.(v)
  }
</script>

<div class="seg" role="group" aria-label={label}>
  {#each options as opt (opt.value)}
    <button
      class="opt"
      class:active={opt.value === value}
      onclick={() => select(opt.value)}
      aria-pressed={opt.value === value}
      aria-label={opt.ariaLabel}
    >
      {#if opt.icon}<Icon name={opt.icon} size="sm" />{/if}
      {#if opt.label ?? !opt.icon}<span lang={opt.lang}>{opt.label ?? opt.value}</span>{/if}
      {#if opt.count !== undefined}<span class="count">{opt.count}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .seg {
    display: flex;
    width: 100%;
    padding: 2px;
    gap: 2px;
    border-radius: var(--r-full);
    background: var(--control-track);
  }
  .opt {
    flex: 1 1 0;
    min-width: 0;
    min-height: var(--control-h);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    padding: 0 var(--sp-3);
    border-radius: var(--r-full);
    font-size: var(--fs-body);
    font-weight: 550;
    color: var(--ink-soft);
    white-space: nowrap;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out),
      box-shadow var(--dur-fast) var(--ease-out);
  }
  .opt span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .opt.active {
    color: var(--ink);
    background: var(--control-active);
    box-shadow: var(--shadow-1);
  }
  .count {
    flex: none;
    min-width: 20px;
    padding: 0 6px;
    border-radius: var(--r-full);
    font-size: var(--fs-caption);
    line-height: 20px;
    font-variant-numeric: tabular-nums;
    color: var(--ink-soft);
    background: var(--control-track);
  }
  .opt.active .count {
    color: var(--accent);
    background: var(--accent-soft);
  }
</style>
