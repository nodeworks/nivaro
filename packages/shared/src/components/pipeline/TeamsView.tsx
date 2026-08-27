import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Users2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
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
    <div className='mx-auto max-w-2xl space-y-4 p-5'>
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
