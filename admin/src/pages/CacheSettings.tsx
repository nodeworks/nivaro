import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCw, Save, Undo2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { HubToolbar } from '@/components/hub-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

// ─── Cache switches (Database → Caches) ──────────────────────────────────────
// Every cache switch with its effective value and where it comes from. Values saved
// here are stored for THIS instance (nivaro_settings_overrides `cache`); an env var
// that is set always wins. Replicas pick a change up within ~30 s.

type Value = boolean | number | string
type Source = 'env' | 'config' | 'default' | 'cloud'

interface CacheSettingRow {
  key: string
  group: string
  label: string
  hint: string
  env: string
  kind: 'bool' | 'int' | 'mode'
  default: Value
  min?: number
  max?: number
  options?: string[]
  value: Value
  source: Source
  env_value: string | null
  stored: Value | null
}

interface ChangeWarmStats {
  window_hours: number
  changes: number
  flushes: number
  marked: number
  recomputes: number
  warmed: number
  cached: number
  joined: number
  skipped: number
  failed: number
  deferred: number
  last_at: string | null
  by_query: Array<{ slug: string; warmed: number }>
  enabled: boolean
  cloud: boolean
}

interface CacheConfigResponse {
  data: CacheSettingRow[]
  instance: string
  cloud: boolean
  stats: Record<string, Record<string, number | boolean>>
  /** Warms triggered by data changes (services/cache-warm-on-change.ts); absent on older servers. */
  change_warm?: ChangeWarmStats | null
}

const QUERY_KEY = ['admin', 'cache-config']

const SOURCE_STYLE: Record<Source, string> = {
  env: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  config: 'bg-nvr-cyan/15 text-sky-700 dark:text-sky-300',
  default: 'bg-muted text-muted-foreground',
  cloud: 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
}

const SOURCE_LABEL: Record<Source, string> = {
  env: 'env',
  config: 'config',
  default: 'default',
  cloud: 'cloud'
}

function show(v: Value): string {
  if (typeof v === 'boolean') return v ? 'On' : 'Off'
  if (typeof v === 'number') return v.toLocaleString()
  return v
}

export default function CacheSettings() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.get<CacheConfigResponse>('/cache-config').then((r) => r.data)
  })
  // Edits not yet saved: key → value (null = clear the stored value).
  const [draft, setDraft] = useState<Record<string, Value | null>>({})

  const save = useMutation({
    mutationFn: (settings: Record<string, Value | null>) =>
      api.patch<CacheConfigResponse>('/cache-config', { settings }).then((r) => r.data),
    onSuccess: () => {
      setDraft({})
      void qc.invalidateQueries({ queryKey: QUERY_KEY })
      toast.success('Cache settings saved. Other replicas follow within 30 seconds.')
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Could not save cache settings')
    }
  })

  const groups = useMemo(() => {
    const out = new Map<string, CacheSettingRow[]>()
    for (const row of q.data?.data ?? []) {
      const list = out.get(row.group) ?? []
      list.push(row)
      out.set(row.group, list)
    }
    return [...out.entries()]
  }, [q.data])

  const dirty = Object.keys(draft).length > 0
  const cloud = !!q.data?.cloud

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description={`Cache switches for this instance${q.data ? ` (${q.data.instance})` : ''}. An env var that is set always wins; saved values apply to every replica of this instance within 30 seconds.`}
        actions={
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              onClick={() => void q.refetch()}
              disabled={q.isFetching}
            >
              <RotateCw className={cn('mr-1.5 h-3.5 w-3.5', q.isFetching && 'animate-spin')} />
              Refresh
            </Button>
            <Button
              variant='outline'
              size='sm'
              onClick={() => setDraft({})}
              disabled={!dirty || save.isPending}
            >
              <Undo2 className='mr-1.5 h-3.5 w-3.5' />
              Discard
            </Button>
            <Button
              size='sm'
              className='bg-nvr-cyan text-white'
              onClick={() => save.mutate(draft)}
              disabled={!dirty || save.isPending || cloud}
            >
              <Save className='mr-1.5 h-3.5 w-3.5' />
              Save
            </Button>
          </div>
        }
      />
      <div className='flex-1 overflow-y-auto bg-slate-50 p-4 dark:bg-background'>
        {cloud && (
          <p className='mb-3 rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-[12px] text-violet-800 dark:text-violet-200'>
            Cloud mode: cache switches are platform-managed (env or defaults only), and the
            permission cache is always off.
          </p>
        )}
        {q.isLoading && <p className='text-[12px] text-muted-foreground'>Loading…</p>}
        {q.isError && (
          <p className='text-[12px] text-destructive'>Could not load cache settings.</p>
        )}
        <div className='space-y-4'>
          {q.data?.change_warm && <ChangeWarmCard stats={q.data.change_warm} />}
          {groups.map(([group, rows]) => (
            <section
              key={group}
              className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
            >
              <h2 className='border-b border-slate-200 px-4 py-2 text-[13px] font-semibold dark:border-border'>
                {group}
              </h2>
              <table className='w-full text-[12px]'>
                <thead>
                  <tr className='text-left text-[11px] uppercase tracking-wide text-muted-foreground'>
                    <th className='px-4 py-1.5 font-medium'>Setting</th>
                    <th className='px-4 py-1.5 font-medium'>Effective</th>
                    <th className='px-4 py-1.5 font-medium'>Stored for this instance</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <SettingRow
                      key={row.key}
                      row={row}
                      draft={draft}
                      disabled={cloud || save.isPending}
                      onChange={(v) =>
                        setDraft((d) => {
                          const next = { ...d }
                          // Back to what is stored: nothing to save for this key.
                          if (v === (row.stored ?? undefined) || (v === null && row.stored == null))
                            delete next[row.key]
                          else next[row.key] = v
                          return next
                        })
                      }
                    />
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

function SettingRow({
  row,
  draft,
  disabled,
  onChange
}: {
  row: CacheSettingRow
  draft: Record<string, Value | null>
  disabled: boolean
  onChange: (v: Value | null) => void
}) {
  const pending = row.key in draft
  const current: Value | null = pending ? draft[row.key] : row.stored
  const shown: Value = current ?? row.default
  return (
    <tr className='border-t border-slate-100 align-top dark:border-border'>
      <td className='px-4 py-2'>
        <div className='font-medium'>{row.label}</div>
        <div className='text-[11px] text-muted-foreground'>{row.hint}</div>
        <div className='mt-0.5 font-mono text-[10.5px] text-muted-foreground'>{row.env}</div>
      </td>
      <td className='whitespace-nowrap px-4 py-2'>
        <div className='flex items-center gap-1.5'>
          <span className='font-medium tabular-nums'>{show(row.value)}</span>
          <Badge
            variant='secondary'
            className={cn('px-1.5 py-0 text-[10px]', SOURCE_STYLE[row.source])}
          >
            {SOURCE_LABEL[row.source]}
          </Badge>
        </div>
        {row.source === 'env' && (
          <div className='mt-0.5 text-[11px] text-amber-700 dark:text-amber-300'>
            {row.env}={row.env_value} pins this; a stored value applies once it is unset.
          </div>
        )}
        <div className='mt-0.5 text-[11px] text-muted-foreground'>default {show(row.default)}</div>
      </td>
      <td className='px-4 py-2'>
        <div className='flex items-center gap-2'>
          {row.kind === 'bool' && (
            <Switch
              checked={shown === true}
              disabled={disabled}
              onCheckedChange={(v) => onChange(v)}
              aria-label={`${row.group} ${row.label}`}
            />
          )}
          {row.kind === 'int' && (
            <Input
              type='number'
              className='h-7 w-32 text-[12px]'
              min={row.min}
              max={row.max}
              disabled={disabled}
              value={current == null ? '' : String(current)}
              placeholder={String(row.default)}
              onChange={(e) => {
                const raw = e.target.value
                if (raw === '') onChange(null)
                else if (Number.isFinite(Number(raw))) onChange(Number(raw))
              }}
            />
          )}
          {row.kind === 'mode' && (
            <SimpleSelect
              value={String(shown)}
              onChange={(v) => onChange(v)}
              options={(row.options ?? []).map((o) => ({ value: o, label: o }))}
              ariaLabel={`${row.group} ${row.label}`}
              className='h-7 w-28 text-[12px]'
              disabled={disabled}
            />
          )}
          {current != null && (
            <Button
              variant='ghost'
              size='sm'
              className='h-7 px-2 text-[11px]'
              disabled={disabled}
              onClick={() => onChange(null)}
            >
              Clear
            </Button>
          )}
          {current == null && <span className='text-[11px] text-muted-foreground'>not stored</span>}
          {pending && <span className='text-[11px] text-nvr-cyan'>unsaved</span>}
          {row.kind === 'int' && row.min != null && (
            <span className='text-[10.5px] text-muted-foreground'>
              {row.min.toLocaleString()}–{row.max?.toLocaleString()}
            </span>
          )}
        </div>
      </td>
    </tr>
  )
}

// Warms triggered by data changes, last 24 hours, across every replica.
function ChangeWarmCard({ stats }: { stats: ChangeWarmStats }) {
  const cells: Array<{ label: string; value: number; hint: string }> = [
    {
      label: 'Changes heard',
      value: stats.changes,
      hint: `Record writes, moves, imports and announced procedure writes, in ${stats.flushes.toLocaleString()} burst(s).`
    },
    {
      label: 'Queries marked stale',
      value: stats.marked,
      hint: 'Cached queries that read a changed collection. Older cached answers say what changed.'
    },
    {
      label: 'Warms',
      value: stats.recomputes,
      hint: `A widget's (or a query's) most-viewed entries recomputed together. ${stats.deferred.toLocaleString()} waited for the 2-minute gap first.`
    },
    {
      label: 'Entries recomputed',
      value: stats.warmed,
      hint: `${stats.joined.toLocaleString()} shared with a viewer already running the same query.`
    },
    {
      label: 'Left alone',
      value: stats.skipped,
      hint: 'Already newer than the change, not cached, or out of time.'
    },
    {
      label: 'Failed',
      value: stats.failed,
      hint: 'The query did not finish; the old entry stays until its TTL.'
    }
  ]
  return (
    <section
      className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-change-warm
    >
      <div className='flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-slate-200 px-4 py-2 dark:border-border'>
        <h2 className='text-[13px] font-semibold'>
          Warms after data changes
          <span className='ml-1.5 font-normal text-muted-foreground'>
            last {stats.window_hours} hours, every replica
          </span>
        </h2>
        <span className='text-[11px] text-muted-foreground'>
          {stats.cloud
            ? 'Not used in cloud mode.'
            : !stats.enabled
              ? 'Off on this instance — see Warm after data changes below.'
              : stats.last_at
                ? `Last warm ${formatRelative(stats.last_at)}`
                : 'On — nothing warmed yet.'}
        </span>
      </div>
      <div className='grid grid-cols-2 gap-px bg-slate-200 sm:grid-cols-3 lg:grid-cols-6 dark:bg-border'>
        {cells.map((c) => (
          <div key={c.label} className='bg-white px-4 py-2.5 dark:bg-card' data-tip={c.hint}>
            <div className='text-[11px] text-muted-foreground'>{c.label}</div>
            <div
              className={cn(
                'text-[18px] font-semibold tabular-nums',
                c.label === 'Failed' && c.value > 0 && 'text-amber-700 dark:text-amber-300'
              )}
            >
              {c.value.toLocaleString()}
            </div>
          </div>
        ))}
      </div>
      {stats.by_query.length > 0 && (
        <div className='border-t border-slate-200 px-4 py-2 dark:border-border'>
          <div className='mb-1 text-[11px] uppercase tracking-wide text-muted-foreground'>
            Most recomputed
          </div>
          <ul className='flex flex-wrap gap-x-4 gap-y-1 text-[12px]'>
            {stats.by_query.map((r) => (
              <li key={r.slug} className='flex min-w-0 items-baseline gap-1.5'>
                <span className='truncate font-mono text-[11.5px]'>{r.slug}</span>
                <span className='tabular-nums text-muted-foreground'>
                  {r.warmed.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
