/**
 * Session replays → Search (#1374): which recordings opened a record, typed
 * into a field (by NAME — values are never indexed) or touched an element
 * (a selector from the player's inspector, #1372). Reads and writes its query
 * in the URL (?collection=&item=&field=&selector=) so the record page's
 * "Replays of this record" and the inspector can link straight here.
 */
import { useQuery } from '@tanstack/react-query'
import { Clapperboard, ListVideo, Play, Search } from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { ReplayPlayer } from '@/components/replay-player'
import { PlayAll } from '@/components/replay-player/PlayAll'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { api } from '@/lib/api'
import { formatDate, formatFileSize } from '@/lib/utils'
import {
  collectionsFromRecordKeys,
  matchLabel,
  type ReplayHit,
  type ReplaySearchParams,
  readSearchParams,
  SEARCH_PARAM_KEYS,
  searchQueryString,
  spanLabel
} from './search-logic'

/** Playback opens this long before the match. */
const LEAD_MS = 5_000

type KeyRow = { key: string; recordings: number }

function useKeys(kind: 'record' | 'field', q: string) {
  return useQuery({
    queryKey: ['replay-index-keys', kind, q],
    queryFn: () =>
      api
        .get<{ data: KeyRow[] }>('/session-recordings/search/keys', { params: { kind, q } })
        .then((r) => r.data.data),
    staleTime: 60_000
  })
}

export function ReplaySearchTab() {
  const [params, setParams] = useSearchParams()
  const applied = useMemo(() => readSearchParams(params), [params])
  const [draft, setDraft] = useState<ReplaySearchParams>(applied)
  // A link (record page, inspector) can change the query under an open tab.
  useEffect(() => setDraft(applied), [applied])
  const [watching, setWatching] = useState<ReplayHit | null>(null)
  const [playingAll, setPlayingAll] = useState(false)

  const qs = searchQueryString(applied)
  const {
    data: hits = [],
    isFetching,
    isError
  } = useQuery({
    queryKey: ['replay-search', qs],
    queryFn: () =>
      api.get<{ data: ReplayHit[] }>(`/session-recordings/search?${qs}`).then((r) => r.data.data),
    enabled: !!qs
  })

  const { data: recordKeys = [] } = useKeys('record', '')
  const collections = useMemo(
    () => collectionsFromRecordKeys(recordKeys.map((k) => k.key)),
    [recordKeys]
  )
  const { data: fieldKeys = [] } = useKeys('field', draft.field)

  function submit(e: FormEvent) {
    e.preventDefault()
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('tab', 'search')
        next.delete('recording')
        next.delete('t')
        for (const k of SEARCH_PARAM_KEYS) {
          const v = draft[k].trim()
          if (v) next.set(k, v)
          else next.delete(k)
        }
        return next
      },
      { replace: true }
    )
  }

  const set = (k: keyof ReplaySearchParams) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }))
  const draftInvalid = !searchQueryString(draft)

  return (
    <div className='flex-1 overflow-y-auto bg-slate-50 px-6 py-5 dark:bg-background'>
      <form onSubmit={submit} className='flex flex-wrap items-end gap-2'>
        <label htmlFor='replay-search-collection' className='text-[11.5px] text-slate-500'>
          Collection
          <Input
            id='replay-search-collection'
            value={draft.collection}
            onChange={set('collection')}
            list='replay-search-collections'
            placeholder='orders'
            className='mt-1 h-8 w-44 text-[12.5px]'
          />
        </label>
        <datalist id='replay-search-collections'>
          {collections.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <label htmlFor='replay-search-item' className='text-[11.5px] text-slate-500'>
          Record id
          <Input
            id='replay-search-item'
            value={draft.item}
            onChange={set('item')}
            placeholder='1042'
            className='mt-1 h-8 w-40 text-[12.5px]'
          />
        </label>
        <label htmlFor='replay-search-field' className='text-[11.5px] text-slate-500'>
          Field name
          <Input
            id='replay-search-field'
            value={draft.field}
            onChange={set('field')}
            list='replay-search-fields'
            placeholder='due_date'
            className='mt-1 h-8 w-44 text-[12.5px]'
          />
        </label>
        <datalist id='replay-search-fields'>
          {fieldKeys
            .filter((k) => !k.key.includes('.'))
            .map((k) => (
              <option key={k.key} value={k.key} />
            ))}
        </datalist>
        <label htmlFor='replay-search-selector' className='text-[11.5px] text-slate-500'>
          Selector
          <Input
            id='replay-search-selector'
            value={draft.selector}
            onChange={set('selector')}
            placeholder='[data-field="status"] input'
            className='mt-1 h-8 w-64 font-mono text-[12px]'
          />
        </label>
        <Button type='submit' size='sm' className='h-8 gap-1.5' disabled={draftInvalid}>
          <Search className='h-3.5 w-3.5' /> Search
        </Button>
      </form>
      <p className='mt-2 text-[11.5px] text-slate-400'>
        Recordings are indexed as they upload: pages visited, records opened, the <em>names</em> of
        fields typed into (never what was typed) and the elements clicked.
        {applied.item && applied.collection ? null : ' Add a record id to follow one record.'}
      </p>

      <div className='mt-5'>
        {!qs ? (
          <div className='py-10 text-center text-slate-400'>
            <Search className='mx-auto h-6 w-6 opacity-40' />
            <p className='mt-2 text-[12.5px]'>
              Search by collection and record id, by field name or by selector.
            </p>
          </div>
        ) : isError ? (
          <p className='text-[12.5px] text-red-500'>The search failed.</p>
        ) : isFetching && hits.length === 0 ? (
          <p className='text-[12.5px] text-slate-400'>Searching…</p>
        ) : hits.length === 0 ? (
          <p className='text-[12.5px] text-slate-400'>
            No recordings match. Only recordings uploaded since the index was added are searchable,
            and recordings expire with retention.
          </p>
        ) : (
          <>
            <div className='mb-2 flex items-center gap-3'>
              <h3 className='text-[11px] font-semibold uppercase tracking-wider text-slate-400'>
                {hits.length} recording{hits.length === 1 ? '' : 's'}
              </h3>
              {/* #1398 — one record followed across every recording that opened it. */}
              {applied.collection && applied.item && !applied.field && !applied.selector && (
                <Button
                  size='sm'
                  className='h-7 gap-1.5 text-[12px]'
                  onClick={() => setPlayingAll(true)}
                >
                  <ListVideo className='h-3.5 w-3.5' /> Play all
                </Button>
              )}
            </div>
            <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
              {hits.map((hit, i) => (
                <div
                  key={hit.id}
                  className={`flex items-center gap-3 px-4 py-2 hover:bg-slate-50 dark:hover:bg-muted/40 ${i > 0 ? 'border-t border-slate-100 dark:border-border/50' : ''}`}
                >
                  <span className='w-40 shrink-0 truncate text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                    {hit.user_name || hit.user?.slice(0, 8) || 'Unknown'}
                  </span>
                  <span className='w-28 shrink-0 text-[11.5px] tabular-nums text-slate-500'>
                    {formatDate(new Date(hit.first_ms))} · {spanLabel(hit.first_ms, hit.last_ms)}
                  </span>
                  <span className='shrink-0 rounded border border-slate-200 px-1.5 py-px text-[10.5px] text-slate-500 dark:border-border'>
                    {hit.app ?? 'admin'}
                  </span>
                  <span className='flex min-w-0 flex-1 flex-wrap gap-1'>
                    {hit.matches.slice(0, 3).map((m) => (
                      <span
                        key={`${m.kind}:${m.key}`}
                        className='max-w-[280px] truncate rounded bg-accent px-1.5 py-px font-mono text-[10.5px] text-nvr-navy dark:text-nvr-cyan'
                        title={matchLabel(m)}
                      >
                        {matchLabel(m)}
                      </span>
                    ))}
                    {hit.matches.length > 3 && (
                      <span className='text-[10.5px] text-slate-400'>
                        +{hit.matches.length - 3}
                      </span>
                    )}
                  </span>
                  <span className='shrink-0 text-[11px] text-slate-400'>
                    {formatFileSize(hit.byte_size)}
                  </span>
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-7 gap-1.5 text-[12px]'
                    onClick={() => setWatching(hit)}
                  >
                    <Play className='h-3 w-3' /> Watch
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <Sheet open={!!watching} onOpenChange={(o) => !o && setWatching(null)}>
        <SheetContent className='w-[85%] overflow-y-auto sm:max-w-[85%]'>
          <SheetHeader>
            <SheetTitle className='flex items-center gap-2 text-[15px]'>
              <Clapperboard className='h-4 w-4 text-nvr-cyan' />
              {watching?.user_name || 'Session'}
              <span className='text-[12px] font-normal text-slate-400'>
                {watching &&
                  `${formatDate(new Date(watching.first_ms))} · ${spanLabel(watching.first_ms, watching.last_ms)}`}
              </span>
            </SheetTitle>
          </SheetHeader>
          {watching && (
            <ReplayPlayer
              key={watching.id}
              recordingId={watching.id}
              span={{ from: watching.first_ms - LEAD_MS }}
            />
          )}
        </SheetContent>
      </Sheet>

      <Sheet open={playingAll} onOpenChange={setPlayingAll}>
        <SheetContent className='w-[85%] overflow-y-auto sm:max-w-[85%]'>
          <SheetHeader>
            <SheetTitle className='flex items-center gap-2 text-[15px]'>
              <ListVideo className='h-4 w-4 text-nvr-cyan' />
              {applied.collection}/{applied.item} across {hits.length} recording
              {hits.length === 1 ? '' : 's'}
            </SheetTitle>
          </SheetHeader>
          {playingAll && (
            <PlayAll collection={applied.collection} item={applied.item} visits={hits} />
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
