import { useState } from 'react'
import { readMasquerade, stopMasquerade } from '@/lib/masquerade'

/** "David" from "David Pry" (the banner's second mention); "them" when the tab has no name. */
export function viewAsFirstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] || 'them'
}

/** The amber bar of a "View as" tab (#640): who this tab is, and the way out. */
export function ViewAsBar() {
  const m = readMasquerade()
  const [leaving, setLeaving] = useState(false)
  if (!m) return null
  return (
    <div
      data-view-as-bar
      data-nvr-recording-hide='always'
      role='status'
      className='flex shrink-0 items-center gap-3 border-b border-amber-300 bg-amber-100 px-4 py-1.5 text-[12.5px] text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100'
    >
      <span data-view-as-text>
        Viewing as <b>{m.name || 'another person'}</b> — you see and act exactly as{' '}
        {viewAsFirstName(m.name)}. Admins can see changes were made by you.
      </span>
      <button
        type='button'
        data-view-as-stop
        disabled={leaving}
        onClick={() => {
          setLeaving(true)
          void stopMasquerade()
        }}
        className='ml-auto h-7 rounded-md border border-amber-400 px-2.5 text-[12px] font-semibold hover:bg-amber-200 disabled:opacity-60 dark:border-amber-500/50 dark:hover:bg-amber-500/25'
      >
        {leaving ? 'Leaving…' : 'Stop viewing as'}
      </button>
    </div>
  )
}
