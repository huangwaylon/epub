<script lang="ts">
  import { fly } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import Icon from './Icon.svelte'
  import { DUR, dur } from '../util/motion.svelte'

  let {
    message,
    actionLabel,
    onaction,
    ondismiss,
    lift = false,
  }: {
    message: string
    actionLabel?: string
    onaction?: () => void
    ondismiss?: () => void
    /** Sit above the reader's floating bottom bar. */
    lift?: boolean
  } = $props()
</script>

<div
  class="toast glass"
  class:lift
  role="status"
  aria-live="polite"
  in:fly={{ y: 24, duration: dur(DUR.slow), easing: cubicOut }}
  out:fly={{ y: 16, duration: dur(DUR.fast) }}
>
  <span class="msg">{message}</span>
  {#if actionLabel}
    <button class="btn act" onclick={onaction}>{actionLabel}</button>
  {/if}
  {#if ondismiss}
    <button class="icon-btn dismiss" onclick={ondismiss} aria-label="Dismiss">
      <Icon name="x" size="sm" />
    </button>
  {/if}
</div>

<style>
  .toast {
    position: fixed;
    left: 50%;
    translate: -50% 0;
    bottom: calc(var(--safe-bottom) + var(--sp-5));
    z-index: var(--z-toast);
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    max-width: calc(100vw - var(--sp-8));
    min-height: 52px;
    padding: var(--sp-1) var(--sp-1) var(--sp-1) var(--sp-5);
    border-radius: var(--r-full);
    font-size: var(--fs-body);
    color: var(--ink);
    background: var(--glass-bg-strong);
    will-change: transform;
  }
  .toast.lift {
    bottom: calc(var(--safe-bottom) + 92px);
  }
  .msg {
    padding-inline-end: var(--sp-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .msg:last-child {
    padding-inline-end: var(--sp-4);
  }
  .act {
    padding: 0 var(--sp-4);
  }
  .dismiss {
    color: var(--ink-faint);
  }
</style>
