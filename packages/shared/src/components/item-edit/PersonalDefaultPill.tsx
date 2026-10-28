import { Undo2, UserRound } from 'lucide-react'

// "Your default" marker on a field a personal default prefilled (spec "Applying on a new
// record" 7). Same size and tone as the document-autofill "derived" pill (sky tint, 10.5px);
// the undo control is always visible (no hover reveal), so the label row never shifts. Its glyph
// box is 16px; an invisible ::before reaches 4px further on every side (24×24 hit area).

export function PersonalDefaultPill({
  field,
  label,
  onUndo
}: {
  field: string
  label?: string
  onUndo: () => void
}) {
  return (
    <span
      data-personal-default={field}
      data-tip='Prefilled from your saved default · Undo'
      className='inline-flex h-5 items-center gap-1 rounded bg-sky-50 pl-1.5 pr-0.5 text-[10.5px] font-medium text-sky-800 dark:bg-sky-900/30 dark:text-sky-200'
    >
      <UserRound className='h-3 w-3' aria-hidden />
      Your default
      <button
        type='button'
        onClick={onUndo}
        aria-label={label ? `Undo your default for ${label}` : 'Undo your default'}
        data-personal-default-undo={field}
        className='relative inline-flex h-4 w-4 items-center justify-center rounded text-sky-700 before:absolute before:-inset-1 before:content-[""] transition-colors duration-150 hover:bg-sky-100 hover:text-sky-900 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-nvr-cyan dark:text-sky-300 dark:hover:bg-sky-800/50 dark:hover:text-white'
      >
        <Undo2 className='h-3 w-3' aria-hidden />
      </button>
    </span>
  )
}

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
