interface LongpressOptions {
  onlongpress: () => void
  duration?: number
}

/** Svelte action: `onlongpress` after a stationary press-and-hold; movement or release cancels. */
export function longpress(node: HTMLElement, opts: LongpressOptions) {
  let current = opts
  let timer: number | undefined
  let startX = 0
  let startY = 0

  function start(e: PointerEvent) {
    startX = e.clientX
    startY = e.clientY
    timer = window.setTimeout(() => {
      current.onlongpress()
    }, current.duration ?? 450)
  }
  function move(e: PointerEvent) {
    if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel()
  }
  function cancel() {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  node.addEventListener('pointerdown', start)
  node.addEventListener('pointermove', move)
  node.addEventListener('pointerup', cancel)
  node.addEventListener('pointercancel', cancel)
  node.addEventListener('pointerleave', cancel)

  return {
    update(next: LongpressOptions) {
      current = next
    },
    destroy() {
      cancel()
      node.removeEventListener('pointerdown', start)
      node.removeEventListener('pointermove', move)
      node.removeEventListener('pointerup', cancel)
      node.removeEventListener('pointercancel', cancel)
      node.removeEventListener('pointerleave', cancel)
    },
  }
}
