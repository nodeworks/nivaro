import { useQuery } from '@tanstack/react-query'
import { Check, GitMerge, Loader2, Search, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { useDebounced } from '../../hooks/useDebounced'
import { get, post } from '../../lib/commands'
import { toastError } from '../../lib/error-toast'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { type MergeDoneInfo, MergeRecordsDialog } from './MergeRecordsDialog'

/**
 * "Merge with…" from a record's ⋯ menu: pick the other records (likely duplicates first,
 * then search), then the merge screen with this record preferred as the one to keep. And
 * "Undo merge" for 24 hours after a merge into this record.
 *
 * The menu items only flip state the form owns; `MergeWithFlow` (the dialogs) is mounted
 * by the form outside the menu, so a folded menu closing never unmounts them.
 */

export interface MergeAllowed {
  allowed: boolean
  may_merge: boolean
  noun: string
  plural: string
  undo: { merge_id: string; until: string; discarded: string[] } | null
}

export const mergeAllowedKey = (collection: string, item: string | null | undefined) => [
  'record-merge-allowed',
  collection,
  item ? String(item) : ''
]

export function useMergeAllowed(
  collection: string | null | undefined,
  item: string | number | null | undefined,
  enabled = true
) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: mergeAllowedKey(collection ?? '', item != null ? String(item) : null),
    enabled: enabled && !!collection,
    staleTime: 60_000,
    retry: false,
    queryFn: () =>
      client
        .request<{ data: MergeAllowed }>(
          get(`/record-merge/${collection}/allowed`, item != null ? { item: String(item) } : {})
        )
        .then((r) => r.data)
        .catch(() => null)
  })
}

/** The ⋯ menu entries ("Merge with…", "Undo merge"); renders nothing where merging is off. */
export function MergeRecordMenuItems({
  collection,
  itemId,
  onMergeWith,
  onUndone
}: {
  collection: string
  itemId: string | number
  onMergeWith: () => void
  onUndone?: () => void
}) {
  const client = useNivaroClient()
  const allowed = useMergeAllowed(collection, itemId)
  const [undoing, setUndoing] = useState(false)
  const a = allowed.data
  if (!a?.allowed) return null
  return (
    <>
      {a.may_merge && (
        <Button
          type='button'
          variant='outline'
          size='sm'
          data-nvr-menu-close
          onClick={onMergeWith}
          className='gap-1.5'
          data-merge-with-open
          data-tip={`Combine this ${a.noun} with duplicates: pick each value, keep one record`}
        >
          <GitMerge className='h-3.5 w-3.5' />
          Merge with…
        </Button>
      )}
      {a.undo && (
        <Button
          type='button'
          variant='outline'
          size='sm'
          className='gap-1.5'
          disabled={undoing}
          data-merge-undo-menu
          data-tip={`Bring back ${a.undo.discarded.join(', ')} and put this record’s values back`}
          onClick={async () => {
            setUndoing(true)
            try {
              await client.request(post(`/record-merge/undo/${a.undo?.merge_id}`, {}))
              toast.success('Merge undone')
              await allowed.refetch()
              onUndone?.()
            } catch (err) {
              toastError(err, 'Could not undo the merge')
            } finally {
              setUndoing(false)
            }
          }}
        >
          {undoing ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            <Undo2 className='h-3.5 w-3.5' />
          )}
          Undo merge
        </Button>
      )}
    </>
  )
}

interface Candidate {
  id: string
  label: string
  match: 'exact' | 'close' | 'search'
}

/** The picker, then the merge screen. */
export function MergeWithFlow({
  collection,
  itemId,
  itemLabel,
  open,
  onOpenChange,
  onMerged
}: {
  collection: string
  itemId: string | number
  itemLabel?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onMerged?: (info: MergeDoneInfo) => void
}) {
  const [picked, setPicked] = useState<string[] | null>(null)
  return (
    <>
      <MergePicker
        collection={collection}
        itemId={String(itemId)}
        itemLabel={itemLabel ?? null}
        open={open && picked == null}
        onOpenChange={(o) => {
          if (!o) onOpenChange(false)
        }}
        onContinue={(ids) => setPicked(ids)}
      />
      {picked && (
        <MergeRecordsDialog
          collection={collection}
          ids={[String(itemId), ...picked]}
          preferredSurvivor={String(itemId)}
          open={open && picked != null}
          onOpenChange={(o) => {
            if (!o) {
              setPicked(null)
              onOpenChange(false)
            }
          }}
          onMerged={onMerged}
        />
      )}
    </>
  )
}

const MATCH_WORDS: Record<Candidate['match'], string> = {
  exact: 'Looks the same',
  close: 'Similar',
  search: ''
}

export function MergePicker({
  collection,
  itemId,
  itemLabel,
  open,
  onOpenChange,
  onContinue
}: {
  collection: string
  itemId: string
  itemLabel: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onContinue: (ids: string[]) => void
}) {
  const client = useNivaroClient()
  const allowed = useMergeAllowed(collection, itemId, open)
  const [q, setQ] = useState('')
  const [chosen, setChosen] = useState<Candidate[]>([])
  const settled = useDebounced(q.trim(), 250)
  const cand = useQuery({
    queryKey: ['record-merge-candidates', collection, itemId, settled],
    enabled: open,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: () =>
      client
        .request<{ data: { self: string | null; likely: Candidate[]; results: Candidate[] } }>(
          get(`/record-merge/${collection}/candidates`, { of: itemId, q: settled })
        )
        .then((r) => r.data)
  })
  const max = 4
  const noun = allowed.data?.noun ?? 'record'
  const plural = allowed.data?.plural ?? 'records'
  const toggle = (c: Candidate) =>
    setChosen((prev) =>
      prev.some((x) => x.id === c.id)
        ? prev.filter((x) => x.id !== c.id)
        : prev.length >= max
          ? prev
          : [...prev, c]
    )
  const likely = cand.data?.likely ?? []
  const results = (cand.data?.results ?? []).filter((r) => !likely.some((l) => l.id === r.id))

  const row = (c: Candidate) => {
    const on = chosen.some((x) => x.id === c.id)
    const full = !on && chosen.length >= max
    return (
      <li key={c.id}>
        {/* biome-ignore lint/a11y/useSemanticElements: a whole-row toggle with its own drawn box */}
        <button
          type='button'
          role='checkbox'
          aria-checked={on}
          disabled={full}
          onClick={() => toggle(c)}
          className={cn(
            'flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-40',
            on ? 'bg-nvr-cyan/[0.08]' : 'hover:bg-slate-50 dark:hover:bg-muted/50'
          )}
          data-merge-candidate={c.id}
        >
          <span
            className={cn(
              'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
              on
                ? 'border-nvr-cyan bg-nvr-cyan text-white'
                : 'border-slate-300 bg-white dark:border-border dark:bg-card'
            )}
            aria-hidden
          >
            {on && <Check className='h-3 w-3' strokeWidth={3} />}
          </span>
          <span className='min-w-0 flex-1 truncate text-[13px] text-slate-800 dark:text-foreground'>
            {c.label}
          </span>
          {MATCH_WORDS[c.match] && (
            <span
              className={cn(
                'shrink-0 text-[11px] font-medium',
                c.match === 'exact'
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-slate-500 dark:text-muted-foreground'
              )}
            >
              {MATCH_WORDS[c.match]}
            </span>
          )}
        </button>
      </li>
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setQ('')
          setChosen([])
        }
        onOpenChange(o)
      }}
    >
      <DialogContent
        className='flex max-h-[min(80vh,640px)] w-[min(34rem,96vw)] max-w-none flex-col overflow-hidden p-0 dark:bg-card max-sm:h-[100dvh] max-sm:max-h-none max-sm:w-screen max-sm:rounded-none'
        data-merge-picker
      >
        <div className='shrink-0 px-5 pb-3 pt-5 pr-12'>
          <DialogTitle className='flex min-w-0 items-center gap-2 text-[15px] font-semibold text-slate-900 dark:text-foreground'>
            <GitMerge className='h-4 w-4 shrink-0 text-nvr-cyan' aria-hidden />
            <span className='truncate'>
              Merge {cand.data?.self ?? itemLabel ?? `this ${noun}`} with…
            </span>
          </DialogTitle>
          <DialogDescription className='mt-1 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            Pick up to {max} {plural} that are the same thing. Next you choose each value and which
            record to keep.
          </DialogDescription>
          <div className='relative mt-3'>
            <Search
              className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400'
              aria-hidden
            />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${plural}`}
              aria-label={`Search ${plural}`}
              className='h-9 pl-8 text-[13px]'
            />
          </div>
        </div>
        <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3'>
          {cand.isLoading ? (
            <div className='flex items-center gap-2 px-2.5 py-6 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden />
              Looking for likely duplicates…
            </div>
          ) : (
            <>
              {likely.length > 0 && (
                <section aria-label='Likely duplicates'>
                  <h3 className='px-2.5 pb-1 pt-2 text-[11.5px] font-semibold text-slate-500 dark:text-muted-foreground'>
                    Likely duplicates
                  </h3>
                  <ul>{likely.map(row)}</ul>
                </section>
              )}
              {results.length > 0 && (
                <section aria-label='Search results'>
                  <h3 className='px-2.5 pb-1 pt-3 text-[11.5px] font-semibold text-slate-500 dark:text-muted-foreground'>
                    {settled ? `Matching “${settled}”` : 'Results'}
                  </h3>
                  <ul>{results.map(row)}</ul>
                </section>
              )}
              {likely.length === 0 && results.length === 0 && (
                <p className='px-2.5 py-6 text-[12.5px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
                  {settled
                    ? `No ${plural} match “${settled}”.`
                    : `No likely duplicates found. Search for the ${plural} to merge with.`}
                </p>
              )}
            </>
          )}
        </div>
        <div className='flex shrink-0 items-center gap-3 border-t border-slate-200 bg-slate-50/80 px-5 py-3 dark:border-border dark:bg-muted/30'>
          <span className='min-w-0 flex-1 truncate text-[12.5px] text-slate-600 dark:text-muted-foreground'>
            {chosen.length === 0
              ? 'None picked yet'
              : `${chosen.length} picked: ${chosen.map((c) => c.label).join(', ')}`}
          </span>
          <Button type='button' variant='ghost' size='sm' onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type='button'
            size='sm'
            disabled={chosen.length === 0}
            className='bg-nvr-cyan text-white hover:bg-nvr-cyan-dark'
            onClick={() => {
              onContinue(chosen.map((c) => c.id))
              setChosen([])
              setQ('')
            }}
            data-merge-picker-continue
          >
            Continue
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
