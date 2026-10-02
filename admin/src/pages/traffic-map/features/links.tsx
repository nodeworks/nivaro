/**
 * Inspector and ticker links (#1090 #1091 #1092):
 *  - an error row's Request, a record id and a write's Path open in the investigation stack
 *    beside the map (drill-down Wave 0); while nothing is registered to show that kind yet —
 *    or an event carries no request id — each keeps its old behaviour (API Analytics link,
 *    record page, event path sheet) so no row loses its action;
 *  - a caller opens Inbound calls filtered to it, a person their profile;
 *  - an entity opens where it is configured; a partner opens its external API.
 */
import { lazy, Suspense, useState } from 'react'
import { Link } from 'react-router'
import { useTrafficMap } from '../context'
import { entityLabel } from '../EventTicker'
import { openInspect } from '../inspect/stack'
import { callerLinks, entityUrl, recordUrl, requestUrl } from '../links'
import { eventActions } from '../registry/eventActions'
import { hotColumns } from '../registry/hotColumns'
import { inspectableFor } from '../registry/inspectables'
import { inspectorActions } from '../registry/inspectorActions'
import { register } from '../registry/registry'
import type { TrafficEventWire } from '../types'
import { entityOf, LINK, SafeLink } from './shared'

const PathSheetHost = lazy(() => import('./path-sheet'))

const ROW_LINK =
  'rounded-sm px-1 text-[11px] font-medium text-[var(--tm-accent-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'

function OpenRequest({ ev }: { ev: TrafficEventWire }) {
  const rid = ev.rid
  if (rid && inspectableFor('request')) {
    return (
      <button
        type='button'
        className={ROW_LINK}
        data-tm-open-request={rid}
        title='Inspect this request: trace, statements, body'
        onClick={(e) => {
          e.stopPropagation()
          openInspect({ kind: 'request', id: rid, at: ev.t, label: ev.route }, { root: true })
        }}
      >
        Request
      </button>
    )
  }
  return (
    <Link
      to={requestUrl(ev)}
      className={ROW_LINK}
      data-tm-open-request=''
      title='Open this request in API Analytics (body and Replay)'
      onClick={(e) => e.stopPropagation()}
    >
      Request
    </Link>
  )
}

function OpenRecord({ ev }: { ev: TrafficEventWire }) {
  const url = recordUrl(ev.lane, ev.entity, ev.record)
  const record = ev.record
  if (!url || !record) return null
  if (inspectableFor('record')) {
    return (
      <button
        type='button'
        className={ROW_LINK}
        data-tm-open-record={record}
        title={`Inspect ${record}`}
        onClick={(e) => {
          e.stopPropagation()
          openInspect(
            {
              kind: 'record',
              id: `${ev.entity}:${record}`,
              at: ev.t,
              label: `${ev.entity} ${record}`
            },
            { root: true }
          )
        }}
      >
        Record
      </button>
    )
  }
  return (
    <Link
      to={url}
      className={ROW_LINK}
      data-tm-open-record={record}
      title={`Open ${record}`}
      onClick={(e) => e.stopPropagation()}
    >
      Record
    </Link>
  )
}

function ShowPath({ ev }: { ev: TrafficEventWire }) {
  const [open, setOpen] = useState(false)
  const { catalog } = useTrafficMap()
  const chain = ev.chain
  if (!chain) return null
  const label = `${entityLabel(catalog, ev.lane, ev.entity)}${ev.record ? ` ${ev.record}` : ''} · ${ev.kind}`
  const inStack = !!inspectableFor('chain')
  return (
    <>
      <button
        type='button'
        className={ROW_LINK}
        data-tm-show-path={chain}
        title='Show the event path: request, writes, transitions, partner pushes, flows'
        onClick={(e) => {
          e.stopPropagation()
          if (inStack) openInspect({ kind: 'chain', id: chain, at: ev.t, label }, { root: true })
          else setOpen(true)
        }}
      >
        Path
      </button>
      {open && !inStack && (
        <Suspense fallback={null}>
          <PathSheetHost chainId={chain} label={label} onClose={() => setOpen(false)} />
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
