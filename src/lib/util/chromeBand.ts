/**
 * Whether a tap at `py` (top-window Y, px) landed in the top or bottom edge band
 * that toggles the reader chrome. The band roughly covers the nav bars and their
 * reveal zone: 12% of viewport height, clamped to 80–160px so it stays sensible on
 * both a short phone and a tall iPad. Pure so it can be unit-tested; the caller
 * supplies the live (visual) viewport height.
 */
export function inChromeToggleBand(py: number, vh: number): boolean {
  const band = Math.min(160, Math.max(80, vh * 0.12))
  return py <= band || py >= vh - band
}
