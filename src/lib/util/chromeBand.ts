/** Whether top-window `py` is in the top/bottom chrome-toggle band: 12% of `vh`, clamped 80–160px. */
export function inChromeToggleBand(py: number, vh: number): boolean {
  const band = Math.min(160, Math.max(80, vh * 0.12))
  return py <= band || py >= vh - band
}
