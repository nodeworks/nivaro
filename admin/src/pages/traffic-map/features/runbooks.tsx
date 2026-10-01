/**
 * #1158 — runbook links per node: `runbook:` lines in an Environments component's notes (matched
 * by component name, or `runbook <node>: <url>` for any node) and the runbooks an extension
 * declares (on its extension node).
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '@/lib/api'
import type { InspectorData } from '../Inspector'
import { inspectorActions } from '../registry/inspectorActions'
import { register } from '../registry/registry'
import type { Selection } from '../types'
import { LINK } from './shared'

export interface RunbookEntry {
  match: string[]
  label: string
  url: string
  source: 'environment' | 'extension'
  detail: string
}

/** The runbooks that name this node by id, entity, label or partner name (pure). */
export function runbooksFor(entries: RunbookEntry[], sel: Selection, name: string): RunbookEntry[] {
  const keys = new Set<string>([sel.id.toLowerCase(), name.toLowerCase()])
  if (sel.kind === 'entity') keys.add(sel.id.slice(sel.id.indexOf('/') + 1).toLowerCase())
  const seen = new Set<string>()
  return entries.filter((r) => {
    if (!r.match.some((m) => keys.has(m))) return false
    const k = `${r.label}|${r.url}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function Runbooks({ sel, d }: { sel: Selection; d: InspectorData }) {
  const q = useQuery({
    queryKey: ['traffic-map', 'runbooks'],
    queryFn: async () =>
      ((await api.get('/traffic-map/runbooks'))?.data as { data?: { entries?: RunbookEntry[] } })
        ?.data?.entries ?? [],
    staleTime: 60_000
  })
  const list = runbooksFor(q.data ?? [], sel, d.name)
  if (list.length === 0) return null
  return (
    <span className='inline-flex flex-wrap items-center gap-2 text-[12px]' data-tm-runbooks=''>
      {list.slice(0, 3).map((r) =>
        /^https?:\/\//i.test(r.url) ? (
          <a
            key={`${r.label}|${r.url}`}
            href={r.url}
            target='_blank'
            rel='noreferrer noopener'
            className={LINK}
            title={r.detail}
            data-tm-runbook={r.source}
          >
            {r.label}
          </a>
        ) : (
          <Link
            key={`${r.label}|${r.url}`}
            to={r.url}
            className={LINK}
            title={r.detail}
            data-tm-runbook={r.source}
          >
            {r.label}
          </Link>
        )
      )}
    </span>
  )
}

register(inspectorActions, {
  id: 'runbooks',
  order: 20,
  applies: () => true,
  Component: Runbooks
})
