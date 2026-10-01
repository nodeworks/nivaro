/**
 * Inspector and ticker links (#1090 #1091 #1092):
 *  - an error row opens its logged request in API Analytics (body + Replay);
 *  - a record id opens the record; a write or error opens its event path (chain sheet);
 *  - a caller opens Inbound calls filtered to it, a person their profile;
 *  - an entity opens where it is configured; a partner opens its external API.
 */
import { lazy, Suspense, useState } from 'react'
import { Link } from 'react-router'
import { useTrafficMap } from '../context'
import { entityLabel } from '../EventTicker'
import { callerLinks, entityUrl, recordUrl, requestUrl } from '../links'
import { eventActions } from '../registry/eventActions'
import { hotColumns } from '../registry/hotColumns'
import { inspectorActions } from '../registry/inspectorActions'
import { register } from '../registry/registry'
import type { TrafficEventWire } from '../types'
import { entityOf, LINK, SafeLink } from './shared'

const PathSheetHost = lazy(() => import('./path-sheet'))

const ROW_LINK =
  'rounded-sm px-1 text-[11px] font-medium text-[var(--tm-accent-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'

function OpenRequest({ ev }: { ev: TrafficEventWire }) {
  return (
    <Link
      to={requestUrl(ev)}
      className={ROW_LINK}
      data-tm-open-request=''
      title='Open this request in API Analytics (body and Replay)'
    >
      Request
    </Link>
  )
}

function OpenRecord({ ev }: { ev: TrafficEventWire }) {
  const url = recordUrl(ev.lane, ev.entity, ev.record)
  if (!url) return null
  return (
    <Link to={url} className={ROW_LINK} data-tm-open-record={ev.record} title={`Open ${ev.record}`}>
      Record
    </Link>
  )
}

function ShowPath({ ev }: { ev: TrafficEventWire }) {
  const [open, setOpen] = useState(false)
  const { catalog } = useTrafficMap()
  if (!ev.chain) return null
  const label = `${entityLabel(catalog, ev.lane, ev.entity)}${ev.record ? ` ${ev.record}` : ''} · ${ev.kind}`
  return (
    <>
      <button
        type='button'
        className={ROW_LINK}
        data-tm-show-path={ev.chain}
        title='Show the event path: request, writes, transitions, partner pushes, flows'
        onClick={() => setOpen(true)}
      >
        Path
      </button>
      {open && (
        <Suspense fallback={null}>
          <PathSheetHost chainId={ev.chain} label={label} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  )
}

register(eventActions, {
  id: 'open-record',
  order: 10,
  applies: (ev) => !!recordUrl(ev.lane, ev.entity, ev.record),
  Component: OpenRecord
})
register(eventActions, {
  id: 'open-request',
  order: 20,
  applies: (ev) => ev.kind === 'error' && !!ev.route,
  Component: OpenRequest
})
register(eventActions, {
  id: 'show-path',
  order: 30,
  // Writes only: a failed or read request's chain holds nothing to draw.
  applies: (ev) =>
    !!ev.chain && (ev.kind === 'create' || ev.kind === 'update' || ev.kind === 'delete'),
  Component: ShowPath
})

/** Inspector header: where the selected node lives elsewhere in the console. */
function NodeLinks({ sel }: { sel: import('../types').Selection }) {
  const { catalog } = useTrafficMap()
  const links: Array<{ label: string; url: string; id: string }> = []
  if (sel.kind === 'caller') {
    for (const l of callerLinks(sel.id, catalog))
      links.push({ label: l.label, url: l.url, id: `tm-caller-${l.kind}` })
  } else if (sel.kind === 'entity') {
    const e = entityOf(sel)
    const url = e ? entityUrl(e.lane, e.entity) : null
    if (url) links.push({ label: 'Open', url, id: 'tm-entity-open' })
    if (e && !e.entity.startsWith('__'))
      links.push({
        label: 'Requests',
        url: `/api-analytics?req_path=${encodeURIComponent(e.lane === 'items' || e.lane === 'system' ? `/api/items/${e.entity}` : e.entity)}`,
        id: 'tm-entity-requests'
      })
  } else if (sel.kind === 'down') {
    const m = sel.id.match(/^ext:(\d+)$/)
    if (m) links.push({ label: 'External API', url: `/external-apis/${m[1]}`, id: 'tm-down-api' })
    if (sel.id === 'db') links.push({ label: 'DB Health', url: '/db-health', id: 'tm-down-db' })
  }
  if (links.length === 0) return null
  return (
    <span className='inline-flex flex-wrap items-center gap-2 text-[12px]' data-tm-node-links=''>
      {links.map((l) => (
        <Link key={l.id} to={l.url} id={l.id} className={LINK}>
          {l.label}
        </Link>
      ))}
    </span>
  )
}

register(inspectorActions, {
  id: 'node-links',
  order: 10,
  applies: (sel) => sel.kind !== 'lane',
  Component: NodeLinks
})

/** Hot entities: a link to where the entity is configured. */
register(hotColumns, {
  id: 'open',
  header: 'Open',
  cell: (row) => {
    const url = entityUrl(row.lane, row.entity)
    if (!url) return null
    return (
      <SafeLink
        to={url}
        className={LINK}
        data-tm-hot-open={row.key}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Open ${row.entity}`}
      >
        Open
      </SafeLink>
    )
  }
})
