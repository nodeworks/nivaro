import { AlertCircle, RotateCw } from 'lucide-react'
import { Button } from '../../ui/button'
import { UNSAVED_NOTE } from './publish'

export const CONFLICT_NOTE =
  "This draft changed somewhere else, so your edits can't be saved here. Reload to pick up the latest."

/**
 * Why Publish, Restore or Re-record stopped: the editor's save did not land.
 * After a conflict the answer is Reload, not waiting.
 */
export function UnsavedNote({
  conflict,
  onReload,
  ...rest
}: {
  conflict: boolean
  onReload: () => void
} & Record<`data-${string}`, string | undefined>) {
  return (
    <div
      className='flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px] text-rose-700 dark:text-rose-300'
      role='alert'
      {...rest}
    >
      <p className='flex min-w-0 items-start gap-1.5'>
        <AlertCircle className='mt-px h-3.5 w-3.5 shrink-0' aria-hidden />
        <span>{conflict ? CONFLICT_NOTE : UNSAVED_NOTE}</span>
      </p>
      {conflict && (
        <Button
          size='sm'
          variant='outline'
          className='h-7 px-2 text-[12px]'
          onClick={onReload}
          data-hv-reload
        >
          <RotateCw className='!size-3.5' /> Reload
        </Button>
      )}
    </div>
  )
}
