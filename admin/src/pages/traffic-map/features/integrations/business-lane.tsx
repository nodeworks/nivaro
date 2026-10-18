/**
 * #2189 — Business events lane. What the business did per minute (records created, transitions,
 * approvals, imports finished, partner pushes accepted), counts only, drawn beside the API's own
 * requests per minute so a quiet API can be told from quiet business, and a drop in approvals
 * stands out even when requests look normal.
 */
import { useMemo } from 'react'
import { useTrafficMap } from '../../context'
import { fmtCount } from '../../EventTicker'
import { pagePanels } from '../../registry/pagePanels'
import { register } from '../../registry/registry'
import { Sparkline } from '../../Sparkline'
import { inMapOnly, PanelCard, useTmRoute } from '../ops-common'
import { type BusinessEvents, businessVerdict } from './logic'

/** The lane covers the last 15 minutes: the longest window the map keeps per second. */
const MINUTES = 15

function Row({
  id,
  label,
  points,
  total,
  color,
  note
}: {
  id: string
  label: string
  points: number[]
  total: number
  color: string
  note?: string
}) {
  return (
    <li
      className='grid grid-cols-[minmax(120px,1fr)_minmax(80px,2fr)_auto] items-center gap-3 px-3.5 py-1.5 text-[12px]'
      data-tm-business-row={id}
    >
      <span className='min-w-0 truncate text-[var(--tm-fg-2)]'>
        {label}
        {note ? <span className='ml-1 text-[var(--tm-muted)]'>({note})</span> : null}
      </span>
      <Sparkline data={points} color={color} className='h-6 w-full' />
      <span className='w-14 text-right tabular-nums'>{fmtCount(total)}</span>
    </li>
  )
}

function BusinessLane() {
  const { model, tick, paused } = useTrafficMap()
  const { data } = useTmRoute<BusinessEvents>(
    ['business-events'],
    `/business-events?minutes=${MINUTES}`,
    paused ? 60_000 : 20_000
  )
  // API requests per minute over the same minutes, summed over every entity the map holds
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick marks a new frame
  const tech = useMemo(() => {
    const out = new Array<number>(MINUTES).fill(0)
    for (const key of model.entityKeys()) {
      const s = model.entitySeries(key, 900, MINUTES)
      for (let i = 0; i < MINUTES; i++) out[i] += s[i] ?? 0
    }
    return out
  }, [model, tick])
  const verdict = useMemo(() => (data ? businessVerdict(tech, data.series) : null), [data, tech])
  if (!data) return null
  const techTotal = tech.reduce((a, b) => a + b, 0)
  return (
    <PanelCard
      id='tm-business-lane'
      title='Business activity'
      hint={`Per minute, last ${MINUTES} minutes. Counts only, beside the API's own requests.`}
    >
      <div data-tm-business={verdict?.kind ?? 'ok'}>
        {verdict?.text && (
          <p
            className={`border-b border-[var(--tm-line-2)] px-3.5 py-2 text-[12px] ${
              verdict.kind === 'business-drop'
                ? 'text-[var(--tm-error-ink)]'
                : 'text-[var(--tm-update)]'
            }`}
            role='status'
            data-tm-business-verdict=''
          >
            {verdict.text}
          </p>
        )}
        <ul className='divide-y divide-[var(--tm-line-2)]'>
          <Row
            id='api'
            label='API requests'
            points={tech}
            total={techTotal}
            color='var(--tm-fg-2)'
          />
          {data.series.map((s) => (
            <Row
              key={s.key}
              id={s.key}
              label={s.label}
              points={s.points}
              total={s.total}
              color={verdict?.drops.includes(s.key) ? 'var(--tm-error)' : 'var(--tm-accent)'}
              note={s.unavailable ? 'not recorded here' : s.truncated ? 'partial' : undefined}
            />
          ))}
        </ul>
        {data.collections.length > 0 && (
          <p className='border-t border-[var(--tm-line-2)] px-3.5 py-2 text-[11.5px] text-[var(--tm-muted)]'>
            Created most in:{' '}
            {data.collections.map((c) => `${c.collection} ${fmtCount(c.created)}`).join(', ')}
          </p>
        )}
      </div>
    </PanelCard>
  )
}

register(pagePanels, { id: 'business-lane', order: 69, Component: inMapOnly(BusinessLane) })
