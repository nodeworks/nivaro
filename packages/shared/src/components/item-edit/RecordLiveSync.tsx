import { useQueryClient } from '@tanstack/react-query'
import { UploadCloud } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useOptionalRealtime } from '../../lib/realtime'

/**
 * Record-level live sync (#274 state sync, #281 live revision feed, #282
 * upload presence). Mounted by ItemEditForm on SAVED records when the host
 * provides a RealtimeAdapter; renders nothing except a transient "updated"
 * pill and co-viewer upload chips. All refresh happens through react-query
 * invalidation, so RBAC-checked queries do the actual fetching.
 */
export function RecordLiveSync({ collection, itemId }: { collection: string; itemId: string }) {
  const realtime = useOptionalRealtime()
  const qc = useQueryClient()
  const [flash, setFlash] = useState(false)
  const [uploads, setUploads] = useState<Array<{ user: string; name: string }>>([])
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Inbound: another client wrote this record → refresh everything that
  // describes it. Debounced per event burst by react-query's own dedupe.
  useEffect(() => {
    if (!realtime) return
    const unsub = realtime.subscribeCollections([collection], (ev) => {
      if (String(ev.item) !== String(itemId)) return
      for (const key of [
        ['item', collection, itemId],
        ['pipeline-instance', collection, itemId],
        ['pipeline-all-owners', collection, itemId],
        ['comments', collection, itemId],
        ['revisions', collection, itemId],
        ['erp-submissions', collection, itemId]
      ]) {
        void qc.invalidateQueries({ queryKey: key })
      }
      setFlash(true)
      if (flashTimer.current) clearTimeout(flashTimer.current)
      flashTimer.current = setTimeout(() => setFlash(false), 4000)
    })
    return () => {
      unsub()
      if (flashTimer.current) clearTimeout(flashTimer.current)
    }
  }, [realtime, collection, itemId, qc])

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
    // Hosts whose record-room socket is separate from the feed socket (admin
    // presence v2) relay inbound announcements as this window event instead.
    const onRelayed = (e: Event) => applyRemote((e as CustomEvent).detail)
    window.addEventListener('nvr:record-uploading', onRelayed)
    return () => {
      window.removeEventListener('nvr:upload-state', onLocal)
      window.removeEventListener('nvr:record-uploading', onRelayed)
      unsub()
    }
  }, [realtime, collection, itemId])

  if (!realtime) return null
  if (!flash && uploads.length === 0) return null
  return (
    <div className='flex flex-wrap items-center gap-2'>
      {flash && (
        <span className='inline-flex items-center gap-1.5 rounded-full border border-[#00ceff]/40 bg-[#00ceff]/10 px-2.5 py-0.5 text-[11px] font-medium text-[#0e7490] dark:text-[#67e8f9]'>
          <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-[#00ceff]' />
          Updated just now by someone else
        </span>
      )}
      {uploads.map((u) => (
        <span
          key={`${u.user}:${u.name}`}
          className='inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-[11px] text-slate-600 dark:border-border dark:bg-card dark:text-slate-300'
        >
          <UploadCloud className='h-3 w-3 animate-pulse text-[#00ceff]' />
          {u.user} is uploading “{u.name.length > 32 ? `${u.name.slice(0, 32)}…` : u.name}”
        </span>
      ))}
    </div>
  )
}
