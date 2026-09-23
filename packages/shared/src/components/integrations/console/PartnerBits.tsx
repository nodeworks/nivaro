import { cn } from '../../../lib/utils'
import { TONE_FILL, TONE_SOFT, TONE_TEXT, type Tone } from './tone'
import type { PartnerCard, PartnerHealth } from './types'

/** Pieces shared by the partner cards and the partner detail sheet. */

export const HEALTH: Record<PartnerHealth, { word: string; tone: Tone; order: number }> = {
  failing: { word: 'Failing', tone: 'negative', order: 0 },
  degraded: { word: 'Some calls failing', tone: 'warning', order: 1 },
  healthy: { word: 'Healthy', tone: 'positive', order: 2 },
  idle: { word: 'No calls in 24h', tone: 'neutral', order: 3 }
}

export function fmtPct(v: number | null): string {
  if (v == null) return '—'
  return `${Number.isInteger(v) ? v : v.toFixed(1)}%`
}

export function fmtMs(v: number | null): string {
  if (v == null) return '—'
  if (v >= 10_000) return `${(v / 1000).toFixed(0)}s`
  if (v >= 1000) return `${(v / 1000).toFixed(1)}s`
  return `${Math.round(v)}ms`
}

export function HealthPill({ health }: { health: PartnerHealth }) {
  const h = HEALTH[health]
  return (
    <span
      data-ic-health={health}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-medium',
        TONE_SOFT[h.tone],
        TONE_TEXT[h.tone]
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', TONE_FILL[h.tone])} />
      {h.word}
    </span>
  )
}

export function PartnerFlags({ card }: { card: PartnerCard }) {
  const flags: Array<{ key: string; label: string; tone: Tone; tip: string }> = []
  if (!card.enabled)
    flags.push({
      key: 'off',
      label: 'Turned off',
      tone: 'neutral',
      tip: 'Nothing is sent while off'
    })
  if (card.flags.auth_failing)
    flags.push({
      key: 'auth',
      label: 'Sign-in failing',
      tone: 'negative',
      tip: 'The latest call was refused at sign-in — check the credentials'
    })
  if (card.flags.test_endpoint)
    flags.push({
      key: 'test',
      label: 'TEST',
      tone: 'warning',
      tip: 'Pointed at a test endpoint on this instance'
    })
  if (card.flags.mock)
    flags.push({
      key: 'mock',
      label: 'MOCK',
      tone: 'warning',
      tip: 'Calls are answered by mock rules, not the partner'
    })
  if (flags.length === 0) return null
  return (
    <span className='flex flex-wrap gap-1'>
      {flags.map((f) => (
        <span
          key={f.key}
          data-ic-flag={f.key}
          data-tip={f.tip}
          className={cn(
            'rounded px-1.5 py-px text-[10.5px] font-semibold tracking-wide',
            TONE_SOFT[f.tone],
            TONE_TEXT[f.tone]
          )}
        >
          {f.label}
        </span>
      ))}
    </span>
  )
}

/** 48 hourly bars, failures stacked on top of successes, oldest on the left. */
export function HourlyBars({
  hourly,
  className
}: {
  hourly: PartnerCard['hourly']
  className?: string
}) {
  const max = Math.max(1, ...hourly.map((h) => h.ok + h.failed))
  const total = hourly.reduce((n, h) => n + h.ok + h.failed, 0)
  return (
    <div className={className}>
      <div
        className='flex h-8 items-end gap-px'
        role='img'
        aria-label={`${total} calls in the last 48 hours`}
        data-ic-sparkline
      >
        {hourly.map((h) => {
          const n = h.ok + h.failed
          const hour = new Date(`${h.hour}:00:00Z`)
          const label = Number.isNaN(hour.getTime())
            ? h.hour
            : hour.toLocaleString(undefined, { weekday: 'short', hour: 'numeric' })
          return (
            <span
              key={h.hour}
              className='flex h-full min-w-0 flex-1 flex-col justify-end'
              data-tip={
                n === 0 ? `${label} · no calls` : `${label} · ${h.ok} ok · ${h.failed} failed`
              }
            >
              {n === 0 ? (
                <span className='h-px w-full bg-border' />
              ) : (
                <>
                  {h.failed > 0 && (
                    <span
                      className={cn('w-full rounded-t-[1px]', TONE_FILL.negative)}
                      style={{ height: `${Math.max(8, (h.failed / max) * 100)}%` }}
                    />
                  )}
                  {h.ok > 0 && (
                    <span
                      className={cn(
                        'w-full opacity-60',
                        TONE_FILL.positive,
                        h.failed === 0 && 'rounded-t-[1px]'
                      )}
                      style={{ height: `${Math.max(8, (h.ok / max) * 100)}%` }}
                    />
                  )}
                </>
              )}
            </span>
          )
        })}
      </div>
      <div className='mt-1 flex justify-between text-[10.5px] text-muted-foreground'>
        <span>48h ago</span>
        <span>now</span>
      </div>
    </div>
  )
}
