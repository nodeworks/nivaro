import { UserRound } from 'lucide-react'

// Small personal-default pieces shared by the field menu's confirm and My defaults. The
// "Your default" marker itself lives in PersonalDefaultControl (one control per field).

/** The quiet Cancel shared by My defaults' Save / Cancel and the field menu's confirm. */
export const PERSONAL_DEFAULT_GHOST_BUTTON =
  'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-slate-500 transition-colors hover:bg-muted hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:text-slate-400 dark:hover:text-slate-100'

/** Why a saved default was not applied ("Your default is for Zone 2"). Quiet, under the field. */
export function PersonalDefaultHint({ field, text }: { field: string; text: string }) {
  return (
    <p
      data-personal-default-hint={field}
      className='flex items-start gap-1 text-[11.5px] leading-snug text-slate-500 dark:text-slate-400'
    >
      <UserRound className='mt-0.5 h-3 w-3 shrink-0' aria-hidden />
      <span>{text}</span>
    </p>
  )
}
