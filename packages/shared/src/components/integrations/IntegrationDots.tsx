import { dotsForRecord } from '../../lib/integration-dots'
import { colorPair } from '../QueryTable'
import { roleForTone } from './IntegrationObligationsView'

/**
 * One dot per partner, on the record where people already work — the
 * collection browser and the queue tables. Purely presentational: the host
 * fetches `POST /integration-obligations/summary` once per PAGE (the
 * `__addendums__` column precedent) and hands each row its own slice.
 *
 * `roleForTone` comes from `IntegrationObligationsView` (the board) so this,
 * the board and `IntegrationStatusBanner` can never disagree about what
 * "overdue" looks like.
 */

const TONE_WORD: Record<'positive' | 'warning' | 'danger' | 'neutral', string> = {
  danger: 'behind',
  warning: 'in progress',
  positive: 'sent',
  neutral: 'unknown'
}

/** The filter-pill set the collection browser offers (its own conditions[]
 *  round trip to `/items/:collection` — the queue has no equivalent server
 *  path, so it gets the column but not the filter). Values are the same
 *  bucket names `applyIntegrationsFilter` (api/src/services/items.ts) reads,
 *  so a picked value needs no translation before it rides a condition. */
export const INTEGRATIONS_FILTER_OPTIONS = [
  { value: 'danger', label: 'Overdue, failed or missing' },
  { value: 'warning', label: 'Pending or skipped' },
  { value: 'positive', label: 'Sent' },
  { value: 'none', label: 'No integration' }
]

export interface IntegrationDotsProps {
  rows: Array<{ api: string; outcome: string }> | undefined
  className?: string
}

export function IntegrationDots({ rows, className }: IntegrationDotsProps) {
  const dots = dotsForRecord(rows ?? [])
  if (dots.length === 0) return <span className='text-[12px] text-slate-300'>—</span>

  return (
    <span
      data-integration-dots
      aria-label={dots.map((d) => `${d.api}: ${TONE_WORD[d.tone]}`).join(', ')}
      className={`inline-flex items-center gap-1 ${className ?? ''}`.trim()}
    >
      {dots.map((d) => {
        const role = roleForTone(d.tone)
        const [accent, accentDark] = role ? colorPair(role) : [null, null]
        return (
          <span
            key={d.api}
            data-integration-dot={d.api}
            data-integration-dot-tone={d.tone}
            data-tip={`${d.api}: ${TONE_WORD[d.tone]}`}
            aria-hidden
            style={
              accent
                ? ({ '--obt': accent, '--obtd': accentDark } as unknown as React.CSSProperties)
                : undefined
            }
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              accent
                ? 'bg-[color:var(--obt)] dark:bg-[color:var(--obtd)]'
                : 'bg-slate-400 dark:bg-slate-600'
            }`}
          />
        )
      })}
    </span>
  )
}
