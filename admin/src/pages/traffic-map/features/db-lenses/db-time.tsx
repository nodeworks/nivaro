/**
 * #1174 — interactive vs background database time. A summary-strip tile: the share of the
 * window's database time spent serving people (session requests) against integrations, cron
 * jobs, imports, flows and other background work, as a stacked bar; the heaviest cron job and,
 * when it runs in a busy hour, the quietest hour of the day to move it to (7 days of the api log).
 */
import { Link } from 'react-router'
import { useTrafficMap } from '../../context'
import { register } from '../../registry/registry'
import { stripTiles } from '../../registry/stripTiles'
import { inMapOnly, LINK, StripCell } from '../ops-common'
import {
  DB_TIME_LABEL,
  type DbTimeCategory,
  type DbTimeSplit,
  hourLabel,
  pct,
  secs,
  splitSegments
} from './logic'
import { useDbLens } from './shared'

const COLOR: Record<DbTimeCategory, string> = {
  people: 'var(--tm-accent)',
  integrations: 'var(--tm-read)',
  cron: 'var(--tm-update)',
  import: 'var(--tm-create)',
  flow: 'var(--tm-inferred)',
  other: 'var(--tm-muted)'
}

export function DbTimeTile() {
  const { win } = useTrafficMap()
  const { data } = useDbLens<DbTimeSplit>('db-time', { params: { window: win }, every: 15_000 })
  const segs = splitSegments(data)
  const sug = data?.suggestion
  const title = segs
    .map((s) => `${DB_TIME_LABEL[s.key]} ${pct(s.share)} (${secs(data?.ms[s.key] ?? 0)})`)
    .join(' · ')
  return (
    <StripCell
      label='Database time'
      value={data && data.total_ms > 0 ? pct(data.interactive) : '—'}
      unit='people'
      testId='tm-strip-db-time'
    >
      <span
        className='flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--tm-line-2)]'
        role='img'
        aria-label={title || 'No database time measured yet'}
        title={title}
        data-tm-db-time={data ? Math.round(data.interactive * 100) : ''}
      >
        {segs.map((s) => (
          <span key={s.key} style={{ width: `${s.share * 100}%`, background: COLOR[s.key] }} />
        ))}
      </span>
      <span className='truncate tabular-nums' title={title}>
        {data && data.total_ms > 0
          ? `background ${pct(data.background)} · integrations ${pct(data.share.integrations)}`
          : 'nothing measured in this window'}
      </span>
      {data?.heaviest_cron ? (
        <span className='flex min-w-0 items-center justify-between gap-2'>
          <span
            className='truncate'
            title={
              sug
                ? `${sug.reason}${sug.move ? ` Consider ${hourLabel(sug.quiet_hour)} (${sug.zone}).` : ''}`
                : undefined
            }
            data-tm-db-time-suggest={sug?.move ? hourLabel(sug.quiet_hour) : ''}
          >
            {sug?.move
              ? `${data.heaviest_cron.id}: quieter at ${hourLabel(sug.quiet_hour)}`
              : `heaviest cron ${data.heaviest_cron.id} ${secs(data.heaviest_cron.ms)}`}
          </span>
          <Link to='/background-jobs' className={`${LINK} shrink-0`}>
            Jobs
          </Link>
        </span>
      ) : null}
    </StripCell>
  )
}

register(stripTiles, { id: 'db-time', order: 14, Component: inMapOnly(DbTimeTile) })
