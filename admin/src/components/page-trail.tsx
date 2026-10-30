import { displayTrail, setTrailLabel, trailChain, useNavTrail } from '@nivaro/shared'
import { useQueries, useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { type MouseEvent, useEffect, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { api } from '@/lib/api'
import { describePath, isTrailRoot, type PathKind, structuralCrumbs } from '@/lib/page-trail'
import { cn, titleCase } from '@/lib/utils'

/**
 * #3225 — breadcrumbs that know the path. Shows how this tab actually got here
 * (the per-tab trail AppLayout records, shared lib/nav-trail.ts), each crumb
 * going BACK that many history entries — so the page returns exactly as left:
 * same URL (filters, tab) and the scroll position the trail remembered. The
 * nearest crumb is the same entry the page's back arrow (useGoBack) returns
 * to. A cold load (nothing in this tab's trail) shows the fixed hierarchy
 * instead: Collections › <collection> › record.
 *
 * Labels are read as the viewer: a page names itself (`currentLabel`), records
 * through /global-search/labels, collections through their metadata, queues
 * through the queue itself. Cmd/Ctrl/middle-click opens a crumb in a new tab.
 */
type Crumb = { id: string; href: string; delta: number | null; label?: string; kind: PathKind }

const histIdx = () => (window.history.state as { idx?: number } | null)?.idx ?? 0

export function PageTrail({
  currentLabel,
  currentAs = 'span',
  showCurrent = true,
  className
}: {
  /** The page's own name — stored on this history entry so later crumbs show it. */
  currentLabel?: string | null
  currentAs?: 'h1' | 'span'
  showCurrent?: boolean
  className?: string
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const trail = useNavTrail()
  const here = location.pathname + location.search + location.hash

  useEffect(() => {
    if (currentLabel) setTrailLabel(currentLabel, location.key)
  }, [currentLabel, location.key])

  const crumbs: Crumb[] = useMemo(() => {
    const idx = histIdx()
    const chain = trailChain({ entries: trail.entries, current: { key: location.key, idx } })
    const walked = displayTrail(chain, { idx, path: here }, { isRoot: isTrailRoot })
    if (walked.length > 0) {
      return walked.map((c) => ({
        id: c.key,
        href: c.path,
        delta: c.delta,
        label: c.label,
        kind: describePath(c.path)
      }))
    }
    return structuralCrumbs(location.pathname).map((c) => ({
      id: c.to,
      href: c.to,
      delta: null,
      kind: c.kind
    }))
  }, [trail.entries, location.key, location.pathname, here])

  const labels = useCrumbLabels(crumbs)

  if (crumbs.length === 0 && !showCurrent) return null

  const go = (e: MouseEvent<HTMLAnchorElement>, c: Crumb) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    if (c.delta != null && c.delta < 0) navigate(c.delta)
    else navigate(c.href)
  }

  const Current = currentAs
  return (
    <nav
      aria-label='Breadcrumb'
      className={cn('flex min-w-0 items-center text-[12.5px]', className)}
      data-page-trail={crumbs.length > 0 && crumbs[0].delta != null ? 'walked' : 'structural'}
    >
      <ol className='flex min-w-0 items-center gap-1'>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1
          return (
            <li
              key={c.id}
              // At phone width only the nearest crumb shows; the rest fold away.
              className={cn('min-w-0 items-center gap-1', last ? 'flex' : 'hidden sm:flex')}
            >
              <a
                href={c.href}
                onClick={(e) => go(e, c)}
                className='block max-w-[180px] truncate rounded text-slate-500 transition-colors hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-slate-400 dark:hover:text-slate-100'
                data-trail-crumb={c.delta ?? 'structural'}
                data-tip={c.delta != null ? 'Back to where you were' : undefined}
              >
                {c.label || labels[c.id] || fallbackLabel(c.kind)}
              </a>
              {(showCurrent || !last) && (
                <ChevronRight
                  className='h-3.5 w-3.5 shrink-0 text-slate-300 dark:text-slate-600'
                  aria-hidden
                />
              )}
            </li>
          )
        })}
        {showCurrent && (
          <li className='flex min-w-0 items-center' aria-current='page'>
            <Current className='truncate font-semibold text-slate-900 dark:text-slate-100'>
              {currentLabel || fallbackLabel(describePath(location.pathname))}
            </Current>
          </li>
        )}
      </ol>
    </nav>
  )
}

function fallbackLabel(kind: PathKind): string {
  switch (kind.kind) {
    case 'static':
      return kind.label
    case 'record':
      return `${titleCase(kind.collection)} #${kind.id}`
    case 'new-record':
      return `New ${titleCase(kind.collection)}`
    case 'collection':
      return titleCase(kind.collection)
    case 'queue':
      return 'Queue'
  }
}

/** Labels for crumbs that carry none, read as the viewer. Keyed by crumb id. */
function useCrumbLabels(crumbs: Crumb[]): Record<string, string> {
  const need = crumbs.filter((c) => !c.label)
  const records = need.filter(
    (c): c is Crumb & { kind: { kind: 'record'; collection: string; id: string } } =>
      c.kind.kind === 'record'
  )
  const refs = records.map((c) => `${c.kind.collection}:${c.kind.id}`)
  const refsKey = [...new Set(refs)].sort().join(',')
  const recordLabels = useQuery({
    queryKey: ['page-trail', 'labels', refsKey],
    queryFn: () =>
      api
        .get<{ data: Record<string, string> }>(
          `/global-search/labels?refs=${refsKey
            .split(',')
            .map((r) => encodeURIComponent(r))
            .join(',')}`
        )
        .then((r) => r.data.data ?? {}),
    enabled: refsKey !== '',
    staleTime: 5 * 60_000,
    retry: false
  })
  const collections = [
    ...new Set(
      need.flatMap((c) =>
        c.kind.kind === 'collection' || c.kind.kind === 'new-record' ? [c.kind.collection] : []
      )
    )
  ]
  const collectionNames = useQueries({
    queries: collections.map((collection) => ({
      queryKey: ['page-trail', 'collection', collection],
      queryFn: () =>
        api
          .get<{ data: { display_name?: string | null } }>(`/collections/${collection}`)
          .then((r) => r.data.data?.display_name ?? null),
      staleTime: 10 * 60_000,
      retry: false
    }))
  })
  const queues = [...new Set(need.flatMap((c) => (c.kind.kind === 'queue' ? [c.kind.id] : [])))]
  const queueNames = useQueries({
    queries: queues.map((id) => ({
      queryKey: ['page-trail', 'queue', id],
      queryFn: () =>
        api
          .get<{ data: { name?: string | null } }>(`/queues/${encodeURIComponent(id)}`)
          .then((r) => r.data.data?.name ?? null),
      staleTime: 10 * 60_000,
      retry: false
    }))
  })

  const out: Record<string, string> = {}
  const colName = new Map(collections.map((c, i) => [c, collectionNames[i]?.data ?? null]))
  const queueName = new Map(queues.map((q, i) => [q, queueNames[i]?.data ?? null]))
  for (const c of need) {
    const k = c.kind
    let label: string | null | undefined = null
    if (k.kind === 'record') label = recordLabels.data?.[`${k.collection}:${k.id}`]
    else if (k.kind === 'collection') label = colName.get(k.collection)
    else if (k.kind === 'new-record') {
      const n = colName.get(k.collection)
      label = n ? `New ${n}` : null
    } else if (k.kind === 'queue') label = queueName.get(k.id)
    if (label) out[c.id] = label
  }
  return out
}
