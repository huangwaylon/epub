<script lang="ts" generics="T extends string | number">
  type Option = { value: T; label?: string; icon?: string }
  let {
    value = $bindable(),
    options,
    onchange,
  }: { value: T; options: Option[]; onchange?: (v: T) => void } = $props()

  function select(v: T) {
    value = v
    onchange?.(v)
  }
</script>

<div class="seg" role="group">
  {#each options as opt (opt.value)}
    <button
      class="opt"
      class:active={opt.value === value}
      onclick={() => select(opt.value)}
      aria-pressed={opt.value === value}
    >
      {opt.label ?? opt.value}
    </button>
  {/each}
</div>

<style>
  .seg {
    display: inline-flex;
    width: 100%;
    padding: 3px;
    gap: 3px;
    border-radius: var(--r-md);
    background: var(--accent-soft);
  }
  .opt {
    flex: 1;
    padding: 8px 12px;
    border-radius: calc(var(--r-md) - 3px);
    font-size: 14px;
    font-weight: 550;
    color: var(--ink-soft);
    white-space: nowrap;
    transition: background var(--dur), color var(--dur);
  }
  .opt.active {
    color: var(--ink);
    background: var(--paper-raised);
    box-shadow: var(--shadow-1);
  }
</style>
