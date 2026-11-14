import { QueryErrorState } from '@nivaro/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, ExternalLink, UserCheck } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn, formatDate, formatNumber, formatRelative } from '@/lib/utils'

/**
 * Coverage › No owner — open records on a step with owner-only moves that
 * nobody is ASSIGNED to own (no owner group matches them, no instance owner).
 * The creator may still see them "in their queue" (the binding's fallback),
 * but owner-only moves judge assigned owners, so only an administrator can
 * move them. GET /api/coverage-gaps/no-owner (services/no-owner-steps.ts).
 */

interface Dim {
  field: string
  label: string
  value: string
}

interface Cluster {
  key: string
  count: number
  dims: Dim[]
  uncovered: Dim[]
  reason: string
  suggestion: { group_label: string | null; missing_labels: string[] } | null
}

interface SampleRecord {
  item: string
  label: string
  creator: { id: string; name: string } | null
  stand_in: string[]
  since: string | null
  cluster: string | null
}

export interface NoOwnerGroup {
  template_id: string
  template_name: string
  state_id: string
  state_key: string
  state_label: string
  collection: string
  collection_label: string
  count: number
  moves: Array<{ id: string; label: string; allow_creator: boolean; conditional: boolean }>
  clusters: Cluster[]
  ungrouped: number
  conditions_unchecked: number
  sample: SampleRecord[]
  matrix_href: string
}

export interface NoOwnerReport {
  computed_at: string
  checked: number
  total: number
  groups: NoOwnerGroup[]
}

const QUERY_KEY = ['coverage', 'no-owner']

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <p className='text-[11px] uppercase tracking-wide text-muted-foreground'>{label}</p>
      <p className={cn('mt-1 text-[20px] font-semibold tabular-nums', tone)}>{value}</p>
    </div>
  )
}

function ValueChips({ dims, uncovered }: { dims: Dim[]; uncovered: Dim[] }) {
  const missing = new Set(uncovered.map((u) => `${u.field}|${u.value}`))
  if (dims.length === 0)
    return <span className='text-[12px] text-muted-foreground'>No dimension values</span>
  return (
    <span className='flex flex-wrap gap-1'>
      {dims.map((d) => {
        const gap = missing.has(`${d.field}|${d.value}`)
        // "Zone 1" already says Zone — never "Zone Zone 1".
        const saysLabel = d.value.toLowerCase().startsWith(d.label.toLowerCase())
        return (
          <span
            key={`${d.field}|${d.value}`}
            data-uncovered={gap ? '' : undefined}
            data-tip={gap ? `No owner group of this step names ${d.label} ${d.value}` : undefined}
            className={cn(
              'inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11.5px]',
              gap
                ? 'bg-amber-400/15 font-medium text-amber-800 ring-1 ring-amber-500/30 dark:text-amber-300'
                : 'bg-slate-100 text-slate-700 dark:bg-muted dark:text-slate-300'
            )}
          >
            {!saysLabel && <span className='font-normal text-muted-foreground'>{d.label}</span>}
            {d.value}
          </span>
        )
      })}
    </span>
  )
}

/** Value words a person reads ("Zone 1", "Project Type Full Duplex"). */
const valueText = (d: Dim) =>
  d.value.toLowerCase().startsWith(d.label.toLowerCase()) ? d.value : `${d.label} ${d.value}`

/** The cause in a few words; the full sentence is the tip. */
export function shortReason(c: Pick<Cluster, 'uncovered' | 'dims' | 'reason'>): string {
  if (c.uncovered.length > 0) return `No group covers ${c.uncovered.map(valueText).join(' or ')}`
  if (c.dims.length === 0) return 'No owner group on this step matches them'
  return 'No owner group matches this combination'
}

function StepCard({ group, defaultOpen }: { group: NoOwnerGroup; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const [allClusters, setAllClusters] = useState(false)
  const clusters = allClusters ? group.clusters : group.clusters.slice(0, 5)
  const clusterLabel = new Map(
    group.clusters.map((c) => [c.key, c.dims.map((d) => d.value).join(' · ')])
  )
  return (
    <section
      data-no-owner-step={group.state_key}
      className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <header className='flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-border'>
        <div className='min-w-0'>
          <h3 className='flex items-center gap-2 text-[14px] font-semibold text-slate-900 dark:text-slate-100'>
            {group.state_label}
            <span className='rounded-full bg-red-500/10 px-2 py-0.5 text-[12px] font-semibold tabular-nums text-red-700 dark:text-red-400'>
              {formatNumber(group.count)}
            </span>
          </h3>
          <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            {group.template_name} pipeline · {group.collection_label}
          </p>
          <p className='mt-2 flex flex-wrap items-center gap-1 text-[12px] text-slate-600 dark:text-slate-400'>
            Owner-only moves:
            {group.moves.map((m) => (
              <span
                key={m.id}
                className='rounded border border-slate-200 px-1.5 py-px text-[11.5px] dark:border-border'
              >
                {m.label}
                {m.allow_creator && <span className='text-muted-foreground'> · or creator</span>}
                {m.conditional && <span className='text-muted-foreground'> · some records</span>}
              </span>
            ))}
          </p>
        </div>
        <Button asChild size='sm' variant='outline' className='h-8 shrink-0 gap-1.5 text-[12px]'>
          <Link to={group.matrix_href}>
            Open owner matrix <ExternalLink className='h-3.5 w-3.5' />
          </Link>
        </Button>
      </header>

      <div className='px-4 py-3'>
        <p className='mb-2 text-[12px] font-medium text-slate-700 dark:text-slate-300'>
          Values no owner group covers
        </p>
        {group.clusters.length === 0 ? (
          <p className='text-[12px] text-muted-foreground'>
            These records were not grouped by value. Open the owner matrix to see which groups this
            step has.
          </p>
        ) : (
          <div className='overflow-x-auto'>
            <table className='w-full min-w-[600px] text-[12px]'>
              <thead>
                <tr className='text-left text-[11px] uppercase tracking-wide text-muted-foreground'>
                  <th className='pb-1 pr-3 font-medium'>Records</th>
                  <th className='pb-1 pr-3 font-medium'>Their values</th>
                  <th className='pb-1 font-medium'>Why no one owns them</th>
                </tr>
              </thead>
              <tbody>
                {clusters.map((c) => (
                  <tr
                    key={c.key}
                    className='border-t border-slate-100 align-top dark:border-border'
                  >
                    <td className='py-1.5 pr-3 font-semibold tabular-nums'>
                      {formatNumber(c.count)}
                    </td>
                    <td className='py-1.5 pr-3'>
                      <ValueChips dims={c.dims} uncovered={c.uncovered} />
                    </td>
                    <td className='py-1.5 text-slate-600 dark:text-slate-400'>
                      <span data-tip={c.reason || undefined}>{shortReason(c)}</span>
                      {c.suggestion?.group_label && (
                        <span className='mt-0.5 block text-[11.5px] text-muted-foreground'>
                          Closest group: {c.suggestion.group_label}
                          {c.suggestion.missing_labels.length > 0 &&
                            ` — misses ${c.suggestion.missing_labels.join(', ')}`}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {group.clusters.length > 5 && (
          <button
            type='button'
            className='mt-1 text-[12px] text-[#00a5cc] underline decoration-dotted underline-offset-2'
            onClick={() => setAllClusters((v) => !v)}
          >
            {allClusters ? 'Show fewer' : `Show all ${group.clusters.length} combinations`}
          </button>
        )}
        {(group.ungrouped > 0 || group.conditions_unchecked > 0) && (
          <p className='mt-2 text-[11.5px] text-muted-foreground'>
            {group.ungrouped > 0 && `${formatNumber(group.ungrouped)} not grouped by value. `}
            {group.conditions_unchecked > 0 &&
              `${formatNumber(group.conditions_unchecked)} counted without checking the move's conditions.`}
          </p>
        )}
      </div>

      <div className='border-t border-slate-100 dark:border-border'>
        <button
          type='button'
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className='flex w-full items-center gap-1.5 px-4 py-2 text-left text-[12px] font-medium text-slate-700 hover:bg-muted dark:text-slate-300'
        >
          {open ? (
            <ChevronDown className='h-3.5 w-3.5' />
          ) : (
            <ChevronRight className='h-3.5 w-3.5' />
          )}
          {open ? 'Hide records' : 'Show records'}
          <span className='font-normal text-muted-foreground'>
            (
            {group.sample.length < group.count
              ? `oldest ${group.sample.length} of ${formatNumber(group.count)}`
              : formatNumber(group.count)}
            )
          </span>
        </button>
        {open && (
          <div className='overflow-x-auto px-4 pb-3'>
            <table className='w-full min-w-[640px] text-[12px]'>
              <thead>
                <tr className='text-left text-[11px] uppercase tracking-wide text-muted-foreground'>
                  <th className='pb-1 pr-3 font-medium'>Record</th>
                  <th className='pb-1 pr-3 font-medium'>Created by</th>
                  <th className='pb-1 pr-3 font-medium'>In the queue of</th>
                  <th className='pb-1 pr-3 font-medium'>On this step since</th>
                  <th className='pb-1 font-medium'>Values</th>
                </tr>
              </thead>
              <tbody>
                {group.sample.map((r) => (
                  <tr key={r.item} className='border-t border-slate-100 dark:border-border'>
                    <td className='py-1.5 pr-3'>
                      <Link
                        to={`/collections/${group.collection}/${encodeURIComponent(r.item)}`}
                        className='font-medium text-[#00a5cc] underline decoration-dotted underline-offset-2'
                      >
                        {r.label}
                      </Link>
                    </td>
                    <td className='py-1.5 pr-3'>{r.creator?.name ?? '—'}</td>
                    <td className='py-1.5 pr-3 text-slate-600 dark:text-slate-400'>
                      {r.stand_in.length ? r.stand_in.join(', ') : 'Nobody'}
                    </td>
                    <td className='py-1.5 pr-3 tabular-nums'>
                      {r.since ? (
                        <span data-tip={formatRelative(r.since)}>{formatDate(r.since)}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className='py-1.5 text-slate-600 dark:text-slate-400'>
                      {(r.cluster && clusterLabel.get(r.cluster)) || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

export function NoOwnerStepsPage() {
  const qc = useQueryClient()
  const [rechecking, setRechecking] = useState(false)
  const { data, isLoading, error, refetch } = useQuery<NoOwnerReport>({
    queryKey: QUERY_KEY,
    queryFn: () =>
      api.get<{ data: NoOwnerReport }>('/coverage-gaps/no-owner').then((r) => r.data.data),
    staleTime: 60_000
  })

  // Re-check skips the server's two-minute answer — "did my new group take?"
  const recheck = async () => {
    setRechecking(true)
    try {
      const fresh = await api
        .get<{ data: NoOwnerReport }>('/coverage-gaps/no-owner?fresh=1')
        .then((r) => r.data.data)
      qc.setQueryData(QUERY_KEY, fresh)
    } catch {
      await refetch()
    } finally {
      setRechecking(false)
    }
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description='Open records on owner-only steps that nobody is assigned to own. Only an admin can move them until an owner group covers them.'
        actions={
          <>
            {data?.computed_at && (
              <span className='text-[11px] text-muted-foreground'>
                Checked {formatRelative(data.computed_at)}
              </span>
            )}
            <Button
              size='sm'
              variant='outline'
              className='h-8 text-[12px]'
              onClick={() => void recheck()}
              disabled={rechecking || isLoading}
            >
              {rechecking ? 'Checking…' : 'Re-check'}
            </Button>
          </>
        }
      />

      <div className='flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
        {error ? (
          <QueryErrorState
            error={error}
            what='steps with no owner'
            onRetry={() => void refetch()}
          />
        ) : isLoading || !data ? (
          <div className='grid grid-cols-1 gap-4 sm:grid-cols-3'>
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className='h-20 animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]'
              />
            ))}
          </div>
        ) : (
          <>
            <div className='mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3'>
              <Tile
                label='Records with no owner'
                value={formatNumber(data.total)}
                tone={
                  data.total > 0
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-emerald-600 dark:text-emerald-400'
                }
              />
              <Tile label='Steps affected' value={formatNumber(data.groups.length)} />
              <Tile label='Open records on owner-only steps' value={formatNumber(data.checked)} />
            </div>

            {data.groups.length === 0 ? (
              <div className='flex flex-col items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white px-6 py-12 text-center dark:border-border dark:bg-card'>
                <UserCheck className='h-6 w-6 text-emerald-600 dark:text-emerald-400' />
                <p className='text-[13px] font-medium'>
                  Every step with owner-only moves has an owner
                </p>
                <p className='max-w-[60ch] text-[12px] text-muted-foreground'>
                  Each open record on such a step resolves at least one assigned owner, so the
                  people who should move it can.
                </p>
              </div>
            ) : (
              <div className='space-y-4'>
                {data.groups.map((g, i) => (
                  <StepCard key={`${g.state_id}|${g.collection}`} group={g} defaultOpen={i === 0} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
