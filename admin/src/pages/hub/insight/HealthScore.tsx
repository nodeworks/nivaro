import { useQuery } from '@tanstack/react-query'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import {
  BAND_LABEL,
  BAND_TONE,
  type EnvHealth,
  fetchHealth,
  insightKeys,
  trendChange
} from './insight-api'

/** The score with its band in words (never colour alone). `—` when the Hub has no figure. */
export function HealthScore({
  health,
  compact
}: {
  health: Pick<EnvHealth, 'score' | 'band' | 'trend'> | null | undefined
  compact?: boolean
}) {
  if (!health || health.score == null)
    return (
      <span
        className='text-slate-500 dark:text-muted-foreground'
        data-tip='Not enough figures yet for a score'
      >
        —
      </span>
    )
  const band = health.band ?? 'poor'
  const change = trendChange(health)
  return (
    <span className='inline-flex items-baseline gap-1.5 whitespace-nowrap'>
      <span
        className={cn(
          'font-semibold tabular-nums',
          compact ? 'text-[12px]' : 'text-[15px]',
          BAND_TONE[band]
        )}
      >
        {health.score}
      </span>
      <span className={cn('text-[11px] font-medium', BAND_TONE[band])}>{BAND_LABEL[band]}</span>
      {change != null && change !== 0 && (
        <span
          className='inline-flex items-center text-[11px] tabular-nums text-slate-500 dark:text-muted-foreground'
          data-tip={`${change > 0 ? 'Up' : 'Down'} ${Math.abs(change)} over the stored days`}
        >
          {change > 0 ? (
            <ArrowUpRight className='h-3 w-3' aria-hidden />
          ) : (
            <ArrowDownRight className='h-3 w-3' aria-hidden />
          )}
          {Math.abs(change)}
        </span>
      )}
    </span>
  )
}

/** Every visible environment's current health by environment id (one read, shared cache). */
export function useHealthByEnv(enabled = true): Map<number, EnvHealth> | null {
  const q = useQuery({
    queryKey: insightKeys.health(),
    queryFn: fetchHealth,
    staleTime: 60_000,
    enabled,
    retry: false
  })
  return useMemo(() => {
    if (!q.data) return null
    return new Map(q.data.environments.map((e) => [e.environment_id, e]))
  }, [q.data])
}
