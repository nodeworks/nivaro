import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  ExternalLink,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
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
 * Environment registry — the deployment stack as data. Left: environments.
 * Right: connection config + a live status probe (version, database,
 * migrations, preflight) + recent CI pipelines from GitLab/GitHub.
 */

interface Environment {
  id: number
  name: string
  base_url: string | null
  api_token: string | null
  db_config: { host?: string; database?: string; user?: string; password?: string } | null
  git_provider: string | null
  git_url: string | null
  git_project: string | null
  git_token: string | null
  git_ref: string | null
  notes: string | null
  color: string | null
  sort: number
}

const COLOR_DOT: Record<string, string> = {
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  sky: 'bg-sky-500',
  slate: 'bg-slate-400'
}

const NEW = -1

export default function Environments() {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const { data: environments = [], isLoading } = useQuery<Environment[]>({
    queryKey: ['environments'],
    queryFn: () => api.get<{ data: Environment[] }>('/environments').then((r) => r.data.data)
  })

  const selected =
    selectedId === NEW || selectedId == null
      ? null
      : (environments.find((e) => e.id === selectedId) ?? null)

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              Environments
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Your deployment stack — each instance&rsquo;s version, database, migration state and
              CI pipelines in one place.
            </p>
          </div>
          <Button size='sm' onClick={() => setSelectedId(NEW)}>
            <Plus className='h-3.5 w-3.5' /> New environment
          </Button>
        </div>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className='w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          {isLoading && (
            <p className='px-4 py-6 text-[12px] text-slate-400'>Loading…</p>
          )}
          {!isLoading && environments.length === 0 && (
            <p className='px-4 py-6 text-[12px] leading-relaxed text-slate-400'>
              Nothing registered yet — add your local, staging and production instances.
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
              <span className='min-w-0'>
                <span className='block truncate text-[13px] font-medium text-slate-800 dark:text-foreground'>
                  {e.name}
                </span>
                <span className='block truncate text-[11px] text-slate-400'>
                  {e.base_url ?? 'No URL'}
                </span>
              </span>
            </button>
          ))}
        </aside>

        <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
          {selectedId == null ? (
            <div className='max-w-[560px]'>
              <Server className='h-8 w-8 text-slate-300' />
              <h2 className='mt-3 text-[15px] font-semibold text-slate-800 dark:text-foreground'>
                Pick an environment
              </h2>
              <p className='mt-1.5 text-[12.5px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
                Each entry stores where the instance lives, an API token for its admin probes, its
                database reference and a Git project for CI history. Tokens are stored server-side
                and never returned unmasked.
              </p>
            </div>
          ) : (
            <EnvironmentDetail
              key={selectedId}
              env={selectedId === NEW ? null : selected}
              onSaved={(id) => {
                void qc.invalidateQueries({ queryKey: ['environments'] })
                setSelectedId(id)
              }}
              onDeleted={() => {
                void qc.invalidateQueries({ queryKey: ['environments'] })
                setSelectedId(null)
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Detail ──────────────────────────────────────────────────────────────────

interface Draft {
  name: string
  base_url: string
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
  color: string
  sort: string
}

function toDraft(e: Environment | null): Draft {
  return {
    name: e?.name ?? '',
    base_url: e?.base_url ?? '',
    api_token: e?.api_token ?? '',
    db_host: e?.db_config?.host ?? '',
    db_database: e?.db_config?.database ?? '',
    db_user: e?.db_config?.user ?? '',
    db_password: e?.db_config?.password ?? '',
    git_provider: e?.git_provider ?? '',
    git_url: e?.git_url ?? '',
    git_project: e?.git_project ?? '',
    git_token: e?.git_token ?? '',
    git_ref: e?.git_ref ?? '',
    notes: e?.notes ?? '',
    color: e?.color ?? 'slate',
    sort: String(e?.sort ?? 0)
  }
}

function EnvironmentDetail({
  env,
  onSaved,
  onDeleted
}: {
  env: Environment | null
  onSaved: (id: number) => void
  onDeleted: () => void
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(env))
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => setDraft(toDraft(env)), [env])

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: draft.name.trim(),
        base_url: draft.base_url.trim() || null,
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
        notes: draft.notes.trim() || null,
        color: draft.color || null,
        sort: Number(draft.sort) || 0
      }
      if (env) return api.patch<{ data: Environment }>(`/environments/${env.id}`, body)
      return api.post<{ data: Environment }>('/environments', body)
    },
    onSuccess: (res) => {
      toast.success('Environment saved')
      onSaved(res.data.data.id)
    },
    onError: (err: Error) => toast.error(err.message)
  })

  const remove = useMutation({
    mutationFn: () => api.delete(`/environments/${env?.id}`),
    onSuccess: () => {
      toast.success('Environment deleted')
      onDeleted()
    },
    onError: (err: Error) => toast.error(err.message)
  })

  return (
    <div className='max-w-[880px] space-y-4'>
      {env && <StatusCard envId={env.id} />}
      {env && env.git_provider && <PipelinesCard envId={env.id} />}

      <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <h3 className='mb-3 text-[13px] font-semibold text-slate-800 dark:text-foreground'>
          {env ? 'Connection' : 'New environment'}
        </h3>
        <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
          <Field label='Name'>
            <Input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder='Staging'
              className='h-8 text-[12.5px]'
            />
          </Field>
          <Field label='Color'>
            <div className='flex h-8 items-center gap-2'>
              {Object.keys(COLOR_DOT).map((c) => (
                <button
                  key={c}
                  type='button'
                  onClick={() => setDraft((d) => ({ ...d, color: c }))}
                  className={cn(
                    'h-5 w-5 rounded-full transition-transform',
                    COLOR_DOT[c],
                    draft.color === c ? 'scale-110 ring-2 ring-slate-400 ring-offset-1' : 'opacity-60'
                  )}
                />
              ))}
            </div>
          </Field>
          <Field label='Base URL' hint='The instance root — probes call <url>/api/version etc.'>
            <Input
              value={draft.base_url}
              onChange={(e) => setDraft((d) => ({ ...d, base_url: e.target.value }))}
              placeholder='https://efp-staging.example.com'
              className='h-8 font-mono text-[12px]'
            />
          </Field>
          <Field
            label='API token'
            hint='Admin token for detailed health + deploy preflight. Stored server-side, shown masked.'
          >
            <Input
              value={draft.api_token}
              onChange={(e) => setDraft((d) => ({ ...d, api_token: e.target.value }))}
              type='password'
              placeholder='nvk_… or static token'
              className='h-8 font-mono text-[12px]'
            />
          </Field>
        </div>

        <h3 className='mb-3 mt-5 text-[13px] font-semibold text-slate-800 dark:text-foreground'>
          Database reference
        </h3>
        <p className='-mt-2 mb-3 text-[11.5px] text-slate-400'>
          Reference only — shown here so the stack is documented in one place; the live database
          name always comes from the instance&rsquo;s own health probe.
        </p>
        <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
          <Field label='Host'>
            <Input
              value={draft.db_host}
              onChange={(e) => setDraft((d) => ({ ...d, db_host: e.target.value }))}
              className='h-8 font-mono text-[12px]'
            />
          </Field>
          <Field label='Database'>
            <Input
              value={draft.db_database}
              onChange={(e) => setDraft((d) => ({ ...d, db_database: e.target.value }))}
              className='h-8 font-mono text-[12px]'
            />
          </Field>
          <Field label='User'>
            <Input
              value={draft.db_user}
              onChange={(e) => setDraft((d) => ({ ...d, db_user: e.target.value }))}
              className='h-8 font-mono text-[12px]'
            />
          </Field>
          <Field label='Password'>
            <Input
              value={draft.db_password}
              onChange={(e) => setDraft((d) => ({ ...d, db_password: e.target.value }))}
              type='password'
              className='h-8 font-mono text-[12px]'
            />
          </Field>
        </div>

        <h3 className='mb-3 mt-5 text-[13px] font-semibold text-slate-800 dark:text-foreground'>
          CI / deployments
        </h3>
        <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
          <Field label='Provider'>
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
                  placeholder={draft.git_provider === 'github' ? 'nodeworks/nivaro' : 'nodeworks/efp-nivaro'}
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
                hint='Read-only API token for pipeline history. Stored server-side, shown masked.'
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
          <Button
            size='sm'
            disabled={!draft.name.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? (
              <>
                <Loader2 className='h-3.5 w-3.5 animate-spin' /> Saving…
              </>
            ) : env ? (
              'Save changes'
            ) : (
              'Create environment'
            )}
          </Button>
          {env &&
            (confirmDelete ? (
              <span className='flex items-center gap-2 text-[12px]'>
                <span className='text-slate-500'>Delete this environment?</span>
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
                className='text-slate-400 hover:text-red-600'
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className='h-3.5 w-3.5' /> Delete
              </Button>
            ))}
        </div>
      </div>
    </div>
  )
}

// ─── Live status ─────────────────────────────────────────────────────────────

interface EnvStatus {
  reachable: boolean
  reason?: string
  version?: string
  environment?: string
  health?: {
    status?: string
    db?: { status?: string; database?: string; host?: string }
    redis?: { status?: string }
  }
  preflight?: { status?: string; checks?: Array<{ name: string; status: string; detail?: string }> }
}

function StatusCard({ envId }: { envId: number }) {
  const { data, isFetching, refetch } = useQuery<EnvStatus>({
    queryKey: ['environment-status', envId],
    queryFn: () =>
      api.get<{ data: EnvStatus }>(`/environments/${envId}/status`).then((r) => r.data.data),
    staleTime: 30_000,
    retry: false
  })

  return (
    <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='mb-3 flex items-center justify-between'>
        <h3 className='flex items-center gap-2 text-[13px] font-semibold text-slate-800 dark:text-foreground'>
          <Activity className='h-3.5 w-3.5 text-slate-400' /> Live status
        </h3>
        <Button
          variant='ghost'
          size='sm'
          className='h-6 gap-1 px-2 text-[11px] text-slate-500'
          disabled={isFetching}
          onClick={() => refetch()}
        >
          <RefreshCw className={cn('h-3 w-3', isFetching && 'animate-spin')} /> Refresh
        </Button>
      </div>
      {!data && isFetching && <p className='text-[12px] text-slate-400'>Probing…</p>}
      {data && !data.reachable && (
        <p className='flex items-center gap-1.5 text-[12.5px] text-red-600 dark:text-red-400'>
          <XCircle className='h-3.5 w-3.5' /> Unreachable{data.reason ? ` — ${data.reason}` : ''}
        </p>
      )}
      {data?.reachable && (
        <div className='gap-px grid grid-cols-2 overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border sm:grid-cols-4'>
          <Stat label='Version' value={data.version ?? '—'} mono />
          <Stat label='Database' value={data.health?.db?.database ?? '—'} mono />
          <Stat
            label='DB / Redis'
            value={`${data.health?.db?.status === 'connected' ? '✓' : '✕'} / ${data.health?.redis?.status === 'connected' ? '✓' : '✕'}`}
          />
          <Stat
            label='Preflight'
            value={data.preflight?.status ?? 'n/a'}
            tone={
              data.preflight?.status === 'ok'
                ? 'good'
                : data.preflight?.status === 'fail'
                  ? 'bad'
                  : data.preflight?.status === 'warn'
                    ? 'warn'
                    : undefined
            }
          />
        </div>
      )}
      {data?.preflight?.checks?.some((c) => c.status !== 'ok') && (
        <div className='mt-2.5 space-y-1'>
          {data.preflight.checks
            .filter((c) => c.status !== 'ok')
            .map((c) => (
              <p key={c.name} className='text-[11.5px] text-amber-600 dark:text-amber-400'>
                {c.name}: {c.detail ?? c.status}
              </p>
            ))}
        </div>
      )}
    </div>
  )
}

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
    <div className='bg-white px-3 py-2.5 dark:bg-card'>
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

// ─── Pipelines ───────────────────────────────────────────────────────────────

interface Pipeline {
  id: number
  status: string
  ref?: string
  sha?: string
  title?: string
  web_url?: string
  created_at?: string
  updated_at?: string
}

const PIPELINE_TONE: Record<string, string> = {
  success: 'bg-emerald-500',
  failed: 'bg-red-500',
  failure: 'bg-red-500',
  running: 'bg-sky-500 animate-pulse',
  in_progress: 'bg-sky-500 animate-pulse',
  pending: 'bg-amber-400',
  queued: 'bg-amber-400',
  canceled: 'bg-slate-300',
  cancelled: 'bg-slate-300',
  skipped: 'bg-slate-300'
}

function PipelinesCard({ envId }: { envId: number }) {
  const { data, isFetching } = useQuery<{
    configured: boolean
    error?: string
    pipelines: Pipeline[]
  }>({
    queryKey: ['environment-pipelines', envId],
    queryFn: () =>
      api
        .get<{ data: { configured: boolean; error?: string; pipelines: Pipeline[] } }>(
          `/environments/${envId}/pipelines`
        )
        .then((r) => r.data.data),
    staleTime: 60_000,
    retry: false
  })

  return (
    <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <h3 className='mb-3 flex items-center gap-2 text-[13px] font-semibold text-slate-800 dark:text-foreground'>
        <GitBranch className='h-3.5 w-3.5 text-slate-400' /> Recent pipelines
      </h3>
      {isFetching && !data && <p className='text-[12px] text-slate-400'>Loading…</p>}
      {data?.error && (
        <p className='text-[12px] text-amber-600 dark:text-amber-400'>{data.error}</p>
      )}
      {data && !data.error && data.pipelines.length === 0 && (
        <p className='text-[12px] text-slate-400'>No pipelines found.</p>
      )}
      {data && data.pipelines.length > 0 && (
        <div className='space-y-0'>
          {data.pipelines.map((p) => (
            <div
              key={p.id}
              className='flex items-center gap-2.5 border-b border-slate-50 py-1.5 text-[12px] last:border-0 dark:border-border/50'
            >
              <span
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  PIPELINE_TONE[p.status] ?? 'bg-slate-300'
                )}
                title={p.status}
              />
              <span className='w-[70px] shrink-0 capitalize text-slate-600 dark:text-muted-foreground'>
                {p.status}
              </span>
              <span className='shrink-0 font-mono text-[11px] text-slate-400'>{p.sha}</span>
              <span className='min-w-0 flex-1 truncate text-slate-700 dark:text-foreground'>
                {p.title ?? p.ref}
              </span>
              <span className='shrink-0 text-[11px] text-slate-400'>
                {p.updated_at ? formatRelative(p.updated_at) : ''}
              </span>
              {p.web_url && (
                <a
                  href={p.web_url}
                  target='_blank'
                  rel='noreferrer'
                  className='shrink-0 text-slate-400 transition-colors hover:text-nvr-cyan'
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
