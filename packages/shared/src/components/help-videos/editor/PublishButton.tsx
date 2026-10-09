import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Label } from '../../ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { helpVideoApi, helpVideoKeys } from '../api'
import type { HelpVideoDto } from '../types'
import { describeMissing, missingForPublish, renderLabel, whenSaved } from './publish'
import { UnsavedNote } from './UnsavedNote'

const TONES = {
  neutral: 'text-muted-foreground',
  busy: 'text-sky-800 dark:text-sky-300',
  good: 'text-emerald-800 dark:text-emerald-300',
  bad: 'text-rose-700 dark:text-rose-300'
}

export function PublishButton({
  video,
  beforePublish,
  onPublished,
  conflict = false,
  onReload = () => {}
}: {
  video: HelpVideoDto
  // Lands the editor's pending save. False means it failed: nothing is published.
  beforePublish: () => Promise<boolean>
  // The editor reloads its draft here: publishing consumes the draft.
  onPublished: () => void
  /** The editor's draft changed elsewhere: the note offers Reload, not waiting. */
  conflict?: boolean
  onReload?: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [again, setAgain] = useState(false)
  const [busy, setBusy] = useState(false)
  const [unsaved, setUnsaved] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const missing = missingForPublish(video)
  const status = renderLabel(video.published)
  const live = video.status === 'published'
  const askAgain = (video.required_role_ids?.length ?? 0) > 0 && live

  const publish = async () => {
    setBusy(true)
    setNote(null)
    setUnsaved(false)
    try {
      const r = await whenSaved(beforePublish, () => helpVideoApi(client).publish(video.id, again))
      if (!r.ok) {
        setUnsaved(true)
        return
      }
      toast.success('Published')
      setOpen(false)
      setAgain(false)
      // The library and the video; the editor's draft sits outside `all`, so it reloads itself.
      void qc.invalidateQueries({ queryKey: helpVideoKeys.all })
      void qc.invalidateQueries({ queryKey: helpVideoKeys.one(video.id) })
      onPublished()
    } catch (e) {
      setNote(`It couldn't be published. ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const renderAgain = () => {
    setNote(null)
    setUnsaved(false)
    helpVideoApi(client)
      .rerender(video.id)
      .then(() => qc.invalidateQueries({ queryKey: helpVideoKeys.one(video.id) }))
      .catch((e) => {
        setNote(`The render couldn't start. ${(e as Error).message}`)
        setOpen(true)
      })
  }

  return (
    <div className='flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-2 gap-y-1 sm:flex-none'>
      <span
        className={`min-w-0 basis-full text-right text-[12px] sm:basis-auto ${TONES[status.tone]}`}
        title={status.text}
        data-hv-render-status={video.published?.render_status ?? 'none'}
      >
        {status.text}
      </span>
      {video.published?.render_status === 'failed' && (
        <Button size='sm' variant='ghost' className='h-8' onClick={renderAgain}>
          Render again
        </Button>
      )}
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (o) {
            setNote(null)
            setUnsaved(false)
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button size='sm' className='h-8' disabled={!video.draft} data-hv-publish>
            {live ? 'Publish changes' : 'Publish'}
          </Button>
        </PopoverTrigger>
        <PopoverContent align='end' className='w-[300px] space-y-3 text-[13px]'>
          {missing.length ? (
            <p data-hv-publish-missing>{describeMissing(missing)} (Details tab).</p>
          ) : (
            <>
              <p>
                Viewers get this version straight away. The finished video renders in the
                background.
              </p>
              {askAgain && (
                <div className='flex items-start gap-2'>
                  <Checkbox
                    id={`hv-watch-again-${video.id}`}
                    checked={again}
                    onCheckedChange={(c) => setAgain(c === true)}
                    className='mt-0.5'
                    data-hv-watch-again
                  />
                  <Label
                    htmlFor={`hv-watch-again-${video.id}`}
                    className='text-[13px] font-normal leading-snug'
                  >
                    Ask everyone to watch again (the changes are significant)
                  </Label>
                </div>
              )}
            </>
          )}
          {unsaved && <UnsavedNote conflict={conflict} onReload={onReload} data-hv-publish-note />}
          {note && (
            <p
              className='flex items-start gap-1.5 text-[12px] text-rose-700 dark:text-rose-300'
              role='alert'
              data-hv-publish-note
            >
              <AlertCircle className='mt-px h-3.5 w-3.5 shrink-0' aria-hidden />
              {note}
            </p>
          )}
          {!missing.length && (
            <Button
              className='w-full'
              disabled={busy}
              onClick={() => void publish()}
              data-hv-publish-confirm
            >
              {busy ? 'Publishing…' : 'Publish'}
            </Button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
