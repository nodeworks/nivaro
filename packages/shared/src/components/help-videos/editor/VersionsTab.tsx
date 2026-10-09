import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, RotateCw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { Button } from '../../ui/button'
import { Skeleton } from '../../ui/skeleton'
import { helpVideoApi, helpVideoKeys } from '../api'
import type { HelpVideoDto } from '../types'
import { DownloadMenu } from '../viewer/DownloadMenu'
import { renderLabel, whenSaved } from './publish'
import { UnsavedNote } from './UnsavedNote'

const pill = 'rounded-full px-2 py-0.5 text-[11px] font-medium'

export function VersionsTab({
  video,
  onRerecord,
  onRestored,
  beforeChange,
  conflict = false,
  onReload = () => {}
}: {
  video: HelpVideoDto
  onRerecord: () => void
  onRestored: () => void
  // Lands the editor's pending autosave first, so the old draft's last edits never
  // overwrite a new draft. Resolves false when the save failed: nothing changes then.
  beforeChange: () => Promise<boolean>
  /** The draft changed elsewhere: the note offers Reload instead of waiting. */
  conflict?: boolean
  onReload?: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [note, setNote] = useState<string | null>(null)
  const [unsaved, setUnsaved] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  const versions = useQuery({
    queryKey: ['help-videos', 'versions', video.id],
    queryFn: () => helpVideoApi(client).versions(video.id)
  })

  const rerecord = async () => {
    setNote(null)
    setUnsaved(false)
    const r = await whenSaved(beforeChange, async () => undefined)
    if (!r.ok) setUnsaved(true)
    else onRerecord()
  }
  const restore = async (id: string, version: number) => {
    setNote(null)
    setUnsaved(false)
    setRestoring(id)
    try {
      const r = await whenSaved(beforeChange, () => helpVideoApi(client).restore(video.id, id))
      if (!r.ok) {
        setUnsaved(true)
        return
      }
      toast.success(`Version ${version} copied into a new draft`)
      void qc.invalidateQueries({ queryKey: helpVideoKeys.one(video.id) })
      void versions.refetch()
      onRestored()
    } catch (e) {
      setNote(`Version ${version} couldn't be restored. ${(e as Error).message}`)
    } finally {
      setRestoring(null)
    }
  }

  return (
    <div className='max-w-[760px] space-y-3 p-5 text-[13px]' data-hv-versions>
      <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-2'>
        <p className='max-w-[65ch] text-muted-foreground'>
          Every published cut is kept. Restoring copies an older cut into a new draft, so nothing is
          overwritten.
        </p>
        <div className='flex items-center gap-2'>
          {video.draft_download_urls && (
            <DownloadMenu
              urls={video.draft_download_urls}
              original
              label='Download draft'
              where='versions'
            />
          )}
          <Button
            size='sm'
            variant='outline'
            className='h-8'
            onClick={() => void rerecord()}
            data-hv-rerecord
          >
            Re-record
          </Button>
        </div>
      </div>
      {unsaved && <UnsavedNote conflict={conflict} onReload={onReload} data-hv-versions-note />}
      <div role='status' aria-live='polite'>
        {note && (
          <p
            className='flex items-start gap-1.5 text-[12px] text-rose-700 dark:text-rose-300'
            data-hv-versions-note
          >
            <AlertCircle className='mt-px h-3.5 w-3.5 shrink-0' aria-hidden />
            {note}
          </p>
        )}
      </div>
      {versions.isLoading && (
        <div className='space-y-2' role='status' aria-busy='true' aria-label='Loading versions'>
          <Skeleton className='h-12 w-full' />
          <Skeleton className='h-12 w-full' />
        </div>
      )}
      {versions.error && (
        <div className='flex items-center gap-2 text-rose-700 dark:text-rose-300' role='alert'>
          <AlertCircle className='h-4 w-4' aria-hidden />
          <span>The versions couldn't load. {(versions.error as Error).message}</span>
          <Button
            size='sm'
            variant='outline'
            className='h-7'
            onClick={() => void versions.refetch()}
          >
            <RotateCw className='!size-3.5' /> Try again
          </Button>
        </div>
      )}
      {versions.data && (
        <ul className='divide-y divide-border rounded-md border border-border'>
          {versions.data.map((v) => (
            <li
              key={v.id}
              className='flex items-center gap-3 px-3 py-2.5'
              data-hv-version={v.version}
            >
              <span className='w-10 font-semibold tabular-nums'>v{v.version}</span>
              <span className='min-w-0 flex-1'>
                <span className='block truncate text-foreground'>
                  {v.note ?? (v.is_published ? 'Published' : v.is_draft ? 'Draft' : 'Earlier cut')}
                </span>
                <span className='block text-[12px] text-muted-foreground'>
                  {new Date(v.created_at).toLocaleString()} · {v.created_by_name ?? 'Unknown'} ·{' '}
                  {renderLabel(v).text}
                </span>
              </span>
              {v.is_published && (
                <span
                  className={`${pill} bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300`}
                >
                  Live
                </span>
              )}
              {v.is_draft && (
                <span
                  className={`${pill} bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200`}
                >
                  Draft
                </span>
              )}
              {!v.is_draft && (
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-8'
                  disabled={restoring !== null}
                  onClick={() => void restore(v.id, v.version)}
                  aria-label={`Restore version ${v.version}`}
                  data-hv-restore={v.version}
                >
                  {restoring === v.id ? 'Restoring…' : 'Restore'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
