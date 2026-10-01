// Task 8 stub — Task 9 replaces the body with the canvas. Keep the props shape.
import type { TrafficModel } from './model'
import type { Filters, Selection, TrafficCatalog } from './types'

export interface MapCanvasProps {
  model: TrafficModel
  filters: Filters
  selection: Selection | null
  onSelect: (s: Selection) => void
  catalog: TrafficCatalog | null
  tick: number
  paused: boolean
  /** No frame for a while although live (socket dropped): footer shows the amber note (D9). */
  stale?: boolean
}

export function MapCanvas({ model, paused, stale }: MapCanvasProps) {
  return (
    <section
      className='min-w-0 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)]'
      aria-label='Traffic map'
      id='tm-map'
    >
      <div className='border-b border-[var(--tm-line-2)] px-3.5 py-2'>
        <h2 className='text-[13px] font-semibold'>Flow</h2>
        <p className='text-[11.5px] text-[var(--tm-muted)]'>
          Callers → API lanes → data and partners · edge width = requests/s
        </p>
      </div>
      <div className='px-3.5 py-10 text-center text-[12px] text-[var(--tm-muted)]'>
        The flow map is drawn here.
      </div>
      <div className='flex flex-wrap justify-between gap-2.5 border-t border-[var(--tm-line-2)] px-3.5 py-1.5 text-[11px] text-[var(--tm-muted)]'>
        <span>
          This node only · api · <span className='font-mono'>{model.instance || '…'}</span>
        </span>
        {stale ? (
          <span className='text-[var(--tm-update)]'>reconnecting — showing the last frame</span>
        ) : paused ? (
          <span>Paused — frames are not applied.</span>
        ) : null}
      </div>
    </section>
  )
}
