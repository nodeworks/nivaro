/**
 * #2162 — Edit locks lens. Records whose edit lock has been held a long time or is wanted by
 * someone else: who holds it, how long, how long since the holder's browser last checked in
 * (idle), the people waiting (their lock requests) and the record one click away.
 */
import { Link } from 'react-router'
import { fmtCount } from '../../EventTicker'
import { pagePanels } from '../../registry/pagePanels'
import { register } from '../../registry/registry'
import { inMapOnly, LINK, PanelCard, useTmRoute } from '../ops-common'
import { fmtSpan } from './logic'

interface LockRow {
  collection: string
  item: string
  holder: { id: string | null; name: string }
  held_ms: number
  idle_ms: number
  note: string | null
  waiting: Array<{ id: string | null; name: string; waited_ms: number }>
  reasons: Array<'long' | 'contested'>
}
interface LockLens {
  active: number
  rows: LockRow[]
  truncated: boolean
}

/** A holder whose browser has not checked in for this long is probably gone. */
const IDLE_WARN_MS = 90_000

function EditLocksPanel() {
  const { data, loading } = useTmRoute<LockLens>(['edit-locks'], '/edit-locks', 15_000)
  const rows = data?.rows ?? []
  return (
    <PanelCard
      id='tm-edit-locks'
      title='Edit locks'
      hint={
        data
          ? `${fmtCount(rows.length)} long-held or contested of ${fmtCount(data.active)} held`
          : 'Records someone is holding for edit'
      }
    >
      <div data-tm-edit-locks={rows.length}>
        {loading && !data ? (
          <p className='px-3.5 py-3 text-[12px] text-[var(--tm-muted)]'>Reading edit locks…</p>
        ) : rows.length === 0 ? (
          <p className='px-3.5 py-3 text-[12px] text-[var(--tm-muted)]'>
            No lock is held for long or wanted by someone else right now.
          </p>
        ) : (
          <ul className='divide-y divide-[var(--tm-line-2)]'>
            {rows.map((r) => (
              <li
                key={`${r.collection}/${r.item}`}
                className='grid min-w-0 gap-0.5 px-3.5 py-2 text-[12px]'
                data-tm-lock={`${r.collection}/${r.item}`}
              >
                <div className='flex min-w-0 items-baseline gap-2'>
                  <Link
                    to={`/collections/${encodeURIComponent(r.collection)}/${encodeURIComponent(r.item)}`}
                    className={`${LINK} min-w-0 truncate font-mono text-[11.5px]`}
                    title='Open the record'
                  >
                    {r.collection}/{r.item}
                  </Link>
                  <span className='ml-auto shrink-0 tabular-nums text-[var(--tm-muted)]'>
                    held {fmtSpan(r.held_ms)}
                  </span>
                </div>
                <div className='flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11.5px] text-[var(--tm-fg-2)]'>
                  <span className='min-w-0 truncate'>
                    Held by <span className='font-medium text-[var(--tm-fg)]'>{r.holder.name}</span>
                  </span>
                  <span
                    className={
                      r.idle_ms >= IDLE_WARN_MS
                        ? 'text-[var(--tm-update)]'
                        : 'text-[var(--tm-muted)]'
                    }
                  >
                    idle {fmtSpan(r.idle_ms)}
                  </span>
                  {r.note ? (
                    <span className='min-w-0 truncate text-[var(--tm-muted)]' title={r.note}>
                      “{r.note}”
                    </span>
                  ) : null}
                </div>
                {r.waiting.length > 0 && (
                  <div className='text-[11.5px] text-[var(--tm-fg-2)]' data-tm-lock-queue=''>
                    Waiting:{' '}
                    {r.waiting
                      .map((w, i) => `${i + 1}. ${w.name} (${fmtSpan(w.waited_ms)})`)
                      .join('  ')}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {data?.truncated && (
          <p className='border-t border-[var(--tm-line-2)] px-3.5 py-2 text-[11.5px] text-[var(--tm-muted)]'>
            Only the worst 50 are listed.
          </p>
        )}
      </div>
    </PanelCard>
  )
}

register(pagePanels, { id: 'edit-locks', order: 70, Component: inMapOnly(EditLocksPanel) })
