/** Lists more than one background panel / footer shows. */
import { InspectLink } from '../../inspect/InspectLink'
import { fmtWhen, isoMs, type SubmissionRow } from './logic'
import { LIST, Row, StatusPill } from './ui'

/** Partner pushes, each opening its submission level. */
export function SubmissionList({ rows }: { rows: SubmissionRow[] }) {
  return (
    <ul className={LIST} data-tm-inspect-submission-list={rows.length}>
      {rows.map((s) => (
        <Row
          key={s.id}
          aside={
            <span className='inline-flex items-center gap-1.5'>
              <StatusPill status={s.status} />
              {fmtWhen(s.created_at)}
            </span>
          }
        >
          <InspectLink
            inspectRef={{
              kind: 'submission',
              id: String(s.id),
              at: isoMs(s.created_at),
              label: `Push #${s.id}${s.api_name ? ` → ${s.api_name}` : ''}`
            }}
          >
            {`#${s.id} → ${s.api_name ?? 'unknown partner'}`}
          </InspectLink>
          <span className='ml-1.5 text-[var(--tm-muted)]'>
            {[s.collection, s.item].filter(Boolean).join(' ')}
          </span>
        </Row>
      ))}
    </ul>
  )
}
