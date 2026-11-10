import { cn } from '../../lib/utils'

/** The cap the API enforces (api services/sign-out-note.ts). */
export const SIGN_OUT_MESSAGE_MAX = 280

/**
 * The optional message an administrator leaves when signing someone out — the
 * person sees it, large, on their sign-in page (SignOutNoteBanner). Shown once
 * Sign out is armed; Enter confirms.
 */
export function SignOutMessageInput({
  value,
  onChange,
  onSubmit,
  className
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  className?: string
}) {
  const left = SIGN_OUT_MESSAGE_MAX - value.length
  return (
    <div className={cn('space-y-1', className)} data-sign-out-message>
      <input
        // biome-ignore lint/a11y/noAutofocus: it appears because the admin just armed Sign out
        autoFocus
        type='text'
        value={value}
        maxLength={SIGN_OUT_MESSAGE_MAX}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSubmit()
          }
        }}
        aria-label='Message for them (optional)'
        placeholder='Message for them (optional) — shown on their sign-in page'
        className='h-8 w-full rounded-md border border-slate-300 bg-white px-2.5 text-[12px] text-slate-900 placeholder:text-slate-400 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20 dark:border-border dark:bg-background dark:text-slate-100 dark:placeholder:text-slate-500'
      />
      {left <= 40 && (
        <p className='text-right text-[10.5px] tabular-nums text-slate-500 dark:text-slate-400'>
          {left} left
        </p>
      )}
    </div>
  )
}
