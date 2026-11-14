import { Eye } from 'lucide-react'
import { useState } from 'react'
import { useItemEditAuth } from '../context'
import { toastError } from '../lib/error-toast'
import { cn } from '../lib/utils'
import { canViewAs, viewAs, viewAsPath } from '../lib/view-as'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/**
 * "See this record as <person>" (Rob 2026-11-13) — an administrator's door
 * into the real View-as, opened on THIS page in a new tab as that person.
 * View-as is the person: whatever is done in that tab is done as them (the
 * server stores the administrator beside it, shown to administrators only),
 * so the door says so before it opens (an anchored confirm, never a native
 * dialog). Shown to administrators only, and only where the host app can
 * open itself as someone else (registerViewAsOpener). Starting it is logged
 * by the server under the admin's name; this component writes nothing.
 */
export function ViewAsPersonButton({
  person,
  path,
  variant = 'icon',
  className
}: {
  person: { id: string; name: string; firstName?: string | null }
  /** The page the tab opens on; the current page when absent. */
  path?: string
  /** icon = a small eye beside a name (owner rows); text = a labelled button. */
  variant?: 'icon' | 'text'
  className?: string
}) {
  const { isAdmin } = useItemEditAuth()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!isAdmin || !canViewAs() || !person.id) return null
  const first = (person.firstName || person.name.split(' ')[0] || person.name).trim()
  const label = `View as ${person.name}`
  const go = async () => {
    setBusy(true)
    try {
      await viewAs({ id: person.id, name: person.name, path: viewAsPath(path) ?? undefined })
      setOpen(false)
    } catch (err) {
      toastError(err, `Could not open this record as ${first}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {variant === 'icon' ? (
          <button
            type='button'
            data-view-as-person={person.id}
            aria-label={`See this record as ${person.name}`}
            data-tip={`See this record as ${person.name}`}
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-amber-50 hover:text-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-amber-500/10 dark:hover:text-amber-300',
              className
            )}
          >
            <Eye className='h-3.5 w-3.5' />
          </button>
        ) : (
          <button
            type='button'
            data-view-as-person={person.id}
            className={cn(
              'inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-amber-300 px-2 text-[11.5px] font-medium text-amber-800 transition-colors hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-amber-500/40 dark:text-amber-200 dark:hover:bg-amber-500/10',
              className
            )}
          >
            <Eye className='h-3.5 w-3.5' />
            Open as {first}…
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align='end'
        sideOffset={6}
        className='w-72 p-3'
        data-view-as-person-confirm={person.id}
      >
        <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>{label}</p>
        <p className='mt-1 text-[12px] leading-snug text-slate-600 dark:text-muted-foreground'>
          Opens this page as {first}, exactly as {first} sees it. Anything you change is done as{' '}
          {first}; admins can see it was you.
        </p>
        <div className='mt-3 flex justify-end gap-2'>
          <button
            type='button'
            onClick={() => setOpen(false)}
            className='h-7 rounded-md px-2.5 text-[12px] font-medium text-slate-600 transition-colors hover:bg-muted dark:text-slate-300'
          >
            Cancel
          </button>
          <button
            type='button'
            disabled={busy}
            onClick={() => void go()}
            data-view-as-person-open
            className='h-7 rounded-md bg-amber-700 px-2.5 text-[12px] font-semibold text-white transition-colors hover:bg-amber-800 disabled:opacity-60 dark:bg-amber-400 dark:text-amber-950 dark:hover:bg-amber-300'
          >
            Open as {first}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
