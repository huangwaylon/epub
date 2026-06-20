<script lang="ts" module>
  // Minimal stroke-icon set used across the app. 24×24, currentColor, no fill.
  // A filled variant (e.g. the active bookmark) is drawn by passing `fill` on the
  // same path, not a separate `-fill` entry.
  const PATHS: Record<string, string> = {
    plus: 'M12 5v14M5 12h14',
    gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 13a7.8 7.8 0 0 0 0-2l2-1.5-2-3.4-2.4 1a7.8 7.8 0 0 0-1.7-1l-.4-2.6h-3.8l-.4 2.6a7.8 7.8 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.5a7.8 7.8 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a7.8 7.8 0 0 0 1.7 1l.4 2.6h3.8l.4-2.6a7.8 7.8 0 0 0 1.7-1l2.4 1 2-3.4-2-1.5Z',
    bookmark: 'M6 4h12v16l-6-4-6 4V4Z',
    translate: 'M4 5h10M9 3v2M11.5 5c-.6 4.5-3.5 8.5-8 11M6 9c1.2 2.6 3.4 4.8 6 6M13 21l4-9 4 9M14.5 17h5',
    list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
    'arrow-left': 'M19 12H5M11 18l-6-6 6-6',
    x: 'M6 6l12 12M18 6L6 18',
    trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
    book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4ZM19 17H8a3 3 0 0 0-3 3',
    note: 'M5 4h9l5 5v11H5V4ZM14 4v5h5',
    copy: 'M9 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM5 15a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1',
    aa: 'M3 18 7 7l4 11M4.2 14.5h5.6M14 18l3-8 3 8M14.8 15.4h4.4',
  }
</script>

<script lang="ts">
  let {
    name,
    size = 24,
    stroke = 2,
    fill = false,
  }: { name: string; size?: number; stroke?: number; fill?: boolean } = $props()
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill={fill ? 'currentColor' : 'none'}
  stroke="currentColor"
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={PATHS[name] ?? ''} />
</svg>
