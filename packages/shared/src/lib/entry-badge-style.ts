import type { BadgeColor } from './entry-config'

/** The form identity badge's colours: a tinted fill, readable text, light and dark. */
const CLASSES: Record<BadgeColor, string> = {
  slate:
    'border border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-700/40 dark:text-slate-200',
  blue: 'border border-blue-300 bg-blue-100 text-blue-800 dark:border-blue-500/50 dark:bg-blue-500/20 dark:text-blue-200',
  cyan: 'border border-cyan-300 bg-cyan-100 text-cyan-800 dark:border-cyan-500/50 dark:bg-cyan-500/20 dark:text-cyan-200',
  emerald:
    'border border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-500/50 dark:bg-emerald-500/20 dark:text-emerald-200',
  amber:
    'border border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-500/50 dark:bg-amber-500/20 dark:text-amber-200',
  orange:
    'border border-orange-300 bg-orange-100 text-orange-800 dark:border-orange-500/50 dark:bg-orange-500/20 dark:text-orange-200',
  rose: 'border border-rose-300 bg-rose-100 text-rose-800 dark:border-rose-500/50 dark:bg-rose-500/20 dark:text-rose-200',
  violet:
    'border border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-500/50 dark:bg-violet-500/20 dark:text-violet-200'
}

export const badgeClasses = (c: BadgeColor): string => CLASSES[c] ?? CLASSES.slate
