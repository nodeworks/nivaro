import { ChevronDown, ListChecks, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * "Changes so far" (#6) — a compact pill beside the Save button ("5 changes")
 * that opens an anchored popover listing every unsaved field and staged line
 * as `label: old → new`, each with its own revert. Lives in the header, never
 * in the form body (a bottom tray took real estate). Per-LAYOUT opt-in
 * (`nivaro_collection_layouts.changes_tray`). The Save button reads it as a
 * checklist: nothing in the list = nothing to save.
 */
export type ChangeKind = 'field' | 'row' | 'edit' | 'delete' | 'link' | 'unlink'

export interface ChangeItem {
  key: string
  kind: ChangeKind
  label: string
  /** Where the change lives (step / grid) — shown muted after the label. */
  location?: string | null
  from?: unknown
  to?: unknown
  /** Free text instead of from → to (staged rows carry a short description). */
  detail?: string
  onRevert: () => void
  onJump?: () => void
  /** A staged line edit broken down per cell, each revertable on its own. */
  cells?: Array<{ field: string; label: string; from: unknown; to: unknown; onRevert: () => void }>
}

const KIND_LABEL: Record<ChangeKind, string> = {
  field: 'Changed',
  row: 'New line',
  edit: 'Line edited',
  delete: 'Line removed',
  link: 'Linked',
  unlink: 'Unlinked'
}

const KIND_DOT: Record<ChangeKind, string> = {
  field: 'bg-amber-400',
  row: 'bg-emerald-500',
  edit: 'bg-amber-400',
  delete: 'bg-red-400',
  link: 'bg-emerald-500',
  unlink: 'bg-red-400'
}

const fmt = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return 'empty'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'object') {
    if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`
    const id = (v as Record<string, unknown>).id
    if (id != null) return `#${String(id)}`
    try {
      const s = JSON.stringify(v)
      return s.length > 40 ? `${s.slice(0, 40)}…` : s
    } catch {
      return String(v)
    }
  }
  const s = String(v)
    .replace(/<[^>]+>/g, '')
    .trim()
  return s.length > 48 ? `${s.slice(0, 48)}…` : s
}

export function ChangesTray({
  items,
  onRevertAll,
  saving
}: {
  items: ChangeItem[]
  onRevertAll?: () => void
  saving?: boolean
}) {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null
  const n = items.length
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-changes-tray
          aria-label={`${n} unsaved change${n === 1 ? '' : 's'} — review`}
          className='inline-flex h-9 shrink-0 items-center gap-1.5 self-center rounded-md border border-amber-300 bg-amber-50 px-3 text-[12px] font-medium leading-none text-amber-900 transition-colors hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100 dark:hover:bg-amber-500/20'
        >
          <ListChecks className='h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300' />
          <span className='tabular-nums'>
            {n} change{n === 1 ? '' : 's'}
          </span>
          <ChevronDown
            className={cn(
              'h-3 w-3 shrink-0 text-amber-500 transition-transform',
              open && 'rotate-180'
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' sideOffset={6} className='w-[440px] max-w-[92vw] p-0'>
        <div className='flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-border'>
          <ListChecks className='h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400' />
          <span className='min-w-0 flex-1 text-[12px] font-semibold text-slate-800 dark:text-slate-100'>
            {n} unsaved change{n === 1 ? '' : 's'}
            <span className='ml-1.5 font-normal text-slate-500 dark:text-slate-400'>
              {saving ? 'saving…' : 'not saved yet'}
            </span>
          </span>
          {onRevertAll && (
            <button
              type='button'
              onClick={onRevertAll}
              disabled={saving}
              className='inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-amber-300 px-2 text-[11px] font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-40 dark:border-amber-500/40 dark:text-amber-200 dark:hover:bg-amber-500/15'
            >
              <RotateCcw className='h-3 w-3' /> Revert all
            </button>
          )}
        </div>
        <ul className='max-h-[320px] divide-y divide-slate-100 overflow-y-auto dark:divide-border'>
          {items.map((it) => (
            <li
              key={it.key}
              className='flex flex-wrap items-center gap-2 px-3 py-1.5 text-[11.5px] text-slate-800 dark:text-slate-100'
            >
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', KIND_DOT[it.kind])} />
              <button
                type='button'
                onClick={() => {
                  it.onJump?.()
                  if (it.onJump) setOpen(false)
                }}
                disabled={!it.onJump}
                className={cn(
                  'min-w-0 flex-1 text-left',
                  it.onJump && 'hover:underline decoration-dotted underline-offset-2'
                )}
              >
                <span className='font-medium'>{it.label}</span>
                {it.location && (
                  <span className='ml-1 text-slate-500 dark:text-slate-400'>· {it.location}</span>
                )}
                <span className='ml-2 block truncate text-slate-600 dark:text-slate-300'>
                  {it.detail ?? (
                    <>
                      <span className='line-through opacity-60'>{fmt(it.from)}</span> →{' '}
                      <span className='font-medium'>{fmt(it.to)}</span>
                    </>
                  )}
                </span>
              </button>
              <span className='shrink-0 rounded bg-slate-100 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-slate-700/60 dark:text-slate-300'>
                {KIND_LABEL[it.kind]}
              </span>
              <button
                type='button'
                onClick={it.onRevert}
                disabled={saving}
                aria-label={`Revert ${it.label}`}
                data-tip='Revert this change'
                className='shrink-0 rounded p-0.5 text-amber-600 hover:bg-amber-50 hover:text-amber-900 disabled:opacity-40 dark:text-amber-300 dark:hover:bg-amber-500/20'
              >
                <RotateCcw className='h-3 w-3' />
              </button>
              {it.cells && it.cells.length > 0 && (
                <ul className='ml-3.5 w-full space-y-0.5 border-l border-slate-200 pl-2 dark:border-border'>
                  {it.cells.map((c) => (
                    <li
                      key={c.field}
                      data-change-cell={c.field}
                      className='flex items-center gap-2 text-[11px] text-slate-700 dark:text-slate-200'
                    >
                      <span className='min-w-0 flex-1 truncate'>
                        <span className='font-medium'>{c.label}</span>
                        <span className='ml-2 text-slate-600 dark:text-slate-300'>
                          <span className='line-through opacity-60'>{fmt(c.from)}</span> →{' '}
                          <span className='font-medium'>{fmt(c.to)}</span>
                        </span>
                      </span>
                      <button
                        type='button'
                        onClick={c.onRevert}
                        disabled={saving}
                        aria-label={`Revert ${it.label} ${c.label}`}
                        data-tip='Revert this cell'
                        className='shrink-0 rounded p-0.5 text-amber-600 hover:bg-amber-50 hover:text-amber-900 disabled:opacity-40 dark:text-amber-300 dark:hover:bg-amber-500/20'
                      >
                        <RotateCcw className='h-2.5 w-2.5' />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
