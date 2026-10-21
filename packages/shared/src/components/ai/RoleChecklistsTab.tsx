import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Plus, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post, put } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { SimpleSelect } from '../ui/SimpleSelect'

/**
 * First-week checklists per role (#2472). The AI drafts from what the role
 * touches; an admin edits and publishes. Nothing reaches people unreviewed.
 * People see the published list in My Work for their first two weeks.
 */

export interface ChecklistStep {
  id: string
  title: string
  detail: string | null
  kind: 'open' | 'video' | 'record'
  path: string | null
  video_id: string | null
  collection: string | null
}

interface RoleRow {
  role_id: string
  name: string
  status: 'none' | 'draft' | 'published' | 'changed'
  steps: number
  published_at: string | null
}

interface Detail {
  checklist: {
    draft: ChecklistStep[] | null
    published: ChecklistStep[] | null
    unpublished_changes: boolean
    drafted_at: string | null
    published_at: string | null
  } | null
  basis: {
    collections: Array<{ collection: string; display_name: string | null; can_write: boolean }>
    queues: Array<{ id: string; name: string }>
    videos: Array<{ id: string; title: string; required: boolean }>
  }
}

const STATUS_LABEL: Record<RoleRow['status'], string> = {
  none: 'No checklist',
  draft: 'Draft, not published',
  published: 'Published',
  changed: 'Published, edits waiting'
}

const errMsg = (e: unknown, fallback: string) => (e as { message?: string })?.message || fallback

/** Where a step can point: only what the role actually has. */
function targets(b: Detail['basis']) {
  const out: Array<{ value: string; label: string; step: Partial<ChecklistStep> }> = [
    { value: 'p:/my-work', label: 'My Work', step: { kind: 'open', path: '/my-work' } }
  ]
  for (const q of b.queues)
    out.push({
      value: `p:/queues/${q.id}`,
      label: `Open queue: ${q.name}`,
      step: { kind: 'open', path: `/queues/${q.id}` }
    })
  for (const c of b.collections)
    out.push({
      value: `p:/collections/${c.collection}`,
      label: `Open ${c.display_name || c.collection}`,
      step: { kind: 'open', path: `/collections/${c.collection}` }
    })
  for (const v of b.videos)
    out.push({
      value: `v:${v.id}`,
      label: `Watch: ${v.title}`,
      step: { kind: 'video', video_id: v.id, path: `/help-videos?watch=${v.id}` }
    })
  for (const c of b.collections.filter((x) => x.can_write))
    out.push({
      value: `r:${c.collection}`,
      label: `Save a first ${c.display_name || c.collection} record`,
      step: { kind: 'record', collection: c.collection, path: `/collections/${c.collection}` }
    })
  return out
}

const targetOf = (s: ChecklistStep) =>
  s.kind === 'video' ? `v:${s.video_id}` : s.kind === 'record' ? `r:${s.collection}` : `p:${s.path}`

function Editor({ role, onBack }: { role: RoleRow; onBack: () => void }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const key = ['nvr-role-checklist', role.role_id]
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      client.request<{ data: Detail }>(get(`/role-checklists/${role.role_id}`)).then((r) => r.data)
  })
  const [steps, setSteps] = useState<ChecklistStep[]>([])
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    if (q.data) {
      setSteps(q.data.checklist?.draft ?? q.data.checklist?.published ?? [])
      setDirty(false)
    }
  }, [q.data])
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key })
    void qc.invalidateQueries({ queryKey: ['nvr-role-checklists'] })
  }
  const draft = useMutation({
    mutationFn: () => client.request(post(`/role-checklists/${role.role_id}/draft`)),
    onSuccess: () => {
      toast.success('Drafted. Read it through before you publish.')
      refresh()
    },
    onError: (e) => toast.error(errMsg(e, 'Drafting failed'))
  })
  const save = useMutation({
    mutationFn: () => client.request(put(`/role-checklists/${role.role_id}`, { steps })),
    onSuccess: () => {
      toast.success('Saved')
      refresh()
    },
    onError: (e) => toast.error(errMsg(e, 'Could not save'))
  })
  const publish = useMutation({
    mutationFn: async () => {
      if (dirty) await client.request(put(`/role-checklists/${role.role_id}`, { steps }))
      return client.request(post(`/role-checklists/${role.role_id}/publish`))
    },
    onSuccess: () => {
      toast.success(`Published for ${role.name}`)
      refresh()
    },
    onError: (e) => toast.error(errMsg(e, 'Could not publish'))
  })
  const unpublish = useMutation({
    mutationFn: () => client.request(post(`/role-checklists/${role.role_id}/unpublish`)),
    onSuccess: () => {
      toast.success('Unpublished — people no longer see it')
      refresh()
    },
    onError: (e) => toast.error(errMsg(e, 'Could not unpublish'))
  })
  const opts = q.data ? targets(q.data.basis) : []
  const edit = (i: number, patch: Partial<ChecklistStep>) => {
    setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)))
    setDirty(true)
  }
  const move = (i: number, d: -1 | 1) => {
    setSteps((s) => {
      const n = [...s]
      const [x] = n.splice(i, 1)
      n.splice(i + d, 0, x)
      return n
    })
    setDirty(true)
  }
  const published = q.data?.checklist?.published
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <button
          type='button'
          onClick={onBack}
          className='text-[12px] text-muted-foreground underline'
        >
          All roles
        </button>
        <span className='text-[13px] font-semibold'>{role.name}</span>
        <div className='ml-auto flex flex-wrap items-center gap-2'>
          <Button
            size='sm'
            variant='outline'
            className='h-8 text-[12px]'
            disabled={draft.isPending}
            data-tip='Writes a new draft from what this role touches. Your published list stays as it is.'
            onClick={() => draft.mutate()}
          >
            <Sparkles className='h-3.5 w-3.5' />
            {draft.isPending ? 'Drafting…' : steps.length ? 'Redraft with AI' : 'Draft with AI'}
          </Button>
          <Button
            size='sm'
            variant='outline'
            className='h-8 text-[12px]'
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            Save draft
          </Button>
          <Button
            size='sm'
            className='h-8 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/90'
            disabled={!steps.length || publish.isPending}
            onClick={() => publish.mutate()}
          >
            Publish
          </Button>
          {published && (
            <Button
              size='sm'
              variant='ghost'
              className='h-8 text-[12px]'
              disabled={unpublish.isPending}
              onClick={() => unpublish.mutate()}
            >
              Unpublish
            </Button>
          )}
        </div>
      </div>
      <p className='max-w-[75ch] text-[11.5px] text-muted-foreground'>
        {published
          ? q.data?.checklist?.unpublished_changes
            ? 'People see the published list. Your edits are not published yet.'
            : 'This list is published. New people in this role see it in My Work for their first two weeks.'
          : 'Not published: nobody sees this yet. Steps tick themselves when the person opens the link, watches the video or saves a record.'}
      </p>
      {q.isLoading ? (
        <div className='h-24 animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]' />
      ) : q.isError ? (
        <div className='rounded-lg border border-red-200 p-4 text-[12.5px] text-red-700 dark:border-red-900 dark:text-red-300'>
          Could not load this role.
        </div>
      ) : (
        <>
          {!steps.length && (
            <div className='rounded-lg border border-dashed border-slate-300 p-8 text-center text-[12.5px] text-muted-foreground dark:border-border'>
              No steps yet. Draft with AI, or add steps yourself.
            </div>
          )}
          <ol className='flex flex-col gap-2'>
            {steps.map((s, i) => (
              <li
                key={s.id}
                className='flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'
              >
                <div className='flex items-center gap-2'>
                  <span className='w-5 text-right text-[12px] text-muted-foreground tabular-nums'>
                    {i + 1}
                  </span>
                  <Input
                    value={s.title}
                    maxLength={120}
                    aria-label={`Step ${i + 1} title`}
                    onChange={(e) => edit(i, { title: e.target.value })}
                    className='h-8 flex-1 text-[12.5px]'
                  />
                  <button
                    type='button'
                    aria-label='Move up'
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    className='rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30'
                  >
                    <ArrowUp className='h-3.5 w-3.5' />
                  </button>
                  <button
                    type='button'
                    aria-label='Move down'
                    disabled={i === steps.length - 1}
                    onClick={() => move(i, 1)}
                    className='rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30'
                  >
                    <ArrowDown className='h-3.5 w-3.5' />
                  </button>
                  <button
                    type='button'
                    aria-label='Remove step'
                    onClick={() => {
                      setSteps((x) => x.filter((_, j) => j !== i))
                      setDirty(true)
                    }}
                    className='rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-600'
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </button>
                </div>
                <div className='grid gap-2 pl-7 sm:grid-cols-2'>
                  <SimpleSelect
                    value={targetOf(s)}
                    onChange={(v) => {
                      const t = opts.find((o) => o.value === v)
                      if (t)
                        edit(i, {
                          kind: 'open',
                          video_id: null,
                          collection: null,
                          path: null,
                          ...t.step
                        })
                    }}
                    ariaLabel={`Step ${i + 1} goes to`}
                    className='h-8 text-[12px]'
                    options={[
                      ...(opts.some((o) => o.value === targetOf(s))
                        ? []
                        : [{ value: targetOf(s), label: 'Not available for this role' }]),
                      ...opts.map((o) => ({ value: o.value, label: o.label }))
                    ]}
                  />
                  <Input
                    value={s.detail ?? ''}
                    maxLength={300}
                    placeholder='Why it matters (optional)'
                    aria-label={`Step ${i + 1} note`}
                    onChange={(e) => edit(i, { detail: e.target.value || null })}
                    className={cn('h-8 text-[12px]')}
                  />
                </div>
              </li>
            ))}
          </ol>
          {steps.length < 10 && (
            <Button
              size='sm'
              variant='ghost'
              className='h-8 w-fit text-[12px]'
              onClick={() => {
                const t = opts[0]
                if (!t) return
                setSteps((s) => [
                  ...s,
                  {
                    id: `step-${Date.now().toString(36)}`,
                    title: '',
                    detail: null,
                    kind: 'open',
                    path: null,
                    video_id: null,
                    collection: null,
                    ...t.step
                  } as ChecklistStep
                ])
                setDirty(true)
              }}
            >
              <Plus className='h-3.5 w-3.5' /> Add a step
            </Button>
          )}
        </>
      )}
    </div>
  )
}

export function RoleChecklistsTab() {
  const client = useNivaroClient()
  const [role, setRole] = useState<RoleRow | null>(null)
  const q = useQuery({
    queryKey: ['nvr-role-checklists'],
    queryFn: () =>
      client
        .request<{ data: { ready: boolean; roles: RoleRow[] } }>(get('/role-checklists'))
        .then((r) => r.data)
  })
  if (role) return <Editor role={role} onBack={() => setRole(null)} />
  return (
    <div className='flex flex-col gap-3' data-role-checklists>
      <p className='max-w-[75ch] text-[11.5px] text-muted-foreground'>
        A first-week checklist per role. The AI drafts it from the role's forms, queues, required
        videos and shared views; you edit and publish it. A new person sees it in My Work for their
        first two weeks and the steps tick themselves.
      </p>
      {q.isLoading ? (
        <div className='h-24 animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]' />
      ) : q.isError ? (
        <div className='rounded-lg border border-red-200 p-4 text-[12.5px] text-red-700 dark:border-red-900 dark:text-red-300'>
          Could not load the roles.
        </div>
      ) : !q.data?.ready ? (
        <div className='rounded-lg border border-dashed border-slate-300 p-8 text-center text-[12.5px] text-muted-foreground dark:border-border'>
          Checklists are not set up on this database yet.
        </div>
      ) : (
        <ul className='divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white dark:divide-border/60 dark:border-border dark:bg-card'>
          {q.data.roles.map((r) => (
            <li key={r.role_id}>
              <button
                type='button'
                onClick={() => setRole(r)}
                className='flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted'
              >
                <span className='flex-1 text-[13px] font-medium'>{r.name}</span>
                <span
                  className={cn(
                    'text-[11.5px] text-muted-foreground',
                    r.status === 'published' && 'text-emerald-700 dark:text-emerald-400'
                  )}
                >
                  {STATUS_LABEL[r.status]}
                  {r.steps > 0 && ` · ${r.steps} steps`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
