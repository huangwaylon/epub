/**
 * The controller's pending timeouts in one keyed set, so `destroy()` clears them all and a
 * re-open clears the ones it must. Setting a key replaces (clears) its previous timeout.
 */
export class Timers {
  #ids = new Map<unknown, number>()

  /** Run `fn` after `ms`, replacing any timeout pending under `key`. */
  set(key: unknown, fn: () => void, ms: number): void {
    this.clear(key)
    const id = window.setTimeout(() => {
      if (this.#ids.get(key) === id) this.#ids.delete(key)
      fn()
    }, ms)
    this.#ids.set(key, id)
  }

  clear(key: unknown): void {
    const id = this.#ids.get(key)
    if (id === undefined) return
    clearTimeout(id)
    this.#ids.delete(key)
  }

  clearAll(): void {
    for (const id of this.#ids.values()) clearTimeout(id)
    this.#ids.clear()
  }
}
