import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Bot, Copy, EyeOff, FileUp, Trash2, UploadCloud } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useItemEditAuth, useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import {
  batchTouches,
  LIVE_ASPECTS,
  type LiveBatch,
  useLiveEvent,
  useLiveRecord,
  useLiveRecordEvent
} from '../../lib/live'
import { useOptionalRealtime } from '../../lib/realtime'
import { useRecordTabs, useRecordTabsSignal } from '../../lib/record-tabs'
import { userErrorMessage } from '../../lib/safe-error'
import { formatRelative } from '../../lib/utils'

/** Why an open record can no longer be saved (#1871 deleted, #1925 access). */
export interface RecordGone {
  kind: 'deleted' | 'access'
  by?: string | null
  at?: string | null
  trashId?: number | null
  canRestore?: boolean
}

interface TrashRecordInfo {
  deleted_at?: string
  deleted_by_name?: string | null
  can_restore?: boolean
  trash_id?: number | null
}

interface InstanceHead {
  instance?: { current_state?: string | null } | null
  history?: Array<{
    id: number
    to_state_label?: string | null
    first_name?: string | null
    last_name?: string | null
    user_email?: string | null
    timestamp?: string
  }>
}

/** The import notice lapses this long after the last import write to the record. */
const IMPORT_QUIET_MS = 8_000

/**
 * Query heads that hold one record's data (`[head, collection, id, …]`).
 * Losing access to a record drops every one of them (#1925 / F7): the page
 * must not keep showing — or later re-render from cache — what the person
 * can no longer read.
 */
export const RECORD_QUERY_HEADS = [
  'item',
  'rrv-record',
  'revisions',
  'field-touch',
  'last-touch',
  'comments',
  'comments-related',
  'tasks',
  'addendums',
  'pipeline-instance',
  'pipeline-all-owners',
  'pipeline-instance-owners',
  'pipeline-owners-resolved',
  'approval-brief',
  'erp-submissions',
  'record-integrations',
  'record-integrity'
] as const

/** Remove every cached query about one record (any id spelling). */
export function purgeRecordQueries(
  qc: {
    removeQueries: (f: { predicate: (q: { queryKey: readonly unknown[] }) => boolean }) => void
  },
  collection: string,
  itemId: string | number
): void {
  const heads = new Set<unknown>(RECORD_QUERY_HEADS)
  const id = String(itemId)
  qc.removeQueries({
    predicate: (q) =>
      heads.has(q.queryKey[0]) && q.queryKey[1] === collection && String(q.queryKey[2]) === id
  })
}

/**
 * What a page shows instead of the record once its viewer lost access: the
 * reason and a way back — no fields, no cached values, no unsaved edits.
 */
export function RecordAccessLostPanel({ onBack }: { onBack: () => void }) {
  return (
    <div className='p-6'>
      <div
        data-record-gone='access'
        role='alert'
        className='flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2.5 dark:border-amber-500/40 dark:bg-amber-500/10'
      >
        <EyeOff className='h-4 w-4 shrink-0 text-amber-500' />
        <p className='min-w-0 flex-1 text-[12px] text-amber-800 dark:text-amber-300'>
          <span className='font-semibold'>You no longer have access to this record.</span> A role,
          scope or filter change hid it while you had it open.
        </p>
        <button
          type='button'
          onClick={onBack}
          data-record-gone-back
          className='inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 text-[11.5px] font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-transparent dark:text-amber-300 dark:hover:bg-amber-500/10'
        >
          <ArrowLeft className='h-3.5 w-3.5' />
          Back
        </button>
      </div>
    </div>
  )
}

const httpStatus = (err: unknown): number | undefined =>
  (err as { status?: number })?.status ??
  (err as { response?: { status?: number } })?.response?.status

/**
 * Record-level live sync (#274 state sync, #281 live revision feed, #282
 * upload presence, and the rt-record wave: #1824 transitions, #1870 owners,
 * #1871 deleted, #1873 addendums, #1825 integrations, #1829 integrity,
 * #1869 Summary refresh, #1745 two tabs, #2079 automation, #1925 access).
 * Mounted by ItemEditForm on SAVED records; renders the transient "updated"
 * pill, co-viewer chips and the record banners. All refresh happens through
 * react-query invalidation, so RBAC-checked queries do the actual fetching —
 * the socket only says THAT something moved (lib/live.ts).
 */
export function RecordLiveSync({
  collection,
  itemId,
  dirty = false,
  loadDenied = false,
  onGoneChange
}: {
  collection: string
  itemId: string
  /** The form holds unsaved edits — announced to this record's other tabs. */
  dirty?: boolean
  /** The host's record read just failed 403/404 while it still shows data. */
  loadDenied?: boolean
  /** Deleted / lost access (or back again): the host disables saving. */
  onGoneChange?: (gone: RecordGone | null) => void
}) {
  const realtime = useOptionalRealtime()
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [flash, setFlash] = useState(false)
  const [uploads, setUploads] = useState<Array<{ user: string; name: string }>>([])
  const [gone, setGoneState] = useState<RecordGone | null>(null)
  const [automation, setAutomation] = useState<Record<string, string>>({})
  const [restoring, setRestoring] = useState(false)
  // #1826 — a staged import run is writing this record (the events say `source: 'import'`).
  // Each import write renews the notice; it lapses a few seconds after the run goes quiet.
  const [importing, setImporting] = useState(false)
  const importTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openedAt = useRef(Date.now())
  const lastMoveToast = useRef<number | null>(null)
  const onGoneRef = useRef(onGoneChange)
  onGoneRef.current = onGoneChange
  const goneRef = useRef<RecordGone | null>(null)

  const setGone = (next: RecordGone | null) => {
    goneRef.current = next
    setGoneState(next)
    onGoneRef.current?.(next)
    // Lost access: drop the record's cached data once the host has swapped
    // the form out (it disables the record read, so nothing refetches).
    if (next?.kind === 'access') setTimeout(() => purgeRecordQueries(qc, collection, itemId), 0)
  }

  // A new record on the same mount starts clean.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on identity only
  useEffect(() => {
    openedAt.current = Date.now()
    lastMoveToast.current = null
    setAutomation({})
    if (goneRef.current) setGone(null)
  }, [collection, itemId])

  const invalidate = (keys: unknown[][]) => {
    for (const key of keys) void qc.invalidateQueries({ queryKey: key })
  }

  /**
   * The record stopped answering: deleted (a trash row newer than this page)
   * or hidden from the viewer. One trash read decides which.
   */
  const resolveGone = async (hint: 'deleted' | 'access') => {
    let info: TrashRecordInfo | null = null
    try {
      info = (
        await client.request<{ data: TrashRecordInfo | null }>(
          get('/trash/record', { collection, item: itemId })
        )
      ).data
    } catch {
      info = null
    }
    const deletedNow =
      !!info?.deleted_at && new Date(info.deleted_at).getTime() >= openedAt.current - 60_000
    if (deletedNow || (hint === 'deleted' && !info)) {
      setGone({
        kind: 'deleted',
        by: info?.deleted_by_name ?? null,
        at: info?.deleted_at ?? new Date().toISOString(),
        trashId: info?.trash_id ?? null,
        canRestore: !!info?.can_restore
      })
    } else setGone({ kind: 'access' })
  }

  // #1824: someone else moved the record — say who and where to.
  const announceMove = async () => {
    try {
      const head = (
        await client.request<{ data: InstanceHead | null }>(
          get(`/pipelines/instance/${collection}/${itemId}`)
        )
      ).data
      const last = head?.history?.[0]
      if (!last || last.id === lastMoveToast.current) return
      // Only a move made while this page was open — never an old row.
      if (last.timestamp && new Date(last.timestamp).getTime() < openedAt.current - 5_000) return
      lastMoveToast.current = last.id
      const who =
        [last.first_name, last.last_name].filter(Boolean).join(' ') || last.user_email || null
      const where = last.to_state_label ?? 'a new state'
      toast.info(who ? `${who} moved this to ${where}` : `This record moved to ${where}`)
    } catch {
      /* the panels still refresh through their own queries */
    }
  }

  const onBatch = (batch: LiveBatch) => {
    if (batch.deleted) {
      void resolveGone('deleted')
      return
    }
    if (goneRef.current) return
    if (batch.events.some((e) => e.source === 'import' && !e.own)) {
      setImporting(true)
      if (importTimer.current) clearTimeout(importTimer.current)
      importTimer.current = setTimeout(() => setImporting(false), IMPORT_QUIET_MS)
    }
    // A batch that names no fields may have moved anything — refresh it all.
    const touched = (aspect: string) => batchTouches(batch, aspect)
    if (touched(LIVE_ASPECTS.state)) {
      invalidate([
        ['pipeline-instance', collection, itemId],
        ['pipeline-all-owners', collection, itemId],
        ['pipeline-instance-owners', collection, itemId],
        ['pipeline-owners-resolved', collection, itemId],
        ['approval-brief', collection, itemId]
      ])
      if (batch.changedFields?.includes(LIVE_ASPECTS.state)) void announceMove()
    }
    if (touched(LIVE_ASPECTS.addendums)) invalidate([['addendums', collection, itemId]])
    if (touched(LIVE_ASPECTS.comments))
      invalidate([
        ['comments', collection, itemId],
        ['comments-related', collection, itemId]
      ])
    // #1970: Notes also lists machine entries — transition comments, partner events, import
    // runs, change reasons. Anything that moves those surfaces refreshes the thread too.
    else if (
      touched(LIVE_ASPECTS.state) ||
      touched(LIVE_ASPECTS.integrations) ||
      touched(LIVE_ASPECTS.addendums) ||
      !batch.aspectsOnly
    )
      invalidate([['comments-related', collection, itemId]])
    if (touched(LIVE_ASPECTS.tasks)) invalidate([['tasks', collection, itemId]])
    if (touched(LIVE_ASPECTS.integrations))
      invalidate([
        ['erp-submissions', collection, itemId],
        ['record-integrations', collection, itemId]
      ])
    // A `$` aspect says a related surface moved, not the record's columns.
    if (batch.aspectsOnly) return
    // A raw bulk write (#1875, item '*') may include this record: refetch it
    // quietly — no flash, since it most likely did not change.
    if (batch.ids.length > 0 && batch.ids.every((id) => id === '*')) {
      invalidate([
        ['item', collection, itemId],
        ['pipeline-instance', collection, itemId]
      ])
      return
    }
    refreshRecord()
  }
  const refreshRecord = () => {
    invalidate([
      ['item', collection, itemId],
      // Summary mode reads its own copy (#1869) — it diffs + highlights.
      ['rrv-record', collection, itemId],
      ['field-touch', collection, itemId],
      ['revisions', collection, itemId],
      // Who made the write — the field ghosts (#2) attribute from it.
      ['last-touch', collection, itemId]
    ])
    setFlash(true)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(false), 4000)
  }
  useLiveRecord(collection, itemId, onBatch)
  // #2131: this person saved the record in another window (a popped-out
  // record, another tab). Their own writes never come back over the socket.
  const { userId } = useItemEditAuth()
  useRecordTabsSignal(userId, 'saved', collection, itemId, () => {
    if (goneRef.current) return
    refreshRecord()
    invalidate([
      ['pipeline-instance', collection, itemId],
      ['comments', collection, itemId],
      ['tasks', collection, itemId],
      // Lines and links saved with it (the keys are per relation, not per record).
      ['o2m-rows'],
      ['m2m-items']
    ])
  })
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current)
      if (importTimer.current) clearTimeout(importTimer.current)
    },
    []
  )

  // #1870: who owns records changed somewhere (matrix, delegation, OOO, teams).
  useLiveEvent(
    'owners:changed',
    () => {
      if (goneRef.current) return
      invalidate([
        ['pipeline-instance-owners', collection, itemId],
        ['pipeline-owners-resolved', collection, itemId],
        ['pipeline-all-owners', collection, itemId],
        ['approval-brief', collection, itemId]
      ])
    },
    { debounceMs: 400 }
  )

  // #1829: the after-write integrity check finished for this record.
  useLiveRecordEvent('record:integrity', collection, itemId, () =>
    invalidate([['record-integrity', collection, itemId]])
  )

  // #2079: a flow run is working on this record. A run that never says
  // "end" (process died) clears itself after five minutes.
  const automationTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  useLiveRecordEvent('record:automation', collection, itemId, (p) => {
    const flowId = String(p?.flow_id ?? '')
    if (!flowId) return
    const timers = automationTimers.current
    const t = timers.get(flowId)
    if (t) clearTimeout(t)
    timers.delete(flowId)
    const drop = () =>
      setAutomation((cur) => {
        const { [flowId]: _, ...rest } = cur
        return rest
      })
    if (p?.state === 'end') {
      drop()
      return
    }
    setAutomation((cur) => ({ ...cur, [flowId]: String(p?.flow_name || 'An automation') }))
    timers.set(flowId, setTimeout(drop, 5 * 60_000))
  })
  useEffect(() => {
    const timers = automationTimers.current
    return () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])

  // #1925: access rules changed — re-read the record as the viewer. Jittered
  // so every open page does not ask in the same instant.
  useLiveEvent(
    'access:changed',
    () => {
      setTimeout(
        () => {
          if (goneRef.current?.kind === 'deleted') return
          client
            .request(get(`/items/${collection}/${itemId}`, { fields: 'id' }))
            .then(() => {
              if (goneRef.current?.kind === 'access') {
                setGone(null)
                invalidate([['item', collection, itemId]])
              }
            })
            .catch((err) => {
              const s = httpStatus(err)
              if (s === 403 || s === 404) void resolveGone('access')
            })
        },
        Math.floor(Math.random() * 1500)
      )
    },
    { debounceMs: 300 }
  )

  // The host's own read failed (a refetch after someone else's change).
  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveGone reads refs
  useEffect(() => {
    if (loadDenied && !goneRef.current) void resolveGone('access')
  }, [loadDenied])

  // #1745: another tab of this browser has unsaved edits to this record.
  const tabs = useRecordTabs(collection, itemId, dirty, userId)
  const [tabsDismissed, setTabsDismissed] = useState(false)
  useEffect(() => {
    if (!tabs.otherDirty) setTabsDismissed(false)
  }, [tabs.otherDirty])

  // Upload presence (#282): relay this tab's file uploads into the record
  // room, and render chips for co-viewers' in-flight uploads.
  useEffect(() => {
    if (!realtime) return
    const onLocal = (e: Event) => {
      const d = (e as CustomEvent).detail as { name: string; state: 'start' | 'done' }
      if (d?.name)
        realtime.emit('record:uploading', {
          collection,
          item: String(itemId),
          name: d.name,
          state: d.state
        })
    }
    window.addEventListener('nvr:upload-state', onLocal)
    const applyRemote = (p: any) => {
      if (p?.collection !== collection || String(p?.item) !== String(itemId)) return
      const user = String(p.user_name ?? p.user ?? 'Someone')
      setUploads((prev) => {
        const rest = prev.filter((u) => !(u.user === user && u.name === p.name))
        return p.state === 'start' ? [...rest, { user, name: String(p.name) }] : rest
      })
    }
    const unsub = realtime.on('record:uploading', applyRemote)
    // Live comments (#280): comment broadcasts refresh the thread instantly. Typing and the
    // other record signals (lib/presence-signals.ts) ride the record-room socket on their own.
    const unsubComment = realtime.on('record:comment', (p: any) => {
      if (p?.collection !== collection || String(p?.item) !== String(itemId)) return
      void qc.invalidateQueries({ queryKey: ['comments', collection, itemId] })
      void qc.invalidateQueries({ queryKey: ['comments-related', collection, itemId] })
    })
    // Hosts whose record-room socket is separate from the feed socket (admin
    // presence v2) relay inbound announcements as this window event instead.
    const onRelayed = (e: Event) => applyRemote((e as CustomEvent).detail)
    window.addEventListener('nvr:record-uploading', onRelayed)
    return () => {
      window.removeEventListener('nvr:upload-state', onLocal)
      window.removeEventListener('nvr:record-uploading', onRelayed)
      unsub()
      unsubComment()
    }
  }, [realtime, collection, itemId, qc])

  const restore = async () => {
    if (!gone?.trashId) return
    setRestoring(true)
    try {
      await client.request(post(`/trash/${gone.trashId}/restore`, {}))
      setGone(null)
      openedAt.current = Date.now()
      invalidate([['item', collection, itemId]])
      toast.success('Record restored')
    } catch (err) {
      toast.error(userErrorMessage(err, 'Restore failed'))
    } finally {
      setRestoring(false)
    }
  }

  const flows = Object.values(automation)
  const showTabs = tabs.otherDirty && !tabsDismissed && !dirty && !gone
  if (
    !gone &&
    flows.length === 0 &&
    !showTabs &&
    !importing &&
    (!realtime || (!flash && uploads.length === 0))
  )
    return null
  return (
    <div className='space-y-2'>
      {gone?.kind === 'deleted' && (
        <div
          data-record-gone='deleted'
          role='alert'
          className='flex items-center gap-3 rounded-lg border border-rose-300 bg-rose-50 px-3.5 py-2.5 dark:border-rose-500/40 dark:bg-rose-500/10'
        >
          <Trash2 className='h-4 w-4 shrink-0 text-rose-500' />
          <p className='min-w-0 flex-1 text-[12px] text-rose-800 dark:text-rose-300'>
            <span className='font-semibold'>This record was deleted</span>
            {gone.by ? ` by ${gone.by}` : ''}
            {gone.at ? ` ${formatRelative(gone.at)}` : ''}. Saving is turned off
            {gone.canRestore ? ' — restore it to keep working.' : '.'}
          </p>
          {gone.canRestore && gone.trashId != null && (
            <button
              type='button'
              onClick={() => void restore()}
              disabled={restoring}
              className='h-7 shrink-0 rounded-md border border-rose-300 bg-white px-2.5 text-[11.5px] font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-500/40 dark:bg-transparent dark:text-rose-300 dark:hover:bg-rose-500/10'
            >
              {restoring ? 'Restoring…' : 'Restore'}
            </button>
          )}
        </div>
      )}
      {/* Lost access: the host replaces the whole form with
          RecordAccessLostPanel; without a host handler, show it here. */}
      {gone?.kind === 'access' && !onGoneChange && (
        <RecordAccessLostPanel onBack={() => window.history.back()} />
      )}
      {showTabs && (
        <div
          data-record-other-tab
          className='flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2.5 dark:border-amber-500/40 dark:bg-amber-500/10'
        >
          <Copy className='h-4 w-4 shrink-0 text-amber-500' />
          <p className='min-w-0 flex-1 text-[12px] text-amber-800 dark:text-amber-300'>
            This record is open with unsaved changes in another tab — editing it here too may
            overwrite them.
          </p>
          <button
            type='button'
            onClick={tabs.focusOther}
            className='h-7 shrink-0 rounded-md border border-amber-300 bg-white px-2.5 text-[11.5px] font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-transparent dark:text-amber-300 dark:hover:bg-amber-500/10'
          >
            Switch to that tab
          </button>
          <button
            type='button'
            onClick={() => setTabsDismissed(true)}
            className='h-7 shrink-0 rounded-md px-2 text-[11.5px] text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-500/10'
          >
            Dismiss
          </button>
        </div>
      )}
      {importing && !gone && (
        <div
          data-record-importing
          role='status'
          className='flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2.5 dark:border-amber-500/40 dark:bg-amber-500/10'
        >
          <FileUp className='h-4 w-4 shrink-0 animate-pulse text-amber-500' />
          <p className='min-w-0 flex-1 text-[12px] text-amber-800 dark:text-amber-300'>
            <span className='font-semibold'>An import is updating this record</span> — the changed
            fields refresh here as it goes.
            {dirty ? ' Your unsaved edits may be out of date; check them before saving.' : ''}
          </p>
        </div>
      )}
      {flows.length > 0 && !gone && (
        <div
          data-record-automation
          role='status'
          className='flex items-center gap-3 rounded-lg border border-nvr-cyan/40 bg-nvr-cyan/10 px-3.5 py-2.5'
        >
          <Bot className='h-4 w-4 shrink-0 animate-pulse text-nvr-cyan' />
          <p className='min-w-0 flex-1 text-[12px] text-[#0e7490] dark:text-[#67e8f9]'>
            <span className='font-semibold'>Automation is updating this record</span> —{' '}
            {flows.join(', ')}. Its changes appear here when it finishes.
          </p>
        </div>
      )}
      {realtime && (flash || uploads.length > 0) && (
        <div className='flex flex-wrap items-center gap-2'>
          {flash && (
            <span className='inline-flex items-center gap-1.5 rounded-full border border-nvr-cyan/40 bg-nvr-cyan/10 px-2.5 py-0.5 text-[11px] font-medium text-[#0e7490] dark:text-[#67e8f9]'>
              <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-nvr-cyan' />
              Updated just now by someone else
            </span>
          )}
          {uploads.map((u) => (
            <span
              key={`${u.user}:${u.name}`}
              className='inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-[11px] text-slate-600 dark:border-border dark:bg-card dark:text-slate-300'
            >
              <UploadCloud className='h-3 w-3 animate-pulse text-nvr-cyan' />
              {u.user} is uploading “{u.name.length > 32 ? `${u.name.slice(0, 32)}…` : u.name}”
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
