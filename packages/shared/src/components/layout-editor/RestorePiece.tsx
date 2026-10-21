import { useQuery } from '@tanstack/react-query'
import { Puzzle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import type { LayoutBundle, LayoutOp } from '../../lib/layout-ops'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Skeleton } from '../ui/skeleton'
import { fetchVersionBundle } from './history-api'
import { type PieceOption, restorablePieces } from './restore-piece'

/**
 * "Piece" on a History version (#2716): an anchored list of the sections and
 * fields that differ between that version and the form now, each restored on
 * its own as one undoable change (one unsaved step, or one autosave batch) —
 * never a whole rollback.
 */
export function RestorePieceButton({
  layoutId,
  version,
  bundle,
  onApply,
  fieldLabel,
  onDone,
  className
}: {
  layoutId: number
  version: { id: number; version: number; name?: string | null }
  /** The editor's draft: what the piece is restored into. */
  bundle: LayoutBundle
  onApply: (ops: LayoutOp[], label: string) => void
  fieldLabel?: (field: string) => string
  /** After a restore: the host closes History so the change is seen on the canvas. */
  onDone?: () => void
  className?: string
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const vLabel = version.name ? `“${version.name}” (v${version.version})` : `v${version.version}`
  const {
    data: from,
    isLoading,
    error
  } = useQuery({
    queryKey: ['layout-editor', 'version-bundle', layoutId, version.id],
    queryFn: () => fetchVersionBundle(client, layoutId, version.id),
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false
  })
  const pieces = useMemo(
    () => (from ? restorablePieces(bundle, from, fieldLabel) : []),
    [bundle, from, fieldLabel]
  )
  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? pieces.filter((p) => `${p.label} ${p.where ?? ''}`.toLowerCase().includes(needle))
    : pieces
  const sections = shown.filter((p) => p.piece.kind === 'group')
  const fields = shown.filter((p) => p.piece.kind === 'field')

  const restore = (p: PieceOption) => {
    const what = p.piece.kind === 'group' ? `section ${p.label}` : p.label
    onApply(p.ops, `Restore ${what} from ${vLabel}`)
    toast.success(`${p.label} restored from ${vLabel} as one change (undo with ⌘Z)`)
    setOpen(false)
    setFilter('')
    onDone?.()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-restore-piece={version.id}
          data-tip='Bring back one section or field from this version, as one undoable change'
          className={cn(className, open && 'border-nvr-cyan text-nvr-navy dark:text-nvr-cyan')}
        >
          Piece
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='flex max-h-[min(60vh,520px)] w-[380px] flex-col gap-2 overflow-hidden p-3'
        data-restore-piece-popover=''
      >
        <div className='flex items-center justify-between gap-2'>
          <p className='m-0 text-[12px] font-semibold text-slate-700 dark:text-foreground'>
            Restore a piece of {vLabel}
          </p>
          <Puzzle className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-muted-foreground' />
        </div>
        <p className='m-0 text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'>
          Only what differs from the form now. The rest of the form stays as it is.
        </p>
        {pieces.length > 8 && (
          <input
            aria-label='Find a section or field'
            value={filter}
            placeholder='Find a section or field…'
            onChange={(e) => setFilter(e.target.value)}
            className='h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-800 outline-none placeholder:text-slate-500 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'
          />
        )}
        <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain'>
          {isLoading && (
            <div className='space-y-1.5 py-1' data-restore-piece-loading=''>
              <Skeleton className='h-9 w-full' />
              <Skeleton className='h-9 w-full' />
              <Skeleton className='h-9 w-5/6' />
            </div>
          )}
          {error != null && (
            <p className='m-0 py-1 text-[12px] text-[#9c2f47] dark:text-[#f08aa1]'>
              That version could not be read.
            </p>
          )}
          {from && pieces.length === 0 && (
            <p className='m-0 py-1 text-[12px] text-slate-500 dark:text-slate-400'>
              Nothing in {vLabel} differs from the form now.
            </p>
          )}
          {from && pieces.length > 0 && shown.length === 0 && (
            <p className='m-0 py-1 text-[12px] text-slate-500 dark:text-slate-400'>
              Nothing matches “{filter.trim()}”.
            </p>
          )}
          {sections.length > 0 && (
            <PieceGroup title='Sections' rows={sections} onRestore={restore} />
          )}
          {fields.length > 0 && <PieceGroup title='Fields' rows={fields} onRestore={restore} />}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function PieceGroup({
  title,
  rows,
  onRestore
}: {
  title: string
  rows: PieceOption[]
  onRestore: (p: PieceOption) => void
}) {
  return (
    <div className='mb-2 last:mb-0'>
      <p className='m-0 mb-0.5 text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
        {title}
      </p>
      <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border/60'>
        {rows.map((p) => {
          const key =
            p.piece.kind === 'group'
              ? `g:${p.piece.key}`
              : `f:${p.piece.field}:${p.piece.group_key ?? ''}`
          return (
            <li key={key} className='flex items-center gap-2 py-1.5' data-restore-piece-row={key}>
              <span className='min-w-0 flex-1'>
                <span className='flex items-baseline gap-1.5 text-[12.5px] text-slate-800 dark:text-foreground'>
                  <span className='truncate font-medium'>{p.label}</span>
                  {p.where && (
                    <span className='shrink-0 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                      {p.where}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    'block truncate text-[11.5px]',
                    p.error
                      ? 'text-amber-700 dark:text-amber-300'
                      : 'text-slate-500 dark:text-muted-foreground'
                  )}
                  data-tip={p.error ?? p.summary}
                >
                  {p.error ?? p.summary}
                </span>
              </span>
              <button
                type='button'
                disabled={!!p.error}
                onClick={() => onRestore(p)}
                data-restore-piece-apply={key}
                className='inline-flex h-7 shrink-0 items-center rounded-md border border-slate-200 px-2 text-[11.5px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-border dark:text-foreground dark:hover:bg-muted'
              >
                Restore
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
