import { describeError, ErrorNotice, toastError, useUnsavedWork } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitBranch, Loader2, Lock, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  type CreatedConnection,
  type FeatureState,
  featureLockReason,
  fetchConnections,
  fetchFeature,
  fetchLabels,
  type Role,
  type SyncOptions,
  type TrackerConnection,
  trackerKeys
} from './issue-trackers/api'
import { ConnectionCard } from './issue-trackers/ConnectionCard'
import { HealthStrip } from './issue-trackers/HealthStrip'
import {
  LabelsCard,
  PriorityLanesCard,
  SimilarCard,
  SyncOptionsCard
} from './issue-trackers/SyncCards'
import { WebhookSetup } from './issue-trackers/WebhookSetup'

const OFF_LINE =
  'GitLab sync is off — nothing is sent or received. Turning it on resumes where it left off.'

function FeatureSwitch({ state }: { state: FeatureState | undefined }) {
  const qc = useQueryClient()
  const lock = featureLockReason(state)
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api.put<{ data: FeatureState }>('/trackers/feature', { enabled }).then((r) => r.data.data),
    onSuccess: (next) => {
      qc.setQueryData(trackerKeys.feature(), next)
      void qc.invalidateQueries({ queryKey: trackerKeys.all })
      toast.success(next.enabled ? 'GitLab sync is on' : 'GitLab sync is off')
    },
    onError: (err) => toastError(err, 'Could not change GitLab sync')
  })
  return (
    <section className='flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
      <div className='flex items-center gap-3'>
        <Switch
          id='tracker-feature'
          checked={!!state?.enabled}
          disabled={!state || !!lock || toggle.isPending}
          onCheckedChange={(v) => toggle.mutate(v)}
        />
        <Label
          htmlFor='tracker-feature'
          className='cursor-pointer text-[13px] font-semibold text-slate-900 dark:text-foreground'
        >
          GitLab sync
        </Label>
        {toggle.isPending && <Loader2 className='h-3.5 w-3.5 animate-spin text-slate-400' />}
      </div>
      <p className='min-w-0 flex-1 basis-[280px] text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        {lock ? (
          <span className='inline-flex items-start gap-1.5'>
            <Lock className='mt-px h-3 w-3 shrink-0' aria-hidden />
            {lock}
          </span>
        ) : (
          'Open GitLab issues from the issue log, support tickets and records, and keep both sides in step.'
        )}
      </p>
    </section>
  )
}

function SyncEditor({ connection, roles }: { connection: TrackerConnection; roles: Role[] }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<SyncOptions>(connection.sync)
  const saved = JSON.stringify(connection.sync)
  // A save (or another admin's) brings a new saved copy: start from it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the saved JSON on purpose
  useEffect(() => setDraft(connection.sync), [saved])
  const dirty = JSON.stringify(draft) !== saved
  useUnsavedWork(dirty, 'GitLab sync settings')
  const patch = (p: Partial<SyncOptions>) => setDraft((d) => ({ ...d, ...p }))

  const canList = connection.token_set && connection.default_project_id != null
  const labels = useQuery({
    queryKey: trackerKeys.labels(connection.id, connection.default_project_id),
    queryFn: () => fetchLabels(connection.id),
    enabled: canList,
    staleTime: 5 * 60_000
  })
  const unavailable = !canList
    ? 'Pick a default project to list its labels. You can still type one.'
    : labels.isError
      ? `${describeError(labels.error, 'Could not list the labels').title} You can still type one.`
      : null

  const save = useMutation({
    mutationFn: () =>
      api
        .patch<{ data: TrackerConnection }>(`/trackers/${connection.id}`, { sync: draft })
        .then((r) => r.data.data),
    onSuccess: (next) => {
      qc.setQueryData<TrackerConnection[]>(trackerKeys.connections(), (list) =>
        list?.map((c) => (c.id === next.id ? next : c))
      )
      setDraft(next.sync)
      toast.success('Sync settings saved')
    },
    onError: (err) => toastError(err, 'Could not save the sync settings')
  })

  return (
    <div className='space-y-4'>
      <div className='grid gap-4 xl:grid-cols-2'>
        <SyncOptionsCard sync={draft} roles={roles} onChange={patch} />
        <div className='space-y-4'>
          <SimilarCard sync={draft} onChange={patch} />
          <PriorityLanesCard
            sync={draft}
            labels={labels.data}
            unavailable={unavailable}
            onChange={patch}
          />
        </div>
      </div>
      <LabelsCard sync={draft} labels={labels.data} unavailable={unavailable} onChange={patch} />
      <div
        className={cn(
          'sticky bottom-0 z-10 -mx-4 flex items-center justify-end gap-2 border-t border-slate-200 bg-white/95 px-4 py-2.5 backdrop-blur-sm sm:-mx-6 sm:px-6 dark:border-border dark:bg-card/95',
          !dirty && 'hidden'
        )}
      >
        <span className='mr-auto text-[12px] text-slate-600 dark:text-slate-300'>
          Unsaved sync settings
        </span>
        <Button
          type='button'
          variant='ghost'
          size='sm'
          className='h-8 text-[12px]'
          disabled={save.isPending}
          onClick={() => setDraft(connection.sync)}
        >
          Discard
        </Button>
        <Button
          type='button'
          size='sm'
          className='h-8 gap-1.5 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/90'
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
          Save sync settings
        </Button>
      </div>
    </div>
  )
}

function ConnectionView({
  connection,
  fresh,
  roles,
  onSecret,
  onDeleted
}: {
  connection: TrackerConnection
  fresh: { secret: string; url: string } | undefined
  roles: Role[]
  onSecret: (secret: string, url: string) => void
  onDeleted: () => void
}) {
  return (
    <div className='space-y-4'>
      <HealthStrip connection={connection} />
      <div className='grid items-start gap-4 xl:grid-cols-2'>
        <ConnectionCard
          key={connection.id}
          connection={connection}
          onCreated={() => {}}
          onDeleted={onDeleted}
        />
        <WebhookSetup
          connection={connection}
          secret={fresh?.secret ?? null}
          webhookUrl={fresh?.url}
          onSecret={onSecret}
        />
      </div>
      <SyncEditor key={connection.id} connection={connection} roles={roles} />
    </div>
  )
}

function EmptyState({ onConnect }: { onConnect: () => void }) {
  return (
    <div className='flex flex-col items-start gap-3 rounded-lg border border-dashed border-slate-300 bg-white px-6 py-8 dark:border-border dark:bg-card'>
      <GitBranch className='h-6 w-6 text-slate-400' aria-hidden />
      <div className='space-y-1'>
        <p className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          No GitLab connected yet
        </p>
        <p className='max-w-[64ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
          Connect a GitLab project with an access token. Nothing is sent until you add rules or send
          an issue, ticket or record by hand.
        </p>
      </div>
      <Button
        type='button'
        size='sm'
        className='h-8 gap-1.5 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/90'
        onClick={onConnect}
      >
        <Plus className='h-3.5 w-3.5' />
        Connect GitLab
      </Button>
    </div>
  )
}

export function IssueTrackersPage() {
  const qc = useQueryClient()
  const feature = useQuery({ queryKey: trackerKeys.feature(), queryFn: fetchFeature })
  const on = !!feature.data?.enabled
  const connections = useQuery({
    queryKey: trackerKeys.connections(),
    queryFn: fetchConnections,
    enabled: on
  })
  const roles = useQuery<Role[]>({
    queryKey: ['roles'],
    queryFn: () => api.get<{ data: Role[] }>('/roles').then((r) => r.data.data),
    enabled: on
  })
  const [selected, setSelected] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [fresh, setFresh] = useState<Record<number, { secret: string; url: string }>>({})

  const list = connections.data ?? []
  const current = list.find((c) => c.id === selected) ?? list[0] ?? null

  const created = (c: CreatedConnection) => {
    setFresh((f) => ({ ...f, [c.id]: { secret: c.webhook_secret, url: c.webhook_url } }))
    qc.setQueryData<TrackerConnection[]>(trackerKeys.connections(), (prev) => {
      const { webhook_secret: _s, webhook_url: _u, ...view } = c
      return [...(prev ?? []).filter((x) => x.id !== c.id), view]
    })
    setSelected(c.id)
    setAdding(false)
    toast.success('GitLab connected. Set up the webhook next.')
  }

  let body: React.ReactNode
  if (feature.isLoading) body = <Skeleton className='h-16' />
  else if (feature.isError)
    body = (
      <ErrorNotice error={feature.error} what='GitLab sync' onRetry={() => feature.refetch()} />
    )
  else if (!on)
    body = <p className='px-1 text-[12.5px] text-slate-600 dark:text-slate-300'>{OFF_LINE}</p>
  else if (connections.isLoading)
    body = (
      <div className='space-y-3'>
        <Skeleton className='h-14' />
        <Skeleton className='h-48' />
      </div>
    )
  else if (connections.isError)
    body = (
      <ErrorNotice
        error={connections.error}
        what='the GitLab connections'
        onRetry={() => connections.refetch()}
      />
    )
  else if (adding)
    body = (
      <ConnectionCard
        connection={null}
        onCreated={created}
        onDeleted={() => {}}
        onCancel={() => setAdding(false)}
      />
    )
  else if (!current) body = <EmptyState onConnect={() => setAdding(true)} />
  else
    body = (
      <div className='space-y-4'>
        {list.length > 1 && (
          <nav aria-label='GitLab connections' className='flex flex-wrap items-center gap-1.5'>
            {list.map((c) => (
              <button
                key={c.id}
                type='button'
                aria-pressed={c.id === current.id}
                onClick={() => setSelected(c.id)}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
                  c.id === current.id
                    ? 'border-nvr-cyan/40 bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-300 dark:hover:bg-muted/50'
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    !c.is_active
                      ? 'bg-slate-400'
                      : c.status === 'broken'
                        ? 'bg-red-500'
                        : 'bg-emerald-500'
                  )}
                />
                {c.name}
              </button>
            ))}
          </nav>
        )}
        <ConnectionView
          key={current.id}
          connection={current}
          fresh={fresh[current.id]}
          roles={roles.data ?? []}
          onSecret={(secret, url) => setFresh((f) => ({ ...f, [current.id]: { secret, url } }))}
          onDeleted={() => {
            setSelected(null)
            setFresh(({ [current.id]: _gone, ...rest }) => rest)
          }}
        />
      </div>
    )

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description='Send issues, support tickets and records to GitLab as issues, and bring comments, status and labels back.'
        actions={
          on && list.length > 0 && !adding ? (
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='h-8 gap-1.5 text-[12px]'
              onClick={() => setAdding(true)}
            >
              <Plus className='h-3.5 w-3.5' />
              Add connection
            </Button>
          ) : undefined
        }
      />
      <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <div className='space-y-4 px-4 pt-4 sm:px-6 sm:pt-6'>
          <FeatureSwitch state={feature.data} />
          {body}
          <div className='h-4' />
        </div>
      </div>
    </div>
  )
}
