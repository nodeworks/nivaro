import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AppWindow,
  Boxes,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Rocket,
  Server,
  Trash2,
  XCircle
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Environment registry — the deployment stack as data. An environment is a
 * tier (Local/Staging/Production); its components are the deployable units
 * running there (API, frontends, services), each with a live probe and its
 * own Git project's pipelines, jobs and deployments. Pipeline lists poll
 * fast while anything is running, slow when idle.
 */

interface Component {
  id: number
  environment: number
  name: string
  kind: 'api' | 'frontend' | 'service'
  base_url: string | null
  probe_path: string | null
  api_token: string | null
  db_config: { host?: string; database?: string; user?: string; password?: string } | null
  git_provider: string | null
  git_url: string | null
  git_project: string | null
  git_token: string | null
  git_ref: string | null
  notes: string | null
  sort: number
}

interface Environment {
  id: number
  name: string
  color: string | null
  notes: string | null
  sort: number
  components: Component[]
}

const COLOR_DOT: Record<string, string> = {
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  sky: 'bg-sky-500',
  slate: 'bg-slate-400'
}

const KIND_ICON = { api: Server, frontend: AppWindow, service: Boxes } as const
const KIND_LABEL = { api: 'API', frontend: 'Frontend', service: 'Service' } as const

function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return ''
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  return `${m}m ${sec % 60}s`
}

export default function Environments() {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const { data: environments = [], isLoading } = useQuery<Environment[]>({
    queryKey: ['environments'],
    queryFn: () => api.get<{ data: Environment[] }>('/environments').then((r) => r.data.data)
  })

  const selected = environments.find((e) => e.id === selectedId) ?? null

  const createEnv = useMutation({
    mutationFn: (name: string) => api.post<{ data: { id: number } }>('/environments', { name }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['environments'] })
      setSelectedId(res.data.data.id)
    },
    onError: (err: Error) => toast.error(err.message)
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              Environments
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              The deployment stack — every tier&rsquo;s components, live versions, pipelines and
              deployments in one place.
            </p>
          </div>
          <Button
            size='sm'
            onClick={() => {
              const name = window.prompt('Environment name (e.g. Production)')
              if (name?.trim()) createEnv.mutate(name.trim())
            }}
          >
            <Plus className='h-3.5 w-3.5' /> New environment
          </Button>
        </div>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className='w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          {isLoading && <p className='px-4 py-6 text-[12px] text-slate-400'>Loading…</p>}
          {!isLoading && environments.length === 0 && (
            <p className='px-4 py-6 text-[12px] leading-relaxed text-slate-400'>
              Nothing registered yet — add your local, staging and production tiers, then the
              components running in each.
            </p>
          )}
          {environments.map((e) => (
            <button
              key={e.id}
              type='button'
              onClick={() => setSelectedId(e.id)}
              className={cn(
                'flex w-full items-center gap-2.5 border-b border-slate-100 px-4 py-3 text-left transition-colors dark:border-border/60',
                selectedId === e.id
                  ? 'bg-nvr-cyan/10'
                  : 'hover:bg-slate-50 dark:hover:bg-background/40'
              )}
            >
              <span
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  COLOR_DOT[e.color ?? ''] ?? 'bg-slate-300'
                )}
              />
              <span className='min-w-0 flex-1'>
                <span className='block truncate text-[13px] font-medium text-slate-800 dark:text-foreground'>
                  {e.name}
                </span>
                <span className='block text-[11px] text-slate-400'>
                  {e.components.length} component{e.components.length === 1 ? '' : 's'}
                </span>
              </span>
            </button>
          ))}
        </aside>

        <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
          {!selected ? (
            <div className='max-w-[560px]'>
              <Server className='h-8 w-8 text-slate-300' />
              <h2 className='mt-3 text-[15px] font-semibold text-slate-800 dark:text-foreground'>
                Pick an environment
              </h2>
              <p className='mt-1.5 text-[12.5px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
                Each tier holds its deployable components — the API instance, the frontends
                consuming it, supporting services. Every component gets a live probe and, with a
                Git project configured, its pipelines, job breakdowns and deployments. Tokens are
                stored server-side and never returned unmasked.
              </p>
            </div>
          ) : (
            <EnvironmentDetail key={selected.id} env={selected} onChanged={() => void qc.invalidateQueries({ queryKey: ['environments'] })} onDeleted={() => setSelectedId(null)} />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Environment detail ──────────────────────────────────────────────────────

function EnvironmentDetail({
  env,
  onChanged,
  onDeleted
}: {
  env: Environment
  onChanged: () => void
  onDeleted: () => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [adding, setAdding] = useState(false)

  const patchEnv = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/environments/${env.id}`, body),
    onSuccess: onChanged,
    onError: (err: Error) => toast.error(err.message)
  })
  const removeEnv = useMutation({
    mutationFn: () => api.delete(`/environments/${env.id}`),
    onSuccess: () => {
      toast.success('Environment deleted')
      onChanged()
      onDeleted()
    },
    onError: (err: Error) => toast.error(err.message)
  })

  return (
    <div className='max-w-[920px] space-y-4'>
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2.5'>
          {Object.keys(COLOR_DOT).map((c) => (
            <button
              key={c}
              type='button'
              title={c}
              onClick={() => patchEnv.mutate({ color: c })}
              className={cn(
                'h-4 w-4 rounded-full transition-transform',
                COLOR_DOT[c],
                env.color === c ? 'scale-110 ring-2 ring-slate-400 ring-offset-1' : 'opacity-50'
              )}
            />
          ))}
          <h2 className='ml-1 text-[16px] font-semibold text-slate-900 dark:text-foreground'>
            {env.name}
          </h2>
        </div>
        {confirmDelete ? (
          <span className='flex items-center gap-2 text-[12px]'>
            <span className='text-slate-500'>Delete {env.name} and its components?</span>
            <Button variant='destructive' size='sm' onClick={() => removeEnv.mutate()}>
              Delete
            </Button>
            <Button variant='ghost' size='sm' onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button
            variant='ghost'
            size='sm'
            className='text-slate-400 hover:text-red-600'
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className='h-3.5 w-3.5' /> Delete
          </Button>
        )}
      </div>

      {env.components.map((c) => (
        <ComponentCard key={c.id} component={c} onChanged={onChanged} />
      ))}

      {adding ? (
        <ComponentForm
          envId={env.id}
          onDone={() => {
            setAdding(false)
            onChanged()
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <Button variant='outline' size='sm' onClick={() => setAdding(true)}>
          <Plus className='h-3.5 w-3.5' /> Add component
        </Button>
      )}
    </div>
  )
}

// ─── Component card ──────────────────────────────────────────────────────────

interface CompStatus {
  reachable: boolean
  kind?: string
  reason?: string
  version?: string
  environment?: string
  health?: {
    db?: { status?: string; database?: string }
    redis?: { status?: string }
  }
  preflight?: { status?: string; checks?: Array<{ name: string; status: string; detail?: string }> }
}

function ComponentCard({ component, onChanged }: { component: Component; onChanged: () => void }) {
  const [showConfig, setShowConfig] = useState(false)
  const Icon = KIND_ICON[component.kind] ?? Boxes

  const { data: status, isFetching, refetch } = useQuery<CompStatus>({
    queryKey: ['environment-comp-status', component.id],
    queryFn: () =>
      api
        .get<{ data: CompStatus }>(`/environments/components/${component.id}/status`)
        .then((r) => r.data.data),
    enabled: !!component.base_url,
    staleTime: 30_000,
    retry: false
  })

  return (
    <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div className='flex items-center gap-2.5 border-b border-slate-100 px-4 py-2.5 dark:border-border'>
        <Icon className='h-4 w-4 text-slate-400' />
        <span className='text-[13.5px] font-semibold text-slate-800 dark:text-foreground'>
          {component.name}
        </span>
        <span className='rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-background dark:text-muted-foreground'>
          {KIND_LABEL[component.kind]}
        </span>
        {component.base_url && (
          <a
            href={component.base_url}
            target='_blank'
            rel='noreferrer'
            className='truncate font-mono text-[11px] text-slate-400 transition-colors hover:text-nvr-cyan'
          >
            {component.base_url}
          </a>
        )}
        <span className='ml-auto flex items-center gap-2'>
          {status &&
            (status.reachable ? (
              <span className='flex items-center gap-1.5 text-[11.5px] text-emerald-600 dark:text-emerald-400'>
                <span className='h-1.5 w-1.5 rounded-full bg-emerald-500' />
                {status.version ? `v${status.version.replace(/^v/, '')}` : 'up'}
              </span>
            ) : (
              <span
                className='flex items-center gap-1 text-[11.5px] text-red-600 dark:text-red-400'
                data-tip={status.reason}
              >
                <XCircle className='h-3 w-3' /> down
              </span>
            ))}
          <Button
            variant='ghost'
            size='sm'
            className='h-6 w-6 p-0 text-slate-400'
            disabled={isFetching}
            onClick={() => refetch()}
          >
            <RefreshCw className={cn('h-3 w-3', isFetching && 'animate-spin')} />
          </Button>
          <Button
            variant='ghost'
            size='sm'
            className='h-6 px-2 text-[11px] text-slate-500'
            onClick={() => setShowConfig((v) => !v)}
          >
            {showConfig ? 'Hide config' : 'Configure'}
          </Button>
        </span>
      </div>

      {component.kind === 'api' && status?.reachable && (
        <div className='gap-px grid grid-cols-2 border-b border-slate-100 bg-slate-200 dark:border-border dark:bg-border sm:grid-cols-4'>
          <Stat label='Version' value={status.version ?? '—'} mono />
          <Stat label='Database' value={status.health?.db?.database ?? '—'} mono />
          <Stat
            label='DB / Redis'
            value={`${status.health?.db?.status === 'connected' ? '✓' : '✕'} / ${status.health?.redis?.status === 'connected' ? '✓' : '✕'}`}
          />
          <Stat
            label='Preflight'
            value={status.preflight?.status ?? 'n/a'}
            tone={
              status.preflight?.status === 'ok'
                ? 'good'
                : status.preflight?.status === 'fail'
                  ? 'bad'
                  : status.preflight?.status === 'warn'
                    ? 'warn'
                    : undefined
            }
          />
        </div>
      )}
      {status?.preflight?.checks?.some((c) => c.status !== 'ok') && (
        <div className='space-y-1 border-b border-slate-100 px-4 py-2 dark:border-border'>
          {status.preflight.checks
            .filter((c) => c.status !== 'ok')
            .map((c) => (
              <p key={c.name} className='text-[11.5px] text-amber-600 dark:text-amber-400'>
                {c.name}: {c.detail ?? c.status}
              </p>
            ))}
        </div>
      )}

      {component.git_provider && component.git_project && <CiPanel component={component} />}

      {showConfig && (
        <div className='border-t border-slate-100 dark:border-border'>
          <ComponentForm
            envId={component.environment}
            component={component}
            onDone={() => {
              setShowConfig(false)
              onChanged()
            }}
            onCancel={() => setShowConfig(false)}
          />
        </div>
      )}
    </div>
  )
}

// ─── CI panel: pipelines + jobs + deployments ───────────────────────────────

interface Pipeline {
  id: number
  status: string
  ref?: string
  sha?: string
  title?: string
  author?: string
  duration?: number | null
  web_url?: string
  created_at?: string
  updated_at?: string
}

const ACTIVE_STATUSES = new Set([
  'created',
  'waiting_for_resource',
  'preparing',
  'pending',
  'running',
  'in_progress',
  'queued'
])

const PIPELINE_TONE: Record<string, string> = {
  success: 'bg-emerald-500',
  failed: 'bg-red-500',
  failure: 'bg-red-500',
  running: 'bg-sky-500 animate-pulse',
  in_progress: 'bg-sky-500 animate-pulse',
  pending: 'bg-amber-400',
  queued: 'bg-amber-400',
  created: 'bg-amber-400',
  canceled: 'bg-slate-300',
  cancelled: 'bg-slate-300',
  skipped: 'bg-slate-300'
}

function CiPanel({ component }: { component: Component }) {
  const [expanded, setExpanded] = useState<number | null>(null)

  const { data, isFetching } = useQuery<{
    configured: boolean
    active?: boolean
    error?: string
    pipelines: Pipeline[]
  }>({
    queryKey: ['environment-comp-pipelines', component.id],
    queryFn: () =>
      api
        .get<{ data: { configured: boolean; active?: boolean; error?: string; pipelines: Pipeline[] } }>(
          `/environments/components/${component.id}/pipelines`
        )
        .then((r) => r.data.data),
    refetchInterval: 5_000,
    retry: false
  })

  const { data: deployments } = useQuery<{
    error?: string
    deployments: Array<{
      id: number
      status: string
      environment?: string
      sha?: string
      title?: string
      job?: string
      web_url?: string
      created_at?: string
      user?: string
    }>
  }>({
    queryKey: ['environment-comp-deployments', component.id],
    queryFn: () =>
      api
        .get<{ data: { error?: string; deployments: never[] } }>(
          `/environments/components/${component.id}/deployments`
        )
        .then((r) => r.data.data),
    enabled: component.git_provider === 'gitlab',
    refetchInterval: 5_000,
    retry: false
  })

  const live = data?.active
  return (
    <div className='border-t border-slate-100 dark:border-border'>
      <div className='flex items-center gap-2 px-4 pb-1 pt-2.5'>
        <GitBranch className='h-3.5 w-3.5 text-slate-400' />
        <span className='text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
          Pipelines
        </span>
        <span className='font-mono text-[10.5px] text-slate-400'>{component.git_project}</span>
        {live && (
          <span className='flex items-center gap-1.5 rounded-full bg-sky-50 px-2 py-0.5 text-[10.5px] font-medium text-sky-700 dark:bg-sky-500/10 dark:text-sky-300'>
            <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500' />
            live — updating
          </span>
        )}
        {isFetching && !live && <Loader2 className='h-3 w-3 animate-spin text-slate-300' />}
      </div>

      {data?.error && (
        <p className='px-4 pb-2.5 text-[12px] text-amber-600 dark:text-amber-400'>{data.error}</p>
      )}
      {data && !data.error && data.pipelines.length === 0 && (
        <p className='px-4 pb-2.5 text-[12px] text-slate-400'>No pipelines found.</p>
      )}

      {data && data.pipelines.length > 0 && (
        <div className='px-2 pb-2'>
          {data.pipelines.map((p) => (
            <PipelineRow
              key={p.id}
              component={component}
              pipeline={p}
              expanded={expanded === p.id}
              onToggle={() => setExpanded((v) => (v === p.id ? null : p.id))}
            />
          ))}
        </div>
      )}

      {deployments && deployments.deployments.length > 0 && (
        <div className='border-t border-slate-100 px-4 py-2.5 dark:border-border'>
          <div className='mb-1.5 flex items-center gap-2'>
            <Rocket className='h-3.5 w-3.5 text-slate-400' />
            <span className='text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
              Deployments
            </span>
          </div>
          {deployments.deployments.slice(0, 5).map((d) => (
            <div
              key={d.id}
              className='flex items-center gap-2.5 py-1 text-[12px] text-slate-600 dark:text-muted-foreground'
            >
              <span
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  PIPELINE_TONE[d.status] ?? 'bg-slate-300'
                )}
                title={d.status}
              />
              {d.environment && (
                <span className='rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-600 dark:bg-background dark:text-muted-foreground'>
                  {d.environment}
                </span>
              )}
              <span className='font-mono text-[11px] text-slate-400'>{d.sha}</span>
              <span className='min-w-0 flex-1 truncate'>{d.title ?? d.job}</span>
              {d.user && <span className='shrink-0 text-[11px] text-slate-400'>{d.user}</span>}
              <span className='shrink-0 text-[11px] text-slate-400'>
                {d.created_at ? formatRelative(d.created_at) : ''}
              </span>
              {d.web_url && (
                <a
                  href={d.web_url}
                  target='_blank'
                  rel='noreferrer'
                  className='shrink-0 text-slate-400 hover:text-nvr-cyan'
                >
                  <ExternalLink className='h-3 w-3' />
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PipelineRow({
  component,
  pipeline: p,
  expanded,
  onToggle
}: {
  component: Component
  pipeline: Pipeline
  expanded: boolean
  onToggle: () => void
}) {
  const active = ACTIVE_STATUSES.has(p.status)
  return (
    <div className='rounded-md transition-colors hover:bg-slate-50 dark:hover:bg-background/40'>
      <button type='button' onClick={onToggle} className='flex w-full items-center gap-2.5 px-2 py-1.5 text-left'>
        {expanded ? (
          <ChevronDown className='h-3 w-3 shrink-0 text-slate-400' />
        ) : (
          <ChevronRight className='h-3 w-3 shrink-0 text-slate-400' />
        )}
        <span
          className={cn('h-2 w-2 shrink-0 rounded-full', PIPELINE_TONE[p.status] ?? 'bg-slate-300')}
          title={p.status}
        />
        <span className='w-[64px] shrink-0 text-[11.5px] capitalize text-slate-500 dark:text-muted-foreground'>
          {p.status.replace(/_/g, ' ')}
        </span>
        <span className='shrink-0 font-mono text-[11px] text-slate-400'>{p.sha}</span>
        <span className='min-w-0 flex-1 truncate text-[12.5px] text-slate-800 dark:text-foreground'>
          {p.title || p.ref}
        </span>
        {p.ref && (
          <span className='hidden shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-500 dark:bg-background dark:text-muted-foreground sm:inline'>
            {p.ref}
          </span>
        )}
        {p.author && (
          <span className='hidden shrink-0 text-[11px] text-slate-400 md:inline'>{p.author}</span>
        )}
        <span className='w-[52px] shrink-0 text-right font-mono text-[11px] tabular-nums text-slate-400'>
          {fmtDuration(p.duration)}
        </span>
        <span className='w-[64px] shrink-0 text-right text-[11px] text-slate-400'>
          {p.updated_at ? formatRelative(p.updated_at) : ''}
        </span>
        {p.web_url && (
          <a
            href={p.web_url}
            target='_blank'
            rel='noreferrer'
            onClick={(e) => e.stopPropagation()}
            className='shrink-0 text-slate-400 transition-colors hover:text-nvr-cyan'
          >
            <ExternalLink className='h-3 w-3' />
          </a>
        )}
      </button>
      {expanded && <JobList component={component} pipeline={p} active={active} />}
    </div>
  )
}

interface Job {
  id: number
  name: string
  stage: string | null
  status: string
  duration: number | null
  web_url?: string
  failure_reason?: string | null
}

function JobList({
  component,
  pipeline,
  active
}: {
  component: Component
  pipeline: Pipeline
  active: boolean
}) {
  const { data, isLoading } = useQuery<{ error?: string; jobs: Job[] }>({
    queryKey: ['environment-comp-jobs', component.id, pipeline.id],
    queryFn: () =>
      api
        .get<{ data: { error?: string; jobs: Job[] } }>(
          `/environments/components/${component.id}/pipelines/${pipeline.id}/jobs`
        )
        .then((r) => r.data.data),
    // A running pipeline's job list is the thing to watch live.
    refetchInterval: active ? 5_000 : false,
    retry: false
  })

  if (isLoading) {
    return <p className='px-9 pb-2 text-[11.5px] text-slate-400'>Loading jobs…</p>
  }
  if (data?.error) {
    return <p className='px-9 pb-2 text-[11.5px] text-amber-600 dark:text-amber-400'>{data.error}</p>
  }
  if (!data || data.jobs.length === 0) {
    return <p className='px-9 pb-2 text-[11.5px] text-slate-400'>No jobs.</p>
  }

  // Preserve pipeline order, group visually by stage.
  const stages: Array<{ stage: string | null; jobs: Job[] }> = []
  for (const j of data.jobs) {
    const last = stages[stages.length - 1]
    if (last && last.stage === j.stage) last.jobs.push(j)
    else stages.push({ stage: j.stage, jobs: [j] })
  }

  return (
    <div className='space-y-1 px-9 pb-2.5'>
      {stages.map((s, i) => (
        <div key={`${s.stage}-${i}`} className='flex flex-wrap items-center gap-x-3 gap-y-1'>
          {s.stage && (
            <span className='w-[72px] shrink-0 text-[10.5px] uppercase tracking-wide text-slate-400'>
              {s.stage}
            </span>
          )}
          {s.jobs.map((j) => (
            <a
              key={j.id}
              href={j.web_url ?? '#'}
              target='_blank'
              rel='noreferrer'
              data-tip={j.failure_reason ?? undefined}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                j.status === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300'
                  : j.status === 'failed' || j.status === 'failure'
                    ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
                    : ACTIVE_STATUSES.has(j.status)
                      ? 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300'
                      : 'border-slate-200 bg-slate-50 text-slate-500 dark:border-border dark:bg-background dark:text-muted-foreground'
              )}
            >
              <span
                className={cn('h-1.5 w-1.5 rounded-full', PIPELINE_TONE[j.status] ?? 'bg-slate-300')}
              />
              {j.name}
              {j.duration != null && (
                <span className='font-mono text-[10px] tabular-nums opacity-70'>
                  {fmtDuration(j.duration)}
                </span>
              )}
            </a>
          ))}
        </div>
      ))}
    </div>
  )
}

// ─── Stat cell ───────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  mono,
  tone
}: {
  label: string
  value: string
  mono?: boolean
  tone?: 'good' | 'bad' | 'warn'
}) {
  return (
    <div className='bg-white px-3 py-2 dark:bg-card'>
      <p className='text-[10.5px] uppercase tracking-wide text-slate-400'>{label}</p>
      <p
        className={cn(
          'mt-0.5 truncate text-[13px] font-medium',
          mono && 'font-mono text-[12.5px]',
          tone === 'good' && 'text-emerald-600 dark:text-emerald-400',
          tone === 'bad' && 'text-red-600 dark:text-red-400',
          tone === 'warn' && 'text-amber-600 dark:text-amber-400',
          !tone && 'text-slate-800 dark:text-foreground'
        )}
      >
        {value}
      </p>
    </div>
  )
}

// ─── Component form (create + edit) ─────────────────────────────────────────

interface CompDraft {
  name: string
  kind: string
  base_url: string
  probe_path: string
  api_token: string
  db_host: string
  db_database: string
  db_user: string
  db_password: string
  git_provider: string
  git_url: string
  git_project: string
  git_token: string
  git_ref: string
  notes: string
}

function toCompDraft(c: Component | null): CompDraft {
  return {
    name: c?.name ?? '',
    kind: c?.kind ?? 'api',
    base_url: c?.base_url ?? '',
    probe_path: c?.probe_path ?? '',
    api_token: c?.api_token ?? '',
    db_host: c?.db_config?.host ?? '',
    db_database: c?.db_config?.database ?? '',
    db_user: c?.db_config?.user ?? '',
    db_password: c?.db_config?.password ?? '',
    git_provider: c?.git_provider ?? '',
    git_url: c?.git_url ?? '',
    git_project: c?.git_project ?? '',
    git_token: c?.git_token ?? '',
    git_ref: c?.git_ref ?? '',
    notes: c?.notes ?? ''
  }
}

function ComponentForm({
  envId,
  component,
  onDone,
  onCancel
}: {
  envId: number
  component?: Component
  onDone: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<CompDraft>(() => toCompDraft(component ?? null))
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => setDraft(toCompDraft(component ?? null)), [component])

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: draft.name.trim(),
        kind: draft.kind,
        base_url: draft.base_url.trim() || null,
        probe_path: draft.probe_path.trim() || null,
        api_token: draft.api_token || null,
        db_config:
          draft.db_host || draft.db_database || draft.db_user || draft.db_password
            ? {
                ...(draft.db_host ? { host: draft.db_host } : {}),
                ...(draft.db_database ? { database: draft.db_database } : {}),
                ...(draft.db_user ? { user: draft.db_user } : {}),
                ...(draft.db_password ? { password: draft.db_password } : {})
              }
            : null,
        git_provider: draft.git_provider || null,
        git_url: draft.git_url.trim() || null,
        git_project: draft.git_project.trim() || null,
        git_token: draft.git_token || null,
        git_ref: draft.git_ref.trim() || null,
        notes: draft.notes.trim() || null
      }
      if (component) return api.patch(`/environments/components/${component.id}`, body)
      return api.post(`/environments/${envId}/components`, body)
    },
    onSuccess: () => {
      toast.success('Component saved')
      onDone()
    },
    onError: (err: Error) => toast.error(err.message)
  })

  const remove = useMutation({
    mutationFn: () => api.delete(`/environments/components/${component?.id}`),
    onSuccess: () => {
      toast.success('Component deleted')
      onDone()
    },
    onError: (err: Error) => toast.error(err.message)
  })

  const isApi = draft.kind === 'api'

  return (
    <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
        <Field label='Name'>
          <Input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder={isApi ? 'API' : 'EFP Frontend'}
            className='h-8 text-[12.5px]'
          />
        </Field>
        <Field label='Kind'>
          <div className='flex h-8 items-center gap-1.5'>
            {(['api', 'frontend', 'service'] as const).map((k) => (
              <button
                key={k}
                type='button'
                onClick={() => setDraft((d) => ({ ...d, kind: k }))}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-[12px] transition-colors',
                  draft.kind === k
                    ? 'border-nvr-cyan/50 bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                    : 'border-slate-200 text-slate-500 hover:text-slate-700 dark:border-border dark:text-muted-foreground'
                )}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </Field>
        <Field label='Base URL'>
          <Input
            value={draft.base_url}
            onChange={(e) => setDraft((d) => ({ ...d, base_url: e.target.value }))}
            placeholder='https://…'
            className='h-8 font-mono text-[12px]'
          />
        </Field>
        <Field
          label='Probe path'
          hint={isApi ? 'Blank = /api/version.' : 'Blank = /version.json (frontends) or / (services).'}
        >
          <Input
            value={draft.probe_path}
            onChange={(e) => setDraft((d) => ({ ...d, probe_path: e.target.value }))}
            className='h-8 font-mono text-[12px]'
          />
        </Field>
        {isApi && (
          <>
            <Field
              label='API token'
              hint='Admin token for detailed health + deploy preflight. Stored server-side, shown masked.'
            >
              <Input
                value={draft.api_token}
                onChange={(e) => setDraft((d) => ({ ...d, api_token: e.target.value }))}
                type='password'
                className='h-8 font-mono text-[12px]'
              />
            </Field>
            <div className='hidden sm:block' />
            <Field label='DB host (reference)'>
              <Input
                value={draft.db_host}
                onChange={(e) => setDraft((d) => ({ ...d, db_host: e.target.value }))}
                className='h-8 font-mono text-[12px]'
              />
            </Field>
            <Field label='DB name (reference)' hint='Reference only — the live database always comes from the health probe.'>
              <Input
                value={draft.db_database}
                onChange={(e) => setDraft((d) => ({ ...d, db_database: e.target.value }))}
                className='h-8 font-mono text-[12px]'
              />
            </Field>
            <Field label='DB user'>
              <Input
                value={draft.db_user}
                onChange={(e) => setDraft((d) => ({ ...d, db_user: e.target.value }))}
                className='h-8 font-mono text-[12px]'
              />
            </Field>
            <Field label='DB password'>
              <Input
                value={draft.db_password}
                onChange={(e) => setDraft((d) => ({ ...d, db_password: e.target.value }))}
                type='password'
                className='h-8 font-mono text-[12px]'
              />
            </Field>
          </>
        )}

        <Field label='CI provider'>
          <div className='flex h-8 items-center gap-1.5'>
            {['', 'gitlab', 'github'].map((p) => (
              <button
                key={p || 'none'}
                type='button'
                onClick={() => setDraft((d) => ({ ...d, git_provider: p }))}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-[12px] transition-colors',
                  draft.git_provider === p
                    ? 'border-nvr-cyan/50 bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                    : 'border-slate-200 text-slate-500 hover:text-slate-700 dark:border-border dark:text-muted-foreground'
                )}
              >
                {p === '' ? 'None' : p === 'gitlab' ? 'GitLab' : 'GitHub'}
              </button>
            ))}
          </div>
        </Field>
        {draft.git_provider === 'gitlab' && (
          <Field label='GitLab URL' hint='Self-hosted base; blank = gitlab.com.'>
            <Input
              value={draft.git_url}
              onChange={(e) => setDraft((d) => ({ ...d, git_url: e.target.value }))}
              placeholder='https://gitlab.example.com'
              className='h-8 font-mono text-[12px]'
            />
          </Field>
        )}
        {draft.git_provider && (
          <>
            <Field
              label='Project'
              hint={draft.git_provider === 'github' ? 'owner/repo' : 'group/project or numeric id'}
            >
              <Input
                value={draft.git_project}
                onChange={(e) => setDraft((d) => ({ ...d, git_project: e.target.value }))}
                className='h-8 font-mono text-[12px]'
              />
            </Field>
            <Field label='Branch' hint='Blank = all branches.'>
              <Input
                value={draft.git_ref}
                onChange={(e) => setDraft((d) => ({ ...d, git_ref: e.target.value }))}
                placeholder='main'
                className='h-8 font-mono text-[12px]'
              />
            </Field>
            <Field
              label='Access token'
              hint='Read-only API token for pipelines, jobs and deployments. Stored server-side, shown masked.'
            >
              <Input
                value={draft.git_token}
                onChange={(e) => setDraft((d) => ({ ...d, git_token: e.target.value }))}
                type='password'
                className='h-8 font-mono text-[12px]'
              />
            </Field>
          </>
        )}
        <div className='sm:col-span-2'>
          <Field label='Notes'>
            <Textarea
              value={draft.notes}
              onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
              rows={2}
              className='text-[12.5px]'
            />
          </Field>
        </div>
      </div>

      <div className='mt-4 flex items-center gap-3'>
        <Button size='sm' disabled={!draft.name.trim() || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? (
            <>
              <Loader2 className='h-3.5 w-3.5 animate-spin' /> Saving…
            </>
          ) : component ? (
            'Save changes'
          ) : (
            'Add component'
          )}
        </Button>
        <Button variant='ghost' size='sm' onClick={onCancel}>
          Cancel
        </Button>
        {component &&
          (confirmDelete ? (
            <span className='flex items-center gap-2 text-[12px]'>
              <span className='text-slate-500'>Delete this component?</span>
              <Button variant='destructive' size='sm' onClick={() => remove.mutate()}>
                Delete
              </Button>
              <Button variant='ghost' size='sm' onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button
              variant='ghost'
              size='sm'
              className='ml-auto text-slate-400 hover:text-red-600'
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className='h-3.5 w-3.5' /> Delete component
            </Button>
          ))}
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className='space-y-1'>
      <Label className='text-[11.5px] font-medium text-slate-700 dark:text-foreground'>
        {label}
      </Label>
      {children}
      {hint && <p className='text-[11px] leading-snug text-slate-400'>{hint}</p>}
    </div>
  )
}
