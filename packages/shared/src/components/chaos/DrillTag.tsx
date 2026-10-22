import { useQuery } from '@tanstack/react-query'
import { FlaskConical } from 'lucide-react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'

/**
 * The drill tag on alert rows (#2847): an alert that fired while a chaos run was armed reads
 * "Drill" with the run's name on hover — on the Ops Console, Telemetry and the Integrations
 * console alike. Rows are tagged by time against `GET /api/chaos/drill-windows`, so a row written
 * by any alert path reads the same. People who cannot read chaos runs (403) see no tag.
 */

export interface DrillWindow {
  run_id: string
  kind: 'drill' | 'monkey' | 'gameday' | 'ci'
  label: string
  fault_key: string | null
  started_at: string
  /** null while it runs. */
  ended_at: string | null
}

export const DRILL_WINDOWS_KEY = ['chaos', 'drill-windows'] as const

/** The run whose window holds `at` (default now), newest first; null when none. */
export function drillAt(
  windows: DrillWindow[] | undefined,
  at?: string | number | Date | null,
  now = Date.now()
): DrillWindow | null {
  if (!windows?.length) return null
  const t = at == null ? now : at instanceof Date ? at.getTime() : new Date(at).getTime()
  if (!Number.isFinite(t)) return null
  let best: DrillWindow | null = null
  for (const w of windows) {
    const start = Date.parse(w.started_at)
    const end = w.ended_at ? Date.parse(w.ended_at) : now
    // A minute of grace after the end: an alert that evaluates once a minute lands just after.
    if (t >= start && t <= end + 60_000 && (!best || start > Date.parse(best.started_at))) best = w
  }
  return best
}

/** Drill windows of the last week, through the shared client (hosts with a NivaroProvider). */
export function useDrillWindows(): DrillWindow[] {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: DRILL_WINDOWS_KEY,
    queryFn: () =>
      client
        .request<{ data: DrillWindow[] }>(get('/chaos/drill-windows'))
        .then((r) => r.data ?? [])
        .catch(() => [] as DrillWindow[]),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false
  })
  return data ?? []
}

const KIND: Record<DrillWindow['kind'], string> = {
  drill: 'chaos drill',
  monkey: 'Chaos Monkey drill',
  gameday: 'game day',
  ci: 'CI drill'
}

export function DrillTag({
  windows,
  at,
  className
}: {
  windows: DrillWindow[] | undefined
  /** When the alert fired; absent = it is firing now. */
  at?: string | number | Date | null
  className?: string
}) {
  const w = drillAt(windows, at)
  if (!w) return null
  return (
    <span
      data-drill-tag={w.run_id}
      data-tip={`Fired during the ${KIND[w.kind] ?? 'chaos drill'} “${w.label}”. It may or may not be caused by it; everyone who normally hears about it was told.`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded border border-dashed border-violet-300 bg-violet-50 px-1.5 py-px text-[10.5px] font-medium text-violet-800 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-300',
        className
      )}
    >
      <FlaskConical className='h-3 w-3' aria-hidden />
      Drill
    </span>
  )
}
