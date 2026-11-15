import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useRef } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { useLiveRecordEvent } from '../../lib/live'

/**
 * File processing status on the file chip (rt3 #17). After an upload the server makes the
 * chip thumbnail (images) or reads the text (documents) in the background
 * (api services/file-processing.ts). While it works the chip says "Processing…"; when it ends
 * the record's viewers hear `file:processed {file}` in the record room and the chip updates in
 * place — the thumbnail appears, the word goes. A host without the record room (or a missed
 * event) still gets there: while something is processing the status is re-read every few
 * seconds, for two minutes at most.
 */

export type FileProcessingStatus = 'processing' | 'ready' | 'failed'

/** Re-read cadence while a file processes, and how long the page keeps asking. */
export const PROCESSING_POLL_MS = 3000
export const PROCESSING_POLL_FOR_MS = 120_000

/** The chip thumbnail rendition the server prepares (api CHIP_THUMB). */
export const CHIP_THUMB_QUERY = 'w=160&h=160&fit=cover&format=webp&q=80'

/** The thumbnail URL for a stored file's chip (a blob: preview stays as it is). */
export function chipThumbUrl(fileUrl: string): string {
  if (!fileUrl || /^(blob|data):/i.test(fileUrl) || fileUrl.includes('?')) return fileUrl
  return `${fileUrl}/transform?${CHIP_THUMB_QUERY}`
}

/** The ids still processing in a status answer. Pure. */
export function processingIds(
  states: Record<string, { status?: string }> | undefined
): Set<string> {
  const out = new Set<string>()
  for (const [id, s] of Object.entries(states ?? {}))
    if (s?.status === 'processing') out.add(id.toLowerCase())
  return out
}

/** Whether the page should keep asking: something processes and the window is not over. */
export function pollDelay(processing: number, startedAt: number, now = Date.now()): number | false {
  if (processing === 0) return false
  return now - startedAt < PROCESSING_POLL_FOR_MS ? PROCESSING_POLL_MS : false
}

/**
 * Which of `ids` are processing now. `record` = the record whose room announces the end
 * (null = no room: polling only).
 */
export function useFileProcessing(
  ids: readonly string[],
  record: { collection: string | null | undefined; itemId: string | null | undefined } | null
): { isProcessing: (id: string) => boolean } {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const sorted = [...new Set(ids.map((i) => String(i).toLowerCase()))].sort()
  const key = ['file-processing', sorted.join(',')]
  const startedAt = useRef(Date.now())
  const { data } = useQuery<Record<string, { status: FileProcessingStatus }>>({
    queryKey: key,
    queryFn: () =>
      client
        .request<{ data: Record<string, { status: FileProcessingStatus }> }>(
          get('/files/processing', { ids: sorted.join(',') })
        )
        .then((r) => r.data ?? {})
        .catch(() => ({})),
    enabled: sorted.length > 0,
    staleTime: 10_000,
    refetchInterval: (q) =>
      pollDelay(
        processingIds(q.state.data as Record<string, { status?: string }>).size,
        startedAt.current
      )
  })
  useLiveRecordEvent(
    'file:processed',
    record?.collection ?? null,
    record?.itemId ?? null,
    (p: { file?: unknown }) => {
      const id = String(p?.file ?? '').toLowerCase()
      if (id && sorted.includes(id)) void qc.invalidateQueries({ queryKey: ['file-processing'] })
    },
    { includeOwn: true }
  )
  const busy = processingIds(data)
  return { isProcessing: (id: string) => busy.has(String(id).toLowerCase()) }
}

/** The quiet "Processing…" mark beside a file's name. */
export function FileProcessingBadge() {
  return (
    <span
      data-file-processing
      role='status'
      className='inline-flex shrink-0 items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-white/10 dark:text-slate-300'
    >
      <Loader2 className='h-2.5 w-2.5 animate-spin motion-reduce:animate-none' aria-hidden />
      Processing…
    </span>
  )
}

/** The thumbnail tile while the image's thumbnail is being made. */
export function FileProcessingTile({ className }: { className?: string }) {
  return (
    <div
      data-file-thumb-processing
      className={`flex shrink-0 items-center justify-center rounded bg-slate-100 dark:bg-white/10 ${className ?? 'h-10 w-10'}`}
    >
      <Loader2
        className='h-4 w-4 animate-spin text-slate-400 motion-reduce:animate-none dark:text-slate-500'
        aria-hidden
      />
    </div>
  )
}
