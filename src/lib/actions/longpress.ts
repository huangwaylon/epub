/**
 * Svelte action: invoke `onlongpress` after a press-and-hold that doesn't move.
 * Used for iOS-style context menus on the shelf. Cancels on movement or early
 * release so it never competes with taps or scrolling.
 */
export function longpress(
  node: HTMLElement,
  opts: { onlongpress: () => void; duration?: number },
) {
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
    update(next: { onlongpress: () => void; duration?: number }) {
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
