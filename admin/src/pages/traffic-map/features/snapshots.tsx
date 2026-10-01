import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, Check, Copy, Link2, Trash2 } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../context'
import { register } from '../registry/registry'
import { toolbarItems } from '../registry/toolbarItems'
import type { Filters, Selection, TrafficCatalog, TrafficSnapshot } from '../types'
import { nodeFeed } from './node-merge'

/**
 * #1097 — shareable incident snapshots. "Share" freezes the current view on the server (the
 * window's snapshot — every node when the page shows them combined — plus the labels, filters
 * and selection) and hands back a link; /traffic-map?snapshot=<id> opens it read-only. A note is
 * also written to the Ops Console incident timeline.
 */
export interface FrozenSnapshot {
  id: string
  name: string
  note: string | null
  window_s: number
  scope: string
  node: string | null
  created_at: string
  created_by_name: string | null
  filters: { win?: number; types?: string[]; kinds?: string[]; caller?: string } | null
  selection: Selection | null
  catalog: TrafficCatalog | null
  snapshot: TrafficSnapshot
}
interface SnapshotListRow {
  id: string
  name: string
  note: string | null
  window_s: number
  scope: string
  created_at: string
  created_by_name: string | null
}

/** The snapshot id in the URL (`?snapshot=<id>`), or null on the live page. */
export function useFrozenSnapshotId(): string | null {
  const [params] = useSearchParams()
  const id = params.get('snapshot')
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null
}

export async function loadFrozenSnapshot(id: string): Promise<FrozenSnapshot> {
  const res = await api.get(`/traffic-map/snapshots/${id}`)
  return res.data.data as FrozenSnapshot
}

/** Filters as JSON (Sets do not serialise). */
export function filtersToJson(f: Filters): Record<string, unknown> {
  return { win: f.win, types: [...f.types], kinds: [...f.kinds], caller: f.caller }
}
/** Stored filters back onto the page's (anything missing keeps the current value). */
export function filtersFromJson(cur: Filters, j: FrozenSnapshot['filters']): Filters {
  if (!j) return cur
  const win = j.win === 60 || j.win === 300 || j.win === 900 ? j.win : cur.win
  return {
    win,
    types: Array.isArray(j.types) && j.types.length ? new Set(j.types as never) : cur.types,
    kinds: Array.isArray(j.kinds) && j.kinds.length ? new Set(j.kinds as never) : cur.kinds,
    caller: typeof j.caller === 'string' ? j.caller : cur.caller
  }
}

export function snapshotLink(id: string): string {
  return `${window.location.origin}/traffic-map?snapshot=${id}`
}

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

const BTN =
  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-[3px] text-[12px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tm-card)] disabled:cursor-not-allowed disabled:opacity-60'
const BTN_OFF =
  'border-[var(--tm-line)] bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
const FIELD =
  'w-full rounded-md border border-[var(--tm-line)] bg-[var(--tm-card)] px-2.5 py-1.5 text-[12.5px] text-[var(--tm-fg)] placeholder:text-[var(--tm-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'

let feedVersion = 0
nodeFeed.subscribe(() => {
  feedVersion++
})

export function ShareSnapshot() {
  const { filters, selection, catalog, win } = useTrafficMap()
  const frozen = useFrozenSnapshotId()
  const qc = useQueryClient()
  useSyncExternalStore(
    (cb) => nodeFeed.subscribe(cb),
    () => feedVersion
  )
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<{ id: string; name: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const list = useQuery({
    queryKey: ['traffic-map', 'snapshots'],
    queryFn: async () => (await api.get('/traffic-map/snapshots')).data.data as SnapshotListRow[],
    enabled: open
  })
  if (frozen) return null
  const multi = nodeFeed.nodes().length > 1
  const scope = nodeFeed.scope

  const create = async () => {
    setBusy(true)
    try {
      const res = await api.post('/traffic-map/snapshots', {
        window: win,
        name: name.trim() || undefined,
        note: note.trim() || undefined,
        scope: multi ? 'cluster' : 'node',
        node: scope.mode === 'node' && scope.node !== nodeFeed.self ? scope.node : undefined,
        filters: filtersToJson(filters),
        selection,
        catalog
      })
      setMade(res.data.data)
      setCopied(false)
      setName('')
      setNote('')
      void qc.invalidateQueries({ queryKey: ['traffic-map', 'snapshots'] })
    } catch (e) {
      const r = e as { response?: { data?: { error?: string } } }
      toast.error(r.response?.data?.error ?? 'The snapshot could not be saved')
    } finally {
      setBusy(false)
    }
  }
  const copy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(snapshotLink(id))
      setCopied(true)
    } catch {
      toast.error('Copy failed — select the link and copy it by hand')
    }
  }
  const remove = async (id: string) => {
    try {
      await api.delete(`/traffic-map/snapshots/${id}`)
      void qc.invalidateQueries({ queryKey: ['traffic-map', 'snapshots'] })
      if (made?.id === id) setMade(null)
    } catch {
      toast.error('The snapshot could not be deleted')
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setMade(null)
      }}
    >
      <PopoverTrigger asChild>
        <button type='button' id='tm-share' className={cn(BTN, BTN_OFF)} aria-haspopup='dialog'>
          <Camera className='h-3.5 w-3.5' aria-hidden='true' />
          Share
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='traffic-map w-[340px] border-[var(--tm-line)] bg-[var(--tm-card)] p-0 text-[var(--tm-fg)]'
        data-tm-share=''
      >
        <div className='border-b border-[var(--tm-line-2)] px-3.5 py-2.5'>
          <h3 className='text-[13px] font-semibold'>Share this view</h3>
          <p className='mt-0.5 text-[11.5px] text-[var(--tm-muted)]'>
            Freezes the last {win === 60 ? 'minute' : `${win / 60} minutes`}
            {multi ? (scope.mode === 'all' ? ' across every node' : ` of ${scope.node}`) : ''} into
            a read-only link.
          </p>
        </div>
        {made ? (
          <div className='space-y-2 px-3.5 py-3' data-tm-share-made={made.id}>
            <p className='text-[12.5px]'>
              Saved <span className='font-medium'>{made.name}</span>.
            </p>
            <div className='flex items-center gap-1.5'>
              <input
                readOnly
                value={snapshotLink(made.id)}
                className={cn(FIELD, 'font-mono text-[11.5px]')}
                aria-label='Snapshot link'
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                type='button'
                className={cn(BTN, BTN_OFF, 'shrink-0')}
                onClick={() => void copy(made.id)}
                data-tm-share-copy=''
              >
                {copied ? <Check className='h-3.5 w-3.5' /> : <Copy className='h-3.5 w-3.5' />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        ) : (
          <div className='space-y-2 px-3.5 py-3'>
            <label
              className='block text-[12px] font-medium text-[var(--tm-fg-2)]'
              htmlFor='tm-share-name'
            >
              Name
            </label>
            <input
              id='tm-share-name'
              className={FIELD}
              value={name}
              maxLength={200}
              placeholder='e.g. Forecast spike after the 10:00 import'
              onChange={(e) => setName(e.target.value)}
            />
            <label
              className='block text-[12px] font-medium text-[var(--tm-fg-2)]'
              htmlFor='tm-share-note'
            >
              Note for the incident timeline{' '}
              <span className='font-normal text-[var(--tm-muted)]'>(optional)</span>
            </label>
            <textarea
              id='tm-share-note'
              className={cn(FIELD, 'min-h-[64px] resize-y')}
              value={note}
              maxLength={2000}
              placeholder='What you are seeing — it appears in Ops Console › Incident timeline'
              onChange={(e) => setNote(e.target.value)}
            />
            <div className='flex justify-end pt-0.5'>
              <button
                type='button'
                className={cn(
                  BTN,
                  'border-[color-mix(in_srgb,var(--tm-accent)_55%,var(--tm-line))] bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
                )}
                disabled={busy}
                onClick={() => void create()}
                data-tm-share-create=''
              >
                <Link2 className='h-3.5 w-3.5' aria-hidden='true' />
                {busy ? 'Saving…' : 'Create link'}
              </button>
            </div>
          </div>
        )}
        <div className='border-t border-[var(--tm-line-2)] px-3.5 py-2.5'>
          <h4 className='text-[12px] font-medium text-[var(--tm-muted)]'>Recent snapshots</h4>
          {list.isLoading ? (
            <p className='mt-1 text-[12px] text-[var(--tm-muted)]'>Loading…</p>
          ) : (list.data ?? []).length === 0 ? (
            <p className='mt-1 text-[12px] text-[var(--tm-muted)]'>None yet.</p>
          ) : (
            <ul className='mt-1 max-h-[180px] space-y-0.5 overflow-y-auto'>
              {(list.data ?? []).slice(0, 8).map((s) => (
                <li
                  key={s.id}
                  className='group flex items-center gap-2 text-[12px]'
                  data-tm-snapshot-row={s.id}
                >
                  <Link
                    to={`/traffic-map?snapshot=${s.id}`}
                    onClick={() => setOpen(false)}
                    className='min-w-0 flex-1 truncate rounded px-1 py-0.5 text-[var(--tm-fg)] hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                    title={s.note ?? undefined}
                  >
                    {s.name}
                    <span className='ml-1.5 text-[11px] text-[var(--tm-muted)]'>
                      {when(s.created_at)}
                      {s.created_by_name ? ` · ${s.created_by_name}` : ''}
                    </span>
                  </Link>
                  <button
                    type='button'
                    aria-label={`Delete snapshot ${s.name}`}
                    className='rounded p-1 text-[var(--tm-muted)] hover:bg-[var(--tm-error-soft)] hover:text-[var(--tm-error-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                    onClick={() => void remove(s.id)}
                  >
                    <Trash2 className='h-3.5 w-3.5' aria-hidden='true' />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** The read-only banner above a frozen view. */
export function FrozenBanner({ snap }: { snap: FrozenSnapshot | null }) {
  if (!snap) return null
  const w = snap.window_s === 60 ? '1 minute' : `${snap.window_s / 60} minutes`
  return (
    <div
      role='status'
      id='tm-frozen'
      className='mb-3.5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[color-mix(in_srgb,var(--tm-accent)_45%,var(--tm-line))] bg-[var(--tm-accent-soft)] px-3.5 py-2 text-[12.5px]'
    >
      <div className='min-w-0'>
        <p>
          <span className='font-semibold'>Snapshot: {snap.name}</span>{' '}
          <span className='text-[var(--tm-fg-2)]'>
            · {w} ending {when(snap.snapshot.at)}
            {snap.created_by_name ? ` · shared by ${snap.created_by_name}` : ''}
            {snap.scope === 'cluster' && !snap.node ? ' · every node' : ''}
          </span>
        </p>
        {snap.note && <p className='mt-0.5 max-w-[90ch] text-[var(--tm-fg-2)]'>{snap.note}</p>}
      </div>
      <Link to='/traffic-map' id='tm-frozen-live' className={cn(BTN, BTN_OFF)}>
        Back to live
      </Link>
    </div>
  )
}

register(toolbarItems, {
  id: 'share-snapshot',
  order: 90,
  slot: 'actions',
  Component: ShareSnapshot
})
