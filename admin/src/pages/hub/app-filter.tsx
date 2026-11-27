import { X } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { ghostButton } from './hub-parts'

/**
 * One app at a time on a Hub page that otherwise shows every app: `?app=<id>` in the URL, so the
 * links on an app's page ("Releases", "Incidents", "On-call", "Costs") open on that app and can
 * be shared. The page narrows what it lists; the note says so and takes the filter off.
 */
export function useAppFilter(): { appId: number | null; clear: () => void } {
  const [params, setParams] = useSearchParams()
  const raw = params.get('app')
  const appId = raw && /^\d+$/.test(raw) ? Number(raw) : null
  const clear = () =>
    setParams(
      (p) => {
        const out = new URLSearchParams(p)
        out.delete('app')
        return out
      },
      { replace: true }
    )
  return { appId, clear }
}

/** "Showing Orders portal only · Show every app". Nothing without a filter. */
export function AppFilterNote({
  name,
  onClear,
  className
}: {
  /** The app's name; null = the id in the URL is not an app this person can see. */
  name: string | null
  onClear: () => void
  className?: string
}) {
  return (
    <p
      role='status'
      className={`m-0 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] text-slate-700 dark:border-border dark:bg-card dark:text-slate-200 ${className ?? ''}`}
    >
      <span className='min-w-0 flex-1'>
        {name ? (
          <>
            Showing <span className='font-medium text-slate-900 dark:text-foreground'>{name}</span>{' '}
            only.
          </>
        ) : (
          'That app is not one you can see here.'
        )}
      </span>
      <button type='button' className={ghostButton} onClick={onClear}>
        <X className='h-3.5 w-3.5' aria-hidden /> Show every app
      </button>
    </p>
  )
}
