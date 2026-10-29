import { ChevronDown, Folder, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { FolderSuggestion } from './folder-suggestions'

const MAX_ROWS = 5

function SuggestionRow({
  s,
  onAccept,
  onDismiss
}: {
  s: FolderSuggestion
  onAccept: (s: FolderSuggestion) => Promise<void>
  onDismiss: (s: FolderSuggestion) => void
}) {
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const n = s.collections.length
  const names = open ? s.collections : s.collections.slice(0, 3)
  const rest = n - names.length

  async function accept() {
    setBusy(true)
    try {
      await onAccept(s)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className='flex items-start gap-3 px-3 py-2.5'>
      <Folder
        className='mt-0.5 h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500'
        style={s.folder.color ? { color: s.folder.color } : undefined}
        aria-hidden
      />
      <div className='min-w-0 flex-1'>
        <div className='text-[13px] text-slate-800 dark:text-foreground'>
          <span className='font-medium'>{s.folder.label}</span>
          <span className='text-slate-500 dark:text-muted-foreground'>
            {' '}
            · Move {n} {n === 1 ? 'collection' : 'collections'}
          </span>
        </div>
        <button
          type='button'
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            'mt-0.5 block max-w-full text-left font-mono text-[11px] text-slate-500 hover:text-slate-700 dark:text-muted-foreground dark:hover:text-foreground',
            !open && 'truncate'
          )}
        >
          {names.join(', ')}
          {rest > 0 ? ` +${rest} more` : ''}
        </button>
        <div className='mt-0.5 text-[11px] text-slate-400 dark:text-slate-500'>{s.reason}</div>
      </div>
      <div className='flex shrink-0 items-center gap-1.5'>
        <Button size='sm' className='h-7 px-2.5 text-[12px]' disabled={busy} onClick={accept}>
          {busy ? <Loader2 className='mr-1 h-3 w-3 animate-spin' /> : null}
          Move
        </Button>
        <Button
          size='sm'
          variant='ghost'
          className='h-7 px-2.5 text-[12px]'
          disabled={busy}
          onClick={() => onDismiss(s)}
        >
          Dismiss
        </Button>
      </div>
    </li>
  )
}

export function FolderSuggestions(props: {
  suggestions: FolderSuggestion[]
  onAccept: (s: FolderSuggestion) => Promise<void>
  onDismiss: (s: FolderSuggestion) => void
}) {
  const { suggestions, onAccept, onDismiss } = props
  const [all, setAll] = useState(false)
  if (suggestions.length === 0) return null
  const shown = all ? suggestions : suggestions.slice(0, MAX_ROWS)
  const hidden = suggestions.length - shown.length

  return (
    <section
      aria-label='Suggested folders'
      className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <h2 className='border-b border-slate-200 px-3 py-2 text-[12px] font-semibold text-slate-600 dark:border-border dark:text-muted-foreground'>
        Suggested folders
      </h2>
      <ul className='divide-y divide-slate-100 dark:divide-border'>
        {shown.map((s) => (
          <SuggestionRow key={s.folder.key} s={s} onAccept={onAccept} onDismiss={onDismiss} />
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type='button'
          onClick={() => setAll(true)}
          className='flex w-full items-center gap-1 border-t border-slate-100 px-3 py-1.5 text-[12px] text-slate-500 hover:bg-slate-50 dark:border-border dark:text-muted-foreground dark:hover:bg-muted'
        >
          <ChevronDown className='h-3 w-3' />
          Show {hidden} more
        </button>
      )}
    </section>
  )
}
