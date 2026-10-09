import { memo, useId } from 'react'
import { Switch } from '../../ui/switch'
import { setImproveAudio } from '../edits'
import type { VideoEdits } from '../types'

/**
 * Narration cleanup (#1519): the render levels the narration's loudness and
 * reduces background noise. The preview plays the recording as it was made;
 * only the rendered video carries the cleanup, so viewers wait for it.
 * Stores nothing while it is off.
 */
export const NarrationPanel = memo(function NarrationPanel({
  edits,
  onChange
}: {
  edits: VideoEdits
  onChange: (e: VideoEdits, key?: string) => void
}) {
  const id = useId()
  const on = !!edits.audio?.improve
  return (
    <div className='space-y-2' data-hv-narration>
      <div className='flex items-center justify-between gap-3'>
        <label htmlFor={id} className='text-[13px] font-medium text-foreground'>
          Improve audio
        </label>
        <Switch
          id={id}
          checked={on}
          onCheckedChange={(v) => onChange(setImproveAudio(edits, v), 'audio')}
          data-hv-improve-audio
        />
      </div>
      <p className='text-[12px] leading-snug text-muted-foreground'>
        Evens out how loud the narration is and lowers background noise in the finished video. A
        recording without sound is left as it is.
      </p>
      {on && (
        <p
          className='rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-[12px] leading-snug text-muted-foreground'
          data-hv-improve-audio-note
        >
          The preview here plays the narration as recorded. The cleanup is applied when the video
          renders, and viewers wait for that render.
        </p>
      )}
    </div>
  )
})
