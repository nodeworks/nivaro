import { memo, useId } from 'react'
import { Switch } from '../../ui/switch'
import { setCursor } from '../edits'
import type { PointerPath, VideoEdits } from '../types'

/**
 * The recorded cursor and shortcut badges (#1517). "Show cursor" draws a
 * highlighted pointer along the pointer path the recorder kept (this tab
 * only, like clicks); "Show shortcuts" adds a badge for each keyboard
 * shortcut pressed (never text typed into a field). Both are off until
 * switched on, and a recording without a pointer path (made before the
 * recorder kept one, or of another window or screen) cannot switch them on.
 * Stores nothing while off.
 */
export const CursorPanel = memo(function CursorPanel({
  edits,
  pointer,
  onChange
}: {
  edits: VideoEdits
  /** The recorder's pointer path and shortcuts; null when there are none. */
  pointer: PointerPath | null | undefined
  onChange: (e: VideoEdits, key?: string) => void
}) {
  const id = useId()
  const hasPath = !!pointer?.samples.length
  const shortcuts = pointer?.shortcuts.length ?? 0
  const show = !!edits.cursor?.show
  const badges = !!edits.cursor?.shortcuts
  return (
    <div className='space-y-2' data-hv-cursor-panel>
      <div className='flex items-center justify-between gap-3'>
        <label htmlFor={`${id}-show`} className='text-[13px] font-medium text-foreground'>
          Show cursor
        </label>
        <Switch
          id={`${id}-show`}
          checked={show}
          disabled={!hasPath}
          onCheckedChange={(v) => onChange(setCursor(edits, { show: v }), 'cursor')}
          data-hv-show-cursor
        />
      </div>
      <p className='text-[12px] leading-snug text-muted-foreground'>
        {hasPath
          ? 'Draws a soft, highlighted pointer where yours went while recording, so viewers can follow it; it moves with the crop and zoom.'
          : 'This recording has no pointer path: it was made before the recorder kept one, or of another window or screen.'}
      </p>
      <div className='flex items-center justify-between gap-3'>
        <label htmlFor={`${id}-shortcuts`} className='text-[13px] font-medium text-foreground'>
          Show shortcuts
        </label>
        <Switch
          id={`${id}-shortcuts`}
          checked={badges}
          disabled={!show || !shortcuts}
          onCheckedChange={(v) => onChange(setCursor(edits, { shortcuts: v }), 'cursor')}
          data-hv-show-shortcuts
        />
      </div>
      <p className='text-[12px] leading-snug text-muted-foreground' data-hv-shortcut-count>
        {hasPath && !shortcuts
          ? 'No keyboard shortcuts were pressed while recording.'
          : `A small badge (⌘S, Ctrl+K, Enter…) as each shortcut is pressed${
              shortcuts ? `: ${shortcuts} recorded` : ''
            }. Text typed into fields is never recorded.`}
      </p>
      {show && (
        <p
          className='rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-[12px] leading-snug text-muted-foreground'
          data-hv-cursor-note
        >
          The preview draws it live. Viewers watch the rendered video, which has it burned in.
        </p>
      )}
    </div>
  )
})
