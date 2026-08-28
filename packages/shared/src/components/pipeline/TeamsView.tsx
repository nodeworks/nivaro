import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Users2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useItemNavigation, useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { cn, formatRelative } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { MemberPickerCombobox } from './OwnerMatrix'
import { TeamScopeEditor } from './TeamScopeEditor'
import type { TeamScopeMap } from './teamScopes'

/**
 * Teams management — the whole Teams surface (list, create, meta, scope,
 * ranked roster) as one shared view, hostable full-page (admin /user-groups)
 * or inside a slide-over (the Owner Matrix "Manage teams" sheet). All data
 * flows through the SDK client; the server enforces admin on every mutation —
 * `canManage` only hides controls that would 403.
 */

export interface TeamRow {
  id: number
  name: string
  slug: string
  description: string | null
  member_count: number
  scopes?: TeamScopeMap
}

interface TeamMember {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
}

function memberLabel(u: TeamMember) {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
}

function CreateTeamForm({
  onCreated,
  onCancel
}: {
  onCreated: (id: number) => void
  onCancel: () => void
}) {
  const client = useNivaroClient()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [description, setDescription] = useState('')
  const create = useMutation({
    mutationFn: () =>
      client
        .request<{ data: TeamRow }>(
          post('/user-groups', {
            name: name.trim(),
            ...(slug.trim() ? { slug: slug.trim() } : {}),
            ...(description.trim() ? { description: description.trim() } : {})
          })
        )
        .then((r) => r.data),
    onSuccess: (g) => {
      toast.success(`Created ${g.name}`)
      onCreated(g.id)
    },
    onError: (e) =>
      toast.error((e as { response?: { error?: string } })?.response?.error ?? 'Create failed')
  })
  return (
    <div className='mx-auto max-w-xl p-5'>
      <div className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
        <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>New team</h2>
        <div className='mt-3 space-y-3'>
          <div>
            <label className='mb-1 block text-[11.5px] font-medium text-slate-500' htmlFor='tv-name'>
              Name
            </label>
            <Input
              id='tv-name'
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='Field Techs'
              className='h-8 text-[13px]'
            />
          </div>
          <div>
            <label className='mb-1 block text-[11.5px] font-medium text-slate-500' htmlFor='tv-slug'>
              Slug{' '}
              <span className='font-normal text-slate-400'>
                (mention handle — blank derives from the name)
              </span>
            </label>
            <Input
              id='tv-slug'
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder='field-techs'
              className='h-8 font-mono text-[12.5px]'
            />
          </div>
          <div>
            <label className='mb-1 block text-[11.5px] font-medium text-slate-500' htmlFor='tv-desc'>
              Description
            </label>
            <Textarea
              id='tv-desc'
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className='text-[13px]'
            />
          </div>
          <div className='flex items-center gap-2 pt-1'>
            <Button
              size='sm'
              className='text-[12px]'
              disabled={!name.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              Create team
            </Button>
            <Button size='sm' variant='ghost' className='text-[12px]' onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}


// ─── Team overview data (ownership footprint, throughput, live workload) ─────

interface TeamOverview {
  team: { id: number; name: string; description: string | null }
  roster: Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string
    title: string | null
    department: string | null
    status: string | null
    is_out_of_office: boolean
    actions_30d: number
    last_action_at: string | null
  }>
  cells: {
    total: number
    states: Array<{
      template_name: string
      state_label: string
      count: number
      dims: Record<string, string[]>
    }>
  }
  throughput: {
    weekly: Array<{ week_start: string; count: number }>
    total_30d: number
    total_90d: number
    sendbacks_30d: number
  }
}

interface TeamWorkload {
  total: number
  truncated: boolean
  by_state: Array<{
    state_label: string
    template_name: string
    count: number
    sla_warning: number
    sla_breached: number
  }>
  members: Array<{ id: string; name: string; count: number }>
  records: Array<{
    collection: string
    item_id: string
    label: string
    state_label: string
    sla_status: string | null
    started_at: string | null
    owners: string[]
  }>
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className='text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400 dark:text-slate-500'>
      {children}
    </p>
  )
}

function StatTile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'amber' | 'red' }) {
  return (
    <div className='bg-white px-4 py-3 dark:bg-card'>
      <p className='text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400 dark:text-slate-500'>
        {label}
      </p>
      <p
        className={cn(
          'mt-0.5 text-[18px] font-semibold tabular-nums',
          tone === 'red'
            ? 'text-red-600 dark:text-red-400'
            : tone === 'amber'
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-slate-800 dark:text-foreground'
        )}
      >
        {value}
      </p>
    </div>
  )
}

/** 12-week action sparkline — violet, the team identity color. */
function WeeklySpark({ weekly }: { weekly: Array<{ week_start: string; count: number }> }) {
  if (weekly.length < 2) return null
  const W = 220
  const H = 36
  const max = Math.max(...weekly.map((w) => w.count), 1)
  const pts = weekly
    .map(
      (w, i) =>
        `${((i / (weekly.length - 1)) * (W - 4) + 2).toFixed(1)},${(H - 4 - (w.count / max) * (H - 8)).toFixed(1)}`
    )
    .join(' ')
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className='shrink-0' aria-hidden>
      <polyline points={pts} fill='none' stroke='#8b5cf6' strokeWidth='1.5' strokeLinejoin='round' />
      {weekly.length > 0 && (
        <circle
          cx={((weekly.length - 1) / (weekly.length - 1)) * (W - 4) + 2}
          cy={H - 4 - (weekly[weekly.length - 1].count / max) * (H - 8)}
          r='2.5'
          fill='#8b5cf6'
        />
      )}
    </svg>
  )
}

function slaDot(status: string | null) {
  if (status === 'breached') return <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-red-500' title='SLA breached' />
  if (status === 'warning') return <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500' title='SLA warning' />
  return null
}

/** What this team owns — the matrix cells it is linked to, per state, with the
 *  dimension coverage those cells span. */
function OwnsCard({ overview }: { overview: TeamOverview }) {
  const states = overview.cells.states
  if (states.length === 0)
    return (
      <div className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
        <SectionLabel>Owns</SectionLabel>
        <p className='mt-2 text-[12.5px] italic text-slate-400'>
          Not linked to any owner-matrix cells yet — link this team from a pipeline's Owner Matrix.
        </p>
      </div>
    )
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
      <div className='flex items-baseline justify-between'>
        <SectionLabel>Owns</SectionLabel>
        <span className='text-[11px] tabular-nums text-slate-400'>
          {overview.cells.total} matrix cell{overview.cells.total === 1 ? '' : 's'}
        </span>
      </div>
      <div className='mt-2 divide-y divide-slate-100 dark:divide-border/60'>
        {states.map((st) => (
          <div key={`${st.template_name}:${st.state_label}`} className='py-2.5 first:pt-1 last:pb-0'>
            <div className='flex items-baseline gap-2'>
              <span className='h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full bg-violet-500' />
              <span className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
                {st.state_label}
              </span>
              <span className='text-[11px] text-slate-400'>{st.template_name}</span>
              <span className='ml-auto text-[11px] tabular-nums text-slate-400'>
                {st.count} cell{st.count === 1 ? '' : 's'}
              </span>
            </div>
            <div className='mt-1.5 space-y-1 pl-3.5'>
              {Object.entries(st.dims).map(([dim, values]) => (
                <div key={dim} className='flex flex-wrap items-baseline gap-1'>
                  <span className='mr-0.5 text-[10.5px] font-medium text-slate-400'>{dim}</span>
                  {values.slice(0, 8).map((v) => (
                    <span
                      key={v}
                      className='rounded bg-slate-100 px-1.5 py-px text-[10.5px] text-slate-600 dark:bg-muted dark:text-slate-300'
                    >
                      {v}
                    </span>
                  ))}
                  {values.length > 8 && (
                    <span className='text-[10.5px] text-slate-400'>+{values.length - 8} more</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Live workload — resolved through the real owner engine on open, so it is
 *  what the team is actually on the hook for right now. */
function WorkloadCard({ workload, loading }: { workload: TeamWorkload | undefined; loading: boolean }) {
  const nav = useItemNavigation()
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
      <div className='flex items-baseline justify-between'>
        <SectionLabel>Waiting on this team</SectionLabel>
        {loading ? (
          <span className='flex items-center gap-1.5 text-[11px] text-slate-400'>
            <Loader2 className='h-3 w-3 animate-spin' /> resolving live…
          </span>
        ) : (
          <span className='text-[11px] text-slate-400'>live — resolved just now</span>
        )}
      </div>
      {loading ? (
        <div className='mt-3 space-y-2'>
          <div className='h-4 w-2/3 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
          <div className='h-4 w-1/2 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
        </div>
      ) : !workload || workload.total === 0 ? (
        <p className='mt-2 text-[12.5px] italic text-slate-400'>
          Nothing is waiting on this team right now.
        </p>
      ) : (
        <>
          {workload.truncated && (
            <p className='mt-1.5 text-[11px] text-amber-600 dark:text-amber-400'>
              Large backlog — counts cover the newest 4,000 open records.
            </p>
          )}
          <div className='mt-2 divide-y divide-slate-100 dark:divide-border/60'>
            {workload.by_state.map((st) => (
              <div key={`${st.template_name}:${st.state_label}`} className='flex items-baseline gap-2 py-1.5'>
                <span className='text-[12.5px] text-slate-700 dark:text-slate-200'>{st.state_label}</span>
                <span className='text-[10.5px] text-slate-400'>{st.template_name}</span>
                <span className='ml-auto flex items-center gap-2 tabular-nums'>
                  {st.sla_breached > 0 && (
                    <span className='flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400'>
                      <span className='h-1.5 w-1.5 rounded-full bg-red-500' /> {st.sla_breached}
                    </span>
                  )}
                  {st.sla_warning > 0 && (
                    <span className='flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400'>
                      <span className='h-1.5 w-1.5 rounded-full bg-amber-500' /> {st.sla_warning}
                    </span>
                  )}
                  <span className='text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                    {st.count}
                  </span>
                </span>
              </div>
            ))}
          </div>
          {workload.records.length > 0 && (
            <div className='mt-3'>
              <p className='text-[10.5px] font-medium text-slate-400'>Waiting longest</p>
              <div className='mt-1 divide-y divide-slate-100 dark:divide-border/60'>
                {workload.records.slice(0, 8).map((r) => (
                  <button
                    key={`${r.collection}:${r.item_id}`}
                    type='button'
                    onClick={() => nav.open({ collection: r.collection, itemId: r.item_id })}
                    className='flex w-full items-baseline gap-2 py-1.5 text-left hover:bg-muted'
                  >
                    {slaDot(r.sla_status)}
                    <span className='truncate text-[12.5px] font-medium text-nvr-navy underline decoration-nvr-cyan/50 decoration-[1.5px] underline-offset-2 dark:text-nvr-cyan'>
                      {r.label}
                    </span>
                    <span className='truncate text-[11px] text-slate-400'>{r.state_label}</span>
                    {r.started_at && (
                      <span className='ml-auto shrink-0 text-[11px] tabular-nums text-slate-400'>
                        {formatRelative(r.started_at)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Recent activity — workflow actions by roster members. */
function ActivityCard({ overview }: { overview: TeamOverview }) {
  const t = overview.throughput
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
      <div className='flex items-center justify-between gap-3'>
        <div>
          <SectionLabel>Activity</SectionLabel>
          <p className='mt-1 text-[12.5px] text-slate-600 dark:text-slate-300'>
            <span className='font-semibold tabular-nums text-slate-800 dark:text-foreground'>
              {t.total_30d}
            </span>{' '}
            workflow action{t.total_30d === 1 ? '' : 's'} in 30 days
            {t.sendbacks_30d > 0 && (
              <span className='text-slate-400'> · {t.sendbacks_30d} send-back{t.sendbacks_30d === 1 ? '' : 's'}</span>
            )}
            <span className='text-slate-400'> · {t.total_90d} in 90</span>
          </p>
        </div>
        <WeeklySpark weekly={t.weekly} />
      </div>
      <div className='mt-3 divide-y divide-slate-100 dark:divide-border/60'>
        {[...overview.roster]
          .sort((a, b) => b.actions_30d - a.actions_30d)
          .map((m) => (
            <div key={m.id} className='flex items-baseline gap-2 py-1.5'>
              <span className='text-[12.5px] text-slate-700 dark:text-slate-200'>
                {[m.first_name, m.last_name].filter(Boolean).join(' ') || m.email}
              </span>
              {m.is_out_of_office && (
                <span className='rounded bg-amber-100 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'>
                  Out of office
                </span>
              )}
              <span className='ml-auto text-[11.5px] tabular-nums text-slate-500 dark:text-slate-400'>
                {m.actions_30d} action{m.actions_30d === 1 ? '' : 's'}
              </span>
              <span className='w-24 shrink-0 text-right text-[11px] text-slate-400'>
                {m.last_action_at ? formatRelative(m.last_action_at) : 'no actions'}
              </span>
            </div>
          ))}
      </div>
    </div>
  )
}

function TeamDetail({
  team,
  canManage,
  onChanged,
  onDeleted
}: {
  team: TeamRow
  canManage: boolean
  onChanged: () => void
  onDeleted: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [name, setName] = useState(team.name)
  const [slug, setSlug] = useState(team.slug)
  const [description, setDescription] = useState(team.description ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setName(team.name)
    setSlug(team.slug)
    setDescription(team.description ?? '')
  }, [team.name, team.slug, team.description])

  const { data: overview } = useQuery<TeamOverview>({
    queryKey: ['team-overview', team.id],
    queryFn: () =>
      client
        .request<{ data: TeamOverview }>(get(`/user-groups/${team.id}/overview`))
        .then((r) => r.data),
    staleTime: 60_000
  })
  const { data: workload, isLoading: workloadLoading } = useQuery<TeamWorkload>({
    queryKey: ['team-workload', team.id],
    queryFn: () =>
      client
        .request<{ data: TeamWorkload }>(get(`/user-groups/${team.id}/workload`))
        .then((r) => r.data),
    staleTime: 60_000
  })

  const { data: members = [] } = useQuery<TeamMember[]>({
    queryKey: ['team-members', team.id],
    queryFn: () =>
      client
        .request<{ data: TeamMember[] }>(get(`/user-groups/${team.id}/members`))
        .then((r) => r.data)
  })

  const dirty =
    name.trim() !== team.name ||
    slug.trim() !== team.slug ||
    description.trim() !== (team.description ?? '')

  const fail = (e: unknown, fallback: string) =>
    toast.error((e as { response?: { error?: string } })?.response?.error ?? fallback)
  const save = useMutation({
    mutationFn: () =>
      client.request(
        patch(`/user-groups/${team.id}`, {
          name: name.trim(),
          slug: slug.trim(),
          description: description.trim() || null
        })
      ),
    onSuccess: () => {
      toast.success('Team updated')
      onChanged()
    },
    onError: (e) => fail(e, 'Update failed')
  })
  const remove = useMutation({
    mutationFn: () => client.request(del(`/user-groups/${team.id}`)),
    onSuccess: () => {
      toast.success(`Deleted ${team.name}`)
      onDeleted()
    },
    onError: (e) => fail(e, 'Delete failed')
  })
  const refreshMembers = () => {
    void qc.invalidateQueries({ queryKey: ['team-members', team.id] })
    void qc.invalidateQueries({ queryKey: ['team-candidates'] })
    onChanged()
  }
  const addMember = useMutation({
    mutationFn: (userId: string) =>
      client.request(post(`/user-groups/${team.id}/members`, { user_ids: [userId] })),
    onSuccess: refreshMembers,
    onError: (e) => fail(e, 'Could not add member')
  })
  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      client.request(del(`/user-groups/${team.id}/members/${userId}`)),
    onSuccess: refreshMembers,
    onError: (e) => fail(e, 'Could not remove member')
  })

  return (
    <div className='space-y-4 p-5'>
      <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-5 dark:border-border dark:bg-border'>
        <StatTile label='Members' value={overview ? overview.roster.length : '—'} />
        <StatTile label='Matrix cells' value={overview ? overview.cells.total : '—'} />
        <StatTile label='Waiting now' value={workloadLoading ? '…' : (workload?.total ?? '—')} />
        <StatTile
          label='SLA breached'
          value={workloadLoading ? '…' : (workload?.by_state.reduce((n, st) => n + st.sla_breached, 0) ?? '—')}
          tone={(workload?.by_state.some((st) => st.sla_breached > 0) ?? false) ? 'red' : undefined}
        />
        <StatTile label='Actions · 30d' value={overview ? overview.throughput.total_30d : '—'} />
      </div>

      <div className='grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_400px]'>
        <div className='min-w-0 space-y-4'>
      <div className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
        {canManage ? (
          <div className='space-y-3'>
            <div className='grid grid-cols-2 gap-3'>
              <div>
                <label
                  className='mb-1 block text-[11.5px] font-medium text-slate-500'
                  htmlFor='tvd-name'
                >
                  Name
                </label>
                <Input
                  id='tvd-name'
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className='h-8 text-[13px]'
                />
              </div>
              <div>
                <label
                  className='mb-1 block text-[11.5px] font-medium text-slate-500'
                  htmlFor='tvd-slug'
                >
                  Slug
                </label>
                <Input
                  id='tvd-slug'
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  className='h-8 font-mono text-[12.5px]'
                />
              </div>
            </div>
            <div>
              <label
                className='mb-1 block text-[11.5px] font-medium text-slate-500'
                htmlFor='tvd-desc'
              >
                Description
              </label>
              <Textarea
                id='tvd-desc'
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className='text-[13px]'
              />
            </div>
            <div className='flex items-center justify-between pt-1'>
              <div className='flex items-center gap-2'>
                {dirty && (
                  <Button
                    size='sm'
                    className='text-[12px]'
                    disabled={!name.trim() || !slug.trim() || save.isPending}
                    onClick={() => save.mutate()}
                  >
                    Save changes
                  </Button>
                )}
                <span className='text-[11.5px] text-slate-400'>
                  Mention as <span className='font-mono'>@{team.slug}</span>
                </span>
              </div>
              {confirmDelete ? (
                <span className='flex items-center gap-2'>
                  <span className='text-[11.5px] text-slate-500'>Delete this team?</span>
                  <Button
                    size='sm'
                    variant='destructive'
                    className='h-6 text-[11px]'
                    disabled={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    Yes, delete
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-6 text-[11px]'
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  size='sm'
                  variant='ghost'
                  className='text-[12px] text-slate-400 hover:text-red-500'
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete team
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div>
            <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
              {team.name}
            </h2>
            <p className='text-[11.5px] text-slate-400'>
              Mention as <span className='font-mono'>@{team.slug}</span>
            </p>
            {team.description && (
              <p className='mt-2 text-[12.5px] text-slate-600 dark:text-slate-300'>
                {team.description}
              </p>
            )}
          </div>
        )}
      </div>

      {overview && <OwnsCard overview={overview} />}
      <WorkloadCard workload={workload} loading={workloadLoading} />
        </div>

        <div className='space-y-4'>
      {overview && overview.roster.length > 0 && <ActivityCard overview={overview} />}

      {canManage && (
        <div className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
          <TeamScopeEditor teamId={team.id} scopes={team.scopes ?? {}} onSaved={() => onChanged()} />
        </div>
      )}

      <div className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between gap-3'>
          <h3 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
            Members{' '}
            <span className='font-normal tabular-nums text-slate-400'>({members.length})</span>
          </h3>
          {canManage && (
            <div className='w-56'>
              <MemberPickerCombobox
                teamId={team.id}
                excludeIds={members.map((m) => m.id)}
                isPending={addMember.isPending}
                onPick={(id) => addMember.mutate(id)}
              />
            </div>
          )}
        </div>
        <div className='mt-3'>
          {members.length === 0 ? (
            <p className='text-[12.5px] text-slate-400'>No members yet.</p>
          ) : (
            members.map((m) => (
              <div
                key={m.id}
                className='flex items-center gap-3 border-b border-slate-100 py-2 last:border-0 dark:border-border/60'
              >
                <div className='min-w-0 flex-1'>
                  <p className='truncate text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>
                    {memberLabel(m)}
                  </p>
                  <p className='truncate text-[11px] text-slate-400'>{m.email}</p>
                </div>
                {canManage && (
                  <button
                    type='button'
                    disabled={removeMember.isPending}
                    onClick={() => removeMember.mutate(m.id)}
                    className='rounded p-1 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30'
                    aria-label={`Remove ${memberLabel(m)}`}
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
        </div>
      </div>
    </div>
  )
}

export function TeamsView({
  canManage = true,
  compact = false,
  initialTeamId = null
}: {
  /** Hide mutation controls for non-admin hosts (the server enforces anyway). */
  canManage?: boolean
  /** Tighter rail for slide-over hosting. */
  compact?: boolean
  initialTeamId?: number | null
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(initialTeamId)
  const [creating, setCreating] = useState(false)

  const { data: groups = [], isLoading } = useQuery<TeamRow[]>({
    queryKey: ['user-groups'],
    queryFn: () => client.request<{ data: TeamRow[] }>(get('/user-groups')).then((r) => r.data)
  })
  const selected = groups.find((g) => g.id === selectedId) ?? null
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['user-groups'] })
    void qc.invalidateQueries({ queryKey: ['user-groups-teams'] })
  }

  return (
    <div className='flex h-full min-h-0 flex-1 overflow-hidden'>
      <aside
        className={cn(
          'flex shrink-0 flex-col overflow-hidden border-r border-slate-200 bg-white dark:border-border dark:bg-card',
          compact ? 'w-[200px]' : 'w-[272px]'
        )}
      >
        {canManage && (
          <div className='shrink-0 border-b border-slate-100 p-2 dark:border-border/60'>
            <Button
              size='sm'
              variant='outline'
              className='h-7 w-full gap-1.5 text-[12px]'
              onClick={() => {
                setCreating(true)
                setSelectedId(null)
              }}
            >
              <Plus className='h-3.5 w-3.5' /> New team
            </Button>
          </div>
        )}
        <div className='min-h-0 flex-1 overflow-y-auto'>
          {isLoading ? (
            <p className='p-4 text-[12.5px] text-slate-400'>Loading…</p>
          ) : groups.length === 0 ? (
            <p className='p-4 text-[12.5px] text-slate-400'>No teams yet.</p>
          ) : (
            groups.map((g) => (
              <button
                key={g.id}
                type='button'
                onClick={() => {
                  setSelectedId(g.id)
                  setCreating(false)
                }}
                className={cn(
                  'block w-full border-b border-slate-100 px-4 py-2.5 text-left dark:border-border/60',
                  selectedId === g.id
                    ? 'bg-nvr-cyan/10'
                    : 'hover:bg-slate-50 dark:hover:bg-muted/40'
                )}
              >
                <p className='truncate text-[13px] font-medium text-slate-800 dark:text-foreground'>
                  {g.name}
                </p>
                <p
                  className={cn(
                    'truncate text-[11px]',
                    selectedId === g.id
                      ? 'text-nvr-navy/70 dark:text-nvr-cyan/80'
                      : 'text-slate-400'
                  )}
                >
                  @{g.slug} · {g.member_count} member{g.member_count === 1 ? '' : 's'}
                </p>
              </button>
            ))
          )}
        </div>
      </aside>

      <div className='min-h-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        {creating && canManage ? (
          <CreateTeamForm
            onCreated={(id) => {
              setCreating(false)
              setSelectedId(id)
              invalidate()
            }}
            onCancel={() => setCreating(false)}
          />
        ) : selected ? (
          <TeamDetail
            key={selected.id}
            team={selected}
            canManage={canManage}
            onChanged={invalidate}
            onDeleted={() => {
              setSelectedId(null)
              invalidate()
            }}
          />
        ) : (
          <div className='pt-24 text-center text-slate-400'>
            <Users2 className='mx-auto h-8 w-8 opacity-40' />
            <p className='mt-3 text-[13px]'>
              {groups.length === 0
                ? canManage
                  ? 'Create your first team to get started.'
                  : 'No teams have been created yet.'
                : 'Select a team to view its members and scope.'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
