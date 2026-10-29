import { useDroppable } from '@dnd-kit/core'
import { Trash2 } from 'lucide-react'
import { useCallback, useSyncExternalStore } from 'react'
import { cn } from '../../../lib/utils'
import type { DndStore } from './node'
import { TRASH_DROP_ID, type TrashDropData, type TrashPlan } from './trash-drop'

// Rises from the bottom of the screen while something removable is dragged (dnd/trash-drop.ts).
// Dashed and quiet until the pointer is over it, then it turns red and says what the drop does.
// It sits above the drag preview (z 1000) so its words stay readable while the preview is over it.
const CSS = `
@keyframes nvr-trash-in{from{opacity:0;transform:translate(-50%,12px)}to{opacity:1;transform:translate(-50%,0)}}
[data-layout-trash]{animation:nvr-trash-in 160ms cubic-bezier(0.25,1,0.5,1) both}
@media (prefers-reduced-motion: reduce){[data-layout-trash]{animation:none}}
`

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

export function TrashZone({
  store,
  plan,
  name
}: {
  store: DndStore
  plan: TrashPlan
  /** What is being dragged, as the form names it. */
  name: string
}) {
  const { setNodeRef } = useDroppable({
    id: TRASH_DROP_ID,
    data: { layoutTrash: true } satisfies TrashDropData
  })
  const over = useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.state.overKey === TRASH_DROP_ID, [store]),
    () => false
  )
  const detail =
    plan.kind === 'section'
      ? plan.holds > 0
        ? `With its ${plural(plan.holds, 'field')} · their data is kept`
        : 'It holds no fields'
      : 'Its data is kept'
  return (
    <div
      ref={setNodeRef}
      data-layout-trash=''
      data-over={over ? '' : undefined}
      style={{ left: '50%', transform: 'translateX(-50%)' }}
      className={cn(
        'pointer-events-auto fixed bottom-6 z-[1001] flex min-w-[240px] max-w-[min(420px,calc(100vw-32px))] items-center gap-3 rounded-xl border-2 px-4 py-3 shadow-lg transition-colors duration-150 motion-reduce:transition-none',
        over
          ? 'border-solid border-red-400 bg-red-50 text-red-800 dark:border-red-500/70 dark:bg-[#3b1219] dark:text-red-100'
          : 'border-dashed border-slate-300 bg-white text-slate-600 dark:border-slate-600 dark:bg-card dark:text-slate-300'
      )}
    >
      <style>{CSS}</style>
      <span
        aria-hidden
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-150 motion-reduce:transition-none',
          over
            ? 'bg-red-600 text-white'
            : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300'
        )}
      >
        <Trash2 className='h-4 w-4' />
      </span>
      <span className='min-w-0'>
        <span className='block truncate text-[13px] font-semibold'>
          {over ? `Release to remove ${name}` : 'Drop here to remove'}
        </span>
        <span
          className={cn(
            'block truncate text-[11.5px]',
            over ? 'text-red-700 dark:text-red-200/90' : 'text-slate-500 dark:text-slate-400'
          )}
        >
          {over ? detail : 'From this form only · Undo brings it back'}
        </span>
      </span>
    </div>
  )
}
