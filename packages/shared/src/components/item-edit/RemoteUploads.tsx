import { UploadCloud } from 'lucide-react'
import {
  type RemoteUpload,
  uploadSentence,
  useClaimUploadField,
  useRemoteUploads
} from '../../lib/upload-presence'
import { cn } from '../../lib/utils'

/**
 * Co-viewers' uploads into one file field (rt9 #9): "Beth is uploading “quote.pdf” · 60%" with
 * a hairline bar. Renders nothing when nobody is uploading here. Mounting it claims the field,
 * so the record's chip row (RecordLiveSync) leaves these uploads to the field.
 */
export function RemoteUploadRows({
  collection,
  item,
  field
}: {
  collection: string | null | undefined
  item: string | null | undefined
  field: string | null | undefined
}) {
  useClaimUploadField(collection, item, field)
  const list = useRemoteUploads(collection, item, field ?? undefined)
  if (!field || list.length === 0) return null
  return (
    <div className='mt-1.5 flex flex-col gap-1' data-remote-uploads={field}>
      {list.map((u) => (
        <RemoteUploadRow key={u.key} upload={u} />
      ))}
    </div>
  )
}

export function RemoteUploadRow({ upload: u }: { upload: RemoteUpload }) {
  const known = u.pct != null && u.pct > 0
  return (
    <div
      role='status'
      data-remote-upload={u.key}
      className='nvr-fade-in rounded-md border border-dashed border-slate-200 bg-slate-50/70 px-2 py-1.5 dark:border-border dark:bg-muted/40'
    >
      <div className='flex items-center gap-1.5 text-[11.5px] leading-4 text-slate-600 dark:text-slate-300'>
        <UploadCloud className='h-3.5 w-3.5 shrink-0 text-nvr-cyan' aria-hidden />
        <span className='min-w-0 flex-1 truncate'>{uploadSentence({ ...u, pct: null })}</span>
        {known && (
          <span className='shrink-0 tabular-nums text-slate-500 dark:text-slate-400'>{u.pct}%</span>
        )}
      </div>
      <div
        className='mt-1 h-[3px] overflow-hidden rounded-full bg-slate-200/80 dark:bg-white/10'
        aria-hidden
      >
        <div
          className={cn(
            'h-full rounded-full bg-nvr-cyan transition-[width] duration-500 ease-out motion-reduce:transition-none',
            !known && 'w-1/4 animate-pulse'
          )}
          style={known ? { width: `${Math.max(4, u.pct ?? 0)}%` } : undefined}
        />
      </div>
    </div>
  )
}
