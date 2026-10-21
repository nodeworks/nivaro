// One look for the editor's right-hand panel: the inspector and Form settings
// share these, so a label, an input or an effect sentence reads the same in both.

/** Setting label. */
export const labelText = 'text-[13px] font-medium leading-5 text-slate-800 dark:text-foreground'

/** The one-line effect sentence under a control, and other quiet helper text. */
export const effectText = 'text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'

/** A group of settings inside a panel (Numbers, Rows, How it's laid out…). */
export const groupTitle = 'text-[13px] font-semibold leading-5 text-slate-900 dark:text-foreground'

/** Text inputs, pick-list triggers and select triggers. */
export const inputBase =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[13px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-nvr-cyan disabled:opacity-50 dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'

/** Panel side padding — header, search and body line up on it. */
export const panelX = 'px-4'

/** A segmented choice: a quiet track, the picked option raised on it. Wraps
 *  into rows of three past four options. */
export const segTrack = (count: number) =>
  [
    'grid gap-0.5 rounded-md bg-slate-100 p-0.5 dark:bg-muted',
    count > 4
      ? 'grid-cols-3'
      : ['grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-4'][Math.max(0, count - 1)]
  ].join(' ')
export const segOption = (on: boolean) =>
  [
    'h-7 min-w-0 truncate rounded px-1.5 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 disabled:opacity-40',
    on
      ? 'bg-white font-medium text-slate-900 ring-1 ring-slate-200 dark:bg-background dark:text-foreground dark:ring-border'
      : // slate-600 on the track clears AA in both themes (the host re-points it in dark).
        'text-slate-600 hover:text-slate-900 dark:hover:text-foreground'
  ].join(' ')

/**
 * A flat tinted group inside the panel (a rule, an entry, a notice). Not the
 * bare bg-slate-50 / bg-slate-100 classes: the admin host re-points those in
 * dark mode to the card colour itself, so the group vanished. The inset
 * hairline keeps it legible in dark without making it a nested card.
 */
export const tintCard =
  'rounded-md bg-[#f6f8fa] ring-1 ring-inset ring-slate-200/70 dark:bg-white/[0.04] dark:ring-white/[0.07]'

/**
 * The one amber of strips that ask for a look (overview findings, the
 * environment warning, the editor's rule loops and conflicts): one token pair,
 * light and dark, instead of a hex per strip.
 */
export const amberStrip =
  'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
