/**
 * Header: the timed node actions switched on right now — debug windows (#2215) and temporary
 * caches (#2273) — at a glance (hidden when none). Picking one selects its node. This chip's poll
 * also keeps the "cached" node badge fresh.
 */
import { useEffect } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTrafficMap } from '../../context'
import { callerLabel } from '../../EventTicker'
import { requestCanvasRepaint } from '../../registry/canvasLayers'
import { register } from '../../registry/registry'
import { toolbarItems } from '../../registry/toolbarItems'
import { untilPhrase } from '../breaker'
import { inMapOnly } from '../ops-common'
import { useDebugWindows, useTempCaches } from './shared'
import { setCachedTargets } from './temp-cache'

/** "1 debug window · 2 caches" (pure; exported for tests). */
export function activeSummary(debug: number, caches: number): string {
  const parts: string[] = []
  if (debug) parts.push(`${debug} debug ${debug === 1 ? 'window' : 'windows'}`)
  if (caches) parts.push(`${caches} ${caches === 1 ? 'cache' : 'caches'}`)
  return parts.join(' · ')
}

function ActiveActions() {
  const { catalog, setSelection } = useTrafficMap()
  const debug = useDebugWindows().data?.windows ?? []
  const cachesData = useTempCaches().data
  const caches = cachesData?.caches ?? []
  useEffect(() => {
    if (!cachesData) return
    setCachedTargets(cachesData.caches)
    requestCanvasRepaint()
  }, [cachesData])
  if (!debug.length && !caches.length) return null
  const select = (target: string) =>
    setSelection(
      target.includes('/') ? { kind: 'entity', id: target } : { kind: 'caller', id: target }
    )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          id='tm-active-actions'
          className='inline-flex items-center gap-1.5 rounded-md border border-[var(--tm-accent)] bg-[var(--tm-accent-soft)] px-2.5 py-[3px] text-[12px] font-medium leading-tight text-[var(--tm-accent-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        >
          {activeSummary(debug.length, caches.length)}
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[320px] p-0'>
        <ul className='divide-y divide-border text-[12px]'>
          {debug.map((w) => (
            <li key={w.id} className='grid gap-0.5 px-3 py-2'>
              <button
                type='button'
                className='truncate text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                onClick={() => select(w.target)}
              >
                Debugging {w.target.includes('/') ? w.target : callerLabel(catalog, w.target)}
              </button>
              <span className='text-muted-foreground'>
                {untilPhrase(w.until)} · {w.kept} traces kept here
              </span>
            </li>
          ))}
          {caches.map((c) => (
            <li key={c.id} className='grid gap-0.5 px-3 py-2'>
              <button
                type='button'
                className='truncate text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                onClick={() => select(c.target)}
              >
                Caching {c.collection} reads
              </button>
              <span className='text-muted-foreground'>
                {untilPhrase(c.until)}
                {c.stats.rate == null ? '' : ` · ${Math.round(c.stats.rate * 100)}% hits`}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

register(toolbarItems, {
  id: 'tm-active-actions',
  order: 52,
  slot: 'status',
  Component: inMapOnly(ActiveActions)
})
