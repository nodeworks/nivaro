import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../context'
import { t as clock, Empty, Section } from '../Inspector'
import { requestUrl } from '../links'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import type { Selection, TrafficCatalog } from '../types'
import { ago, inPage } from './b1-shared'
import { BTN, LINK, SafeLink } from './shared'

/**
 * #1183 — sampled payload peek on an inbound partner edge: the caller's last five logged request
 * bodies (token / API-key writes, which the request log keeps) and error texts, secrets masked by
 * the server. On an entity selected through one caller's edge the list narrows to that entity's
 * path. Admin-only, like the rest of the map.
 */
export interface PayloadRow {
  id: number
  at: string
  method: string | null
  path: string | null
  status: number | null
  auth: string | null
  body: string | null
  truncated: boolean
  error: string | null
}

/** Pretty-print a JSON body; anything else as it came. */
export function prettyBody(raw: string | null): string {
  if (!raw) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** True for a caller whose payloads the request log keeps: API keys and machine accounts. */
export function isPartnerCaller(id: string, cat: TrafficCatalog | null): boolean {
  if (/^k\d+$/.test(id)) return true
  return /^u/.test(id) && cat?.callers[id]?.kind === 'machine'
}

/** The caller and (on an edge selection) entity a selection asks about; null when it does not. */
export function peekTarget(
  sel: Selection,
  cat: TrafficCatalog | null
): { caller: string; entity: string | null } | null {
  if (sel.kind === 'caller')
    return isPartnerCaller(sel.id, cat) ? { caller: sel.id, entity: null } : null
  if (sel.kind === 'entity' && sel.caller && isPartnerCaller(sel.caller, cat)) {
    const cut = sel.id.indexOf('/')
    const lane = sel.id.slice(0, cut)
    // only lanes whose request path carries the entity name can be narrowed by it
    const entity = ['items', 'inbound', 'files'].includes(lane) ? sel.id.slice(cut + 1) : null
    return { caller: sel.caller, entity }
  }
  return null
}

function PayloadPeek({ sel }: { sel: Selection }) {
  const { catalog } = useTrafficMap()
  const target = peekTarget(sel, catalog)
  const [open, setOpen] = useState<number | null>(null)
  const q = useQuery({
    queryKey: ['traffic-map', 'payloads', target?.caller, target?.entity],
    queryFn: async () => {
      const res = await api.get('/traffic-map/payloads', {
        params: { caller: target?.caller, ...(target?.entity ? { entity: target.entity } : {}) }
      })
      return (res.data.data ?? []) as PayloadRow[]
    },
    enabled: !!target,
    staleTime: 15_000,
    refetchInterval: 30_000
  })
  if (!target) return null
  const rows = q.data ?? []
  return (
    <Section title='Recent payloads'>
      <div className='grid gap-1.5 text-[12px]' id='tm-payloads' data-tm-payloads={target.caller}>
        {q.isLoading ? (
          <Empty>Reading the request log…</Empty>
        ) : q.isError ? (
          <Empty>Could not read the request log.</Empty>
        ) : rows.length === 0 ? (
          <Empty>
            No logged bodies in the last 3 days. The log keeps request bodies for API-key and token
            writes only.
          </Empty>
        ) : (
          rows.map((r) => {
            const isOpen = open === r.id
            const failed = (r.status ?? 0) >= 400
            return (
              <div
                key={r.id}
                className='min-w-0 rounded-md border border-[var(--tm-line-2)]'
                data-tm-payload={String(r.id)}
              >
                <button
                  type='button'
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : r.id)}
                  className='flex w-full min-w-0 items-center gap-2 px-2 py-1 text-left hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                >
                  <span
                    className={cn(
                      'shrink-0 font-mono text-[11px] tabular-nums',
                      failed ? 'text-[var(--tm-error-ink)]' : 'text-[var(--tm-fg-2)]'
                    )}
                  >
                    {r.status ?? '—'}
                  </span>
                  <span
                    className='min-w-0 flex-1 truncate font-mono text-[11px]'
                    title={r.path ?? ''}
                  >
                    {r.method} {r.path}
                  </span>
                  <span className='shrink-0 text-[11px] text-[var(--tm-muted)]' title={clock(r.at)}>
                    {ago(r.at)}
                  </span>
                </button>
                {isOpen && (
                  <div className='grid gap-1 border-t border-[var(--tm-line-2)] px-2 py-1.5'>
                    {r.body ? (
                      <pre className='max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--tm-card-2)] p-1.5 font-mono text-[11px] text-[var(--tm-fg)]'>
                        {prettyBody(r.body)}
                      </pre>
                    ) : (
                      <Empty>No body was logged for this request.</Empty>
                    )}
                    {r.truncated && (
                      <p className='text-[11px] text-[var(--tm-muted)]'>
                        The log keeps the first 64 KB of a body.
                      </p>
                    )}
                    {r.error && (
                      <p className='break-words font-mono text-[11px] text-[var(--tm-error-ink)]'>
                        {r.error}
                      </p>
                    )}
                    <SafeLink
                      to={requestUrl({
                        t: Date.parse(r.at),
                        route: `${r.method ?? 'GET'} ${r.path ?? ''}`,
                        status: r.status ?? undefined,
                        caller: target.caller
                      })}
                      className={cn(LINK, 'text-[11.5px]')}
                      data-tm-payload-open={String(r.id)}
                    >
                      Open in API Analytics (Replay)
                    </SafeLink>
                  </div>
                )}
              </div>
            )
          })
        )}
        {rows.length > 0 && (
          <p className='text-[11.5px] text-[var(--tm-muted)]'>Secrets are masked.</p>
        )}
        {q.isFetched && (
          <button
            type='button'
            className={cn(BTN, 'justify-self-start')}
            onClick={() => void q.refetch()}
            disabled={q.isFetching}
          >
            Refresh
          </button>
        )}
      </div>
    </Section>
  )
}

register(inspectorPanels, {
  id: 'payload-peek',
  order: 70,
  applies: (sel, _d) => sel.kind === 'caller' || (sel.kind === 'entity' && !!sel.caller),
  Component: inPage(PayloadPeek)
})
