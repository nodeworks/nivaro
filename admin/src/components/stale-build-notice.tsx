import { subscribeUnsavedWork, unsavedWorkLabels } from '@nivaro/shared'
import { RefreshCw } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'

/** The id the "Nivaro was updated" toasts share (main.tsx), so the notice can replace them. */
export const STALE_BUILD_TOAST = 'nvr-stale-build'

const unsavedKey = () => unsavedWorkLabels().join('\n')

/**
 * Shown in place of a screen whose code could not be loaded because this tab runs a build
 * the server no longer serves (a deploy happened while it was open) and a reload could not
 * fix it by itself: it was just tried, or the tab holds unsaved work. The rest of the page
 * stays as it is, so nothing typed is lost; the person reloads when they are ready.
 *
 * Laid out like the other page states (ErrorSurface) with the neutral tint: nothing broke.
 */
export function StaleBuildNotice() {
  const unsaved = useSyncExternalStore(subscribeUnsavedWork, unsavedKey, () => '')
  // The same thing is not said twice: the toast was for failures with no screen to say it.
  useEffect(() => {
    toast.dismiss(STALE_BUILD_TOAST)
  }, [])
  const waiting = unsaved ? unsaved.split('\n') : []
  return (
    <div
      role='status'
      data-stale-build-notice
      className='nvr-rise-in flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center'
    >
      <div className='flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-muted dark:text-muted-foreground'>
        <RefreshCw className='h-6 w-6' aria-hidden />
      </div>
      <p className='text-[15px] font-semibold text-slate-900 dark:text-foreground'>
        Nivaro was updated
      </p>
      <p className='max-w-[440px] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        {waiting.length > 0
          ? 'This page needs the new version. Save your work first, then reload.'
          : 'This page needs the new version. Reload to open it.'}
      </p>
      {waiting.length > 0 && (
        <p className='max-w-[520px] text-[12.5px] text-slate-600 dark:text-muted-foreground'>
          Not saved yet: {waiting.join(', ')}
        </p>
      )}
      <div className='mt-1'>
        <button
          type='button'
          onClick={() => window.location.reload()}
          className='rounded-md bg-nvr-cyan px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background'
        >
          Reload
        </button>
      </div>
    </div>
  )
}
