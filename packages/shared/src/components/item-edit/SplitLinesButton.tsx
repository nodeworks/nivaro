import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Split } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useItemNavigation, useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { toastError } from '../../lib/error-toast'
import {
  canOfferLineSplit,
  lineSplitBlocker,
  lineSplitKey,
  lineSplitPath
} from '../../lib/line-split'
import { fetchCollectionMeta, queryKeys } from '../../lib/query-keys'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

interface SplitAnswer {
  data: { id: string | number; readable: boolean; moved: number; link_failures?: string[] }
}

/** The record's own word for itself ("request"), else "record". */
function nounOf(meta: Record<string, unknown> | undefined): string {
  const s = typeof meta?.singular === 'string' ? meta.singular.trim() : ''
  return s ? s.toLowerCase() : 'record'
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * "Move N to a new record…" on a line grid's selection bar (idea 4): the ticked
 * lines leave this record for a new one with the same details. Shown only when
 * the parent collection turns splitting on for this line list
 * (`browser_config.line_split`); the server judges the rest (who may change
 * the record, its locks) and answers in plain words.
 */
export function SplitLinesButton({
  parentCollection,
  parentId,
  lineCollection,
  linkField,
  selectedIds,
  selectedUnsaved,
  totalSaved,
  unsavedEdits,
  onMoved
}: {
  parentCollection: string
  parentId: string
  lineCollection: string
  linkField: string
  /** Saved lines ticked (their ids). */
  selectedIds: string[]
  /** Ticked lines not saved yet (they cannot move). */
  selectedUnsaved: number
  /** Saved lines on the record. */
  totalSaved: number
  /** The grid holds line edits that are not saved. */
  unsavedEdits: boolean
  onMoved: (moved: string[]) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { open: openItem } = useItemNavigation()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const { data: meta } = useQuery({
    queryKey: queryKeys.collectionMeta(parentCollection),
    queryFn: () => fetchCollectionMeta(client, parentCollection),
    staleTime: 10 * 60_000
  })
  if (!meta || !canOfferLineSplit(meta.browser_config, lineCollection, linkField)) return null

  const noun = nounOf(meta)
  const n = selectedIds.length + selectedUnsaved
  const blocker = lineSplitBlocker({
    selectedSaved: selectedIds.length,
    selectedUnsaved,
    totalSaved,
    unsavedEdits
  })
  const staying = Math.max(0, totalSaved - selectedIds.length)

  const run = async () => {
    setBusy(true)
    try {
      const res = await client.request<SplitAnswer>(
        post(lineSplitPath(parentCollection, parentId), {
          relation: lineSplitKey(lineCollection, linkField),
          line_ids: selectedIds
        })
      )
      const made = res.data
      setOpen(false)
      onMoved(selectedIds)
      qc.invalidateQueries({ queryKey: ['o2m-rows', lineCollection, linkField, parentId] })
      qc.invalidateQueries({ queryKey: ['comments-related'] })
      const where = `a new ${noun}`
      toast.success(`Moved ${plural(made.moved, 'line')} to ${where}`, {
        description:
          (made.link_failures?.length ?? 0) > 0
            ? 'Some linked values did not copy — check the new one.'
            : `Both now say where the lines went.`,
        duration: 10_000,
        ...(made.readable
          ? {
              action: {
                label: `Open the new ${noun}`,
                onClick: () => openItem({ collection: parentCollection, itemId: String(made.id) })
              }
            }
          : {})
      })
    } catch (err) {
      toastError(err, 'The lines could not be moved')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-split-lines
          data-tip={`Move the ticked lines to a new ${noun} with the same details`}
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded border px-2 font-medium transition-colors',
            open
              ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-cyan'
              : 'border-slate-200 text-slate-700 hover:border-nvr-cyan hover:text-nvr-cyan dark:border-border dark:text-slate-200'
          )}
        >
          <Split className='h-3 w-3 rotate-90' aria-hidden='true' />
          Move {n} to a new {noun}…
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-[320px] max-w-[calc(100vw-2rem)] p-0'
        data-split-lines-panel
      >
        <div className='space-y-2 p-3'>
          <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
            Move {plural(n, 'line')} to a new {noun}
          </p>
          <ul className='space-y-1 text-[12px] leading-snug text-slate-600 dark:text-muted-foreground'>
            <li>A new {noun} is made with this one’s details and starts at the first step.</li>
            <li>
              The ticked {n === 1 ? 'line moves' : 'lines move'} with {n === 1 ? 'its' : 'their'}{' '}
              history. {staying > 0 ? `${plural(staying, 'line')} stay here.` : ''}
            </li>
            <li>Both {noun}s get a note naming the other.</li>
          </ul>
          {blocker && (
            <p
              className='rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[12px] text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200'
              data-split-lines-blocker
            >
              {blocker}
            </p>
          )}
        </div>
        <div className='flex justify-end gap-2 border-t border-slate-100 px-3 py-2 dark:border-border'>
          <button
            type='button'
            onClick={() => setOpen(false)}
            disabled={busy}
            className='h-7 px-2 text-[12px] text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
          >
            Cancel
          </button>
          <button
            type='button'
            onClick={() => void run()}
            disabled={busy || !!blocker}
            data-split-lines-confirm
            className='inline-flex h-7 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white disabled:opacity-50'
          >
            {busy && <Loader2 className='h-3 w-3 animate-spin' aria-hidden='true' />}
            {busy ? 'Moving…' : `Move ${plural(n, 'line')}`}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
