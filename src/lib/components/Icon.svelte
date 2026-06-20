<script lang="ts" module>
  // Minimal stroke-icon set used across the app. 24×24, currentColor, no fill.
  const PATHS: Record<string, string> = {
    plus: 'M12 5v14M5 12h14',
    gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 13a7.8 7.8 0 0 0 0-2l2-1.5-2-3.4-2.4 1a7.8 7.8 0 0 0-1.7-1l-.4-2.6h-3.8l-.4 2.6a7.8 7.8 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.5a7.8 7.8 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a7.8 7.8 0 0 0 1.7 1l.4 2.6h3.8l.4-2.6a7.8 7.8 0 0 0 1.7-1l2.4 1 2-3.4-2-1.5Z',
    bookmark: 'M6 4h12v16l-6-4-6 4V4Z',
    'bookmark-fill': 'M6 4h12v16l-6-4-6 4V4Z',
    highlighter: 'M4 20h6M14.5 4.5l5 5L9 20H4v-5L14.5 4.5Z',
    translate: 'M4 5h10M9 3v2M11.5 5c-.6 4.5-3.5 8.5-8 11M6 9c1.2 2.6 3.4 4.8 6 6M13 21l4-9 4 9M14.5 17h5',
    list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
    'chevron-left': 'M15 6l-6 6 6 6',
    'chevron-right': 'M9 6l6 6-6 6',
    'arrow-left': 'M19 12H5M11 18l-6-6 6-6',
    x: 'M6 6l12 12M18 6L6 18',
    trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
    text: 'M5 7V5h14v2M12 5v14M9 19h6',
    book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4ZM19 17H8a3 3 0 0 0-3 3',
    note: 'M5 4h9l5 5v11H5V4ZM14 4v5h5',
    check: 'M5 12l4.5 4.5L19 7',
    sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
    aa: 'M3 18 7 7l4 11M4.2 14.5h5.6M14 18l3-8 3 8M14.8 15.4h4.4',
    vertical: 'M9 4v16M15 4v16M6 7l3-3 3 3M18 17l-3 3-3-3',
    horizontal: 'M4 9h16M4 15h16M7 6 4 9l3 3M17 6l3 3-3 3',
    dots: 'M5 12h.01M12 12h.01M19 12h.01',
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
