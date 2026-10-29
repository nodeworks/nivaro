import { useDroppable } from '@dnd-kit/core'
import { Link2, Trash2 } from 'lucide-react'
import { useCallback, useSyncExternalStore } from 'react'
import { cn } from '../../../lib/utils'
import type { DndStore } from './node'
import { TRASH_DROP_ID, type TrashDropData, type TrashPlan } from './trash-drop'
import type { TrashWarning } from './trash-links'

// Rises from the bottom of the screen while something removable is dragged (dnd/trash-drop.ts).
// Dashed and quiet until the pointer is over it, then it turns red and says what the drop does.
// It sits above the drag preview (z 1000) so its words stay readable while the preview is over it.
const CSS = `
@keyframes nvr-trash-in{from{opacity:0;transform:translate(-50%,12px)}to{opacity:1;transform:translate(-50%,0)}}
[data-layout-trash]{animation:nvr-trash-in 160ms cubic-bezier(0.25,1,0.5,1) both}
@media (prefers-reduced-motion: reduce){[data-layout-trash]{animation:none}}
`

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

// Effects listed while the pointer is over the trash; the rest fold into "+n more".
const MAX_EFFECTS = 3

export function TrashZone({
  store,
  plan,
  name,
  warning = null
}: {
  store: DndStore
  plan: TrashPlan
  /** What is being dragged, as the form names it. */
  name: string
  /** #3190: what depends on what would leave the form ("Region drives 3 rules"). */
  warning?: TrashWarning | null
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
      : (plan.count ?? 1) > 1
        ? 'Their data is kept'
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
        {warning && <TrashLinks warning={warning} over={over} />}
      </span>
    </div>
  )
}

/** #3190: the rules that lose their driver: a quiet line while dragging, the list once over. */
function TrashLinks({ warning, over }: { warning: TrashWarning; over: boolean }) {
  const shown = warning.effects.slice(0, MAX_EFFECTS)
  const more = warning.effects.length - shown.length
  return (
    <span
      data-trash-links={warning.count}
      className={cn(
        'mt-1.5 block border-t pt-1.5 text-[11.5px]',
        over
          ? 'border-red-200 text-red-800 dark:border-red-500/30 dark:text-red-100'
          : 'border-slate-200 text-amber-800 dark:border-slate-700 dark:text-amber-200'
      )}
    >
      <span className='flex items-center gap-1 font-medium'>
        <Link2 aria-hidden className='h-3 w-3 shrink-0' />
        <span className='truncate'>{warning.headline}</span>
      </span>
      {over && (
        <>
          <span className='mt-0.5 block truncate'>
            {shown.join(' · ')}
            {more > 0 ? ` · +${more} more` : ''}
          </span>
          <span className='block truncate text-red-700/90 dark:text-red-200/80'>
            Off the form, nobody can change it here
          </span>
        </>
      )}
    </span>
  )
}
