// Opaque row surfaces for tables with pinned (sticky) cells.
//
// Pinned cells take the row's colour with `bg-inherit`, so every row state must paint an
// OPAQUE background on the <tr> itself: a semi-transparent wash (bg-nvr-cyan/[0.08]) leaves
// the pinned cell transparent, and scrolled content shows through it. The washes are mixed
// over the card surface with color-mix, so they come out right in every host (admin and
// efp-new have different dark cards and accents) without a hex per theme.
//
// Never use `bg-white` on a row: the hosts' dark sheet re-points it with !important, which
// beats every dark tint and hover on the same element (rows lost their tints in dark).

/** A plain row: the card surface. */
export const ROW_SURFACE = 'bg-card'

/** Hover wash on a plain (or changed-since) row: accent 4% light / 8% dark over the card. */
export const ROW_SURFACE_HOVER =
  'hover:bg-[color:color-mix(in_srgb,hsl(var(--card))_96%,rgb(var(--nvr-cyan-rgb)))] dark:hover:bg-[color:color-mix(in_srgb,hsl(var(--card))_92%,rgb(var(--nvr-cyan-rgb)))]'

/** A selected row: accent 8% light / 16% dark over the card (clearly more than hover). */
export const ROW_SURFACE_SELECTED =
  'bg-[color:color-mix(in_srgb,hsl(var(--card))_92%,rgb(var(--nvr-cyan-rgb)))] dark:bg-[color:color-mix(in_srgb,hsl(var(--card))_84%,rgb(var(--nvr-cyan-rgb)))]'

/** What a pinned cell carries: the row's own colour, whatever state it is in. */
export const PINNED_CELL_SURFACE = 'bg-inherit'
