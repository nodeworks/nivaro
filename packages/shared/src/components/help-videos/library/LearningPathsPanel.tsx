import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2, X } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Switch } from '../../ui/switch'
import { Textarea } from '../../ui/textarea'
import { helpVideoKeys, learningPathApi, useHelpVideoLibrary, useLearningPaths } from '../api'
import { PickerCombo, RemovableChip } from '../editor/PickerCombo'
import type { HelpVideoPathDto, HelpVideoPathRole } from '../types'
import { formatDuration } from '../viewer/format'
import { moveItem } from '../viewer/paths'

/**
 * The Paths tab of the library (#1508): authors make an ordered list of
 * videos, assign it to roles (required or not) and switch on "New User" so
 * everyone whose account is new gets it. Progress is per person and shows on
 * My Work; authors see the path, not who finished it.
 */

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none'

type Draft = {
  title: string
  description: string
  status: 'draft' | 'published'
  new_user: boolean
  video_ids: string[]
  roles: HelpVideoPathRole[]
}

function draftOf(p: HelpVideoPathDto | null): Draft {
  return {
    title: p?.title ?? '',
    description: p?.description ?? '',
    status: p?.status ?? 'draft',
    new_user: p?.new_user ?? false,
    video_ids: p?.items.map((i) => i.video_id) ?? [],
    roles: p?.roles.map((r) => ({ role_id: r.role_id, required: r.required })) ?? []
  }
}

export function LearningPathsPanel() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const paths = useLearningPaths()
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const current =
    editing && editing !== 'new' ? (paths.data?.find((p) => p.id === editing) ?? null) : null
  return (
    <div className='space-y-4' data-hv-paths>
      <div className='flex flex-wrap items-center gap-3'>
        <p className='text-[13px] text-muted-foreground'>
          An ordered list of videos for a role — "Getting started as a Workflow Creator". People see
          it on My Work with their progress and a Continue button; a required path joins their
          required list until every video in it is watched.
        </p>
        <Button size='sm' className='ml-auto' onClick={() => setEditing('new')} data-hv-path-new>
          <Plus className='h-4 w-4' /> New path
        </Button>
      </div>
      {paths.isLoading && <p className='text-[13px] text-muted-foreground'>Loading…</p>}
      {paths.isError && (
        <p role='alert' className='text-[13px] text-rose-700 dark:text-rose-300'>
          Paths could not be loaded. Try again in a moment.
        </p>
      )}
      {paths.data && paths.data.length === 0 && editing !== 'new' && (
        <p className='text-[13px] text-muted-foreground' data-hv-paths-empty>
          No learning paths yet.
        </p>
      )}
      {!!paths.data?.length && (
        <ul className='divide-y divide-border rounded-lg border border-border bg-card'>
          {paths.data.map((p) => (
            <li
              key={p.id}
              className='flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2'
              data-hv-path-row={p.id}
            >
              <span className='min-w-[10rem] flex-1 truncate text-[13px] font-medium'>
                {p.title || 'Untitled path'}
              </span>
              <span className='text-[12px] text-muted-foreground'>
                {p.status === 'published' ? 'Published' : 'Draft'} · {p.items.length}{' '}
                {p.items.length === 1 ? 'video' : 'videos'} · {p.roles.length}{' '}
                {p.roles.length === 1 ? 'role' : 'roles'}
                {p.new_user ? ' · New users' : ''}
              </span>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => setEditing(p.id)}
                data-hv-path-edit={p.id}
              >
                Edit
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <PathEditor
          key={editing}
          path={current}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            void qc.invalidateQueries({ queryKey: helpVideoKeys.paths })
            void qc.invalidateQueries({ queryKey: helpVideoKeys.myPaths })
            void qc.invalidateQueries({ queryKey: helpVideoKeys.required })
            setEditing(p ? p.id : null)
          }}
          api={learningPathApi(client)}
        />
      )}
    </div>
  )
}

function PathEditor({
  path,
  onClose,
  onSaved,
  api
}: {
  path: HelpVideoPathDto | null
  onClose: () => void
  onSaved: (p: HelpVideoPathDto | null) => void
  api: ReturnType<typeof learningPathApi>
}) {
  const client = useNivaroClient()
  const id = useId()
  const [d, setD] = useState<Draft>(() => draftOf(path))
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  // The editor is keyed by the path id: a refetch of the same path (after
  // Save) keeps the person's edits, and a different path starts fresh.
  const roles = useQuery({
    queryKey: ['chat-roles'],
    queryFn: async () =>
      (await client.request(get<{ data: Array<{ id: string; name: string }> }>('/chat/roles'))).data
  })
  const library = useHelpVideoLibrary({ status: 'published' })
  const known = new Map<string, { title: string; duration_ms: number | null }>()
  for (const v of library.data?.data ?? []) known.set(v.id.toLowerCase(), v)
  for (const i of path?.items ?? []) {
    if (!known.has(i.video_id.toLowerCase())) known.set(i.video_id.toLowerCase(), i)
  }
  const titleOf = (vid: string) => known.get(vid.toLowerCase())?.title ?? 'Unknown video'
  const roleName = (rid: string) =>
    roles.data?.find((r) => r.id.toUpperCase() === rid.toUpperCase())?.name ??
    (roles.isLoading ? 'Loading…' : 'Unknown role')
  const patch = (p: Partial<Draft>) => setD((cur) => ({ ...cur, ...p }))

  const save = async () => {
    const title = d.title.trim()
    if (!title) {
      setProblem('Give the path a title.')
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      const details = {
        title,
        description: d.description.trim() || null,
        status: d.status,
        new_user: d.new_user
      }
      const base = path ? await api.update(path.id, details) : await api.create(details)
      await api.setItems(base.id, d.video_ids)
      const saved = await api.setRoles(base.id, d.roles)
      toast.success(path ? `"${title}" saved` : `"${title}" created`)
      onSaved(saved)
    } catch (e) {
      setProblem(`The path could not be saved. ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!path) return
    if (!window.confirm(`Delete "${path.title || 'Untitled path'}"? Nobody's progress is lost.`))
      return
    setBusy(true)
    try {
      await api.remove(path.id)
      toast.success(`"${path.title}" deleted`)
      onSaved(null)
    } catch (e) {
      setProblem(`The path could not be deleted. ${(e as Error).message}`)
      setBusy(false)
    }
  }

  return (
    <section
      className='space-y-4 rounded-lg border border-border bg-card p-4'
      aria-label={path ? `Edit ${path.title}` : 'New learning path'}
      data-hv-path-editor={path?.id ?? 'new'}
    >
      <div className='flex items-center gap-2'>
        <h2 className='text-[14px] font-semibold'>{path ? 'Edit path' : 'New path'}</h2>
        <Button size='sm' variant='ghost' className='ml-auto' onClick={onClose} aria-label='Close'>
          <X className='h-4 w-4' />
        </Button>
      </div>
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-1'>
          <Label htmlFor={`${id}-title`} className='text-[12px]'>
            Title
          </Label>
          <Input
            id={`${id}-title`}
            value={d.title}
            maxLength={200}
            onChange={(e) => patch({ title: e.target.value })}
            placeholder='Getting started as a Workflow Creator'
            className='h-8 text-[13px]'
            data-hv-path-title
          />
        </div>
        <div className='space-y-1'>
          <Label htmlFor={`${id}-desc`} className='text-[12px]'>
            Description
          </Label>
          <Textarea
            id={`${id}-desc`}
            value={d.description}
            maxLength={2000}
            rows={2}
            onChange={(e) => patch({ description: e.target.value })}
            className='text-[13px]'
          />
        </div>
      </div>
      <div className='flex flex-wrap items-center gap-5'>
        <div className='flex items-center gap-2'>
          <Switch
            id={`${id}-published`}
            checked={d.status === 'published'}
            onCheckedChange={(v) => patch({ status: v ? 'published' : 'draft' })}
            data-hv-path-published={d.status === 'published' ? 'on' : 'off'}
          />
          <Label htmlFor={`${id}-published`} className='text-[13px] font-normal'>
            Published
          </Label>
        </div>
        <div className='flex items-center gap-2'>
          <Switch
            id={`${id}-new-user`}
            checked={d.new_user}
            onCheckedChange={(v) => patch({ new_user: v })}
            data-hv-path-new-user={d.new_user ? 'on' : 'off'}
          />
          <Label htmlFor={`${id}-new-user`} className='text-[13px] font-normal'>
            New User path
          </Label>
          <span className='text-[12px] text-muted-foreground'>
            shows to every account in its first week, whatever its role
          </span>
        </div>
      </div>

      <div className='space-y-1.5'>
        <p className='text-[12px] font-medium'>Videos, in order</p>
        {d.video_ids.length === 0 && (
          <p className='text-[12px] text-muted-foreground'>
            No videos yet — add published videos below.
          </p>
        )}
        <ol className='space-y-1' data-hv-path-items>
          {d.video_ids.map((vid, i) => (
            <li
              key={vid}
              draggable
              onDragStart={() => setDragging(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragging !== null) patch({ video_ids: moveItem(d.video_ids, dragging, i) })
                setDragging(null)
              }}
              onDragEnd={() => setDragging(null)}
              className={`flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1 text-[13px] ${dragging === i ? 'opacity-60' : ''}`}
              data-hv-path-item={vid}
            >
              <GripVertical
                className='h-4 w-4 shrink-0 cursor-grab text-muted-foreground'
                aria-hidden
              />
              <span className='w-5 shrink-0 text-right tabular-nums text-muted-foreground'>
                {i + 1}.
              </span>
              <span className='min-w-0 flex-1 truncate'>{titleOf(vid)}</span>
              <span className='shrink-0 text-[12px] text-muted-foreground'>
                {formatDuration(known.get(vid.toLowerCase())?.duration_ms ?? null)}
              </span>
              <button
                type='button'
                className={`rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-40 ${focusRing}`}
                onClick={() => patch({ video_ids: moveItem(d.video_ids, i, i - 1) })}
                disabled={i === 0}
                aria-label={`Move ${titleOf(vid)} up`}
                data-hv-path-up={vid}
              >
                <ArrowUp className='h-3.5 w-3.5' />
              </button>
              <button
                type='button'
                className={`rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-40 ${focusRing}`}
                onClick={() => patch({ video_ids: moveItem(d.video_ids, i, i + 1) })}
                disabled={i === d.video_ids.length - 1}
                aria-label={`Move ${titleOf(vid)} down`}
                data-hv-path-down={vid}
              >
                <ArrowDown className='h-3.5 w-3.5' />
              </button>
              <button
                type='button'
                className={`rounded p-0.5 text-muted-foreground hover:text-foreground ${focusRing}`}
                onClick={() => patch({ video_ids: d.video_ids.filter((x) => x !== vid) })}
                aria-label={`Remove ${titleOf(vid)}`}
                data-hv-path-remove={vid}
              >
                <X className='h-3.5 w-3.5' />
              </button>
            </li>
          ))}
        </ol>
        <div className='flex flex-wrap items-center gap-2'>
          <PickerCombo
            ariaLabel='Add a video'
            placeholder='Add a video'
            emptyText={
              library.isLoading
                ? 'Loading…'
                : library.isError
                  ? 'Videos could not be loaded.'
                  : 'Nothing matches.'
            }
            options={(library.data?.data ?? [])
              .filter((v) => !d.video_ids.some((x) => x.toLowerCase() === v.id.toLowerCase()))
              .map((v) => ({
                value: v.id,
                label: v.title || 'Untitled video',
                hint: formatDuration(v.duration_ms)
              }))}
            onPick={(v) => patch({ video_ids: [...d.video_ids, v] })}
          />
          {library.hasNextPage && (
            <Button
              size='sm'
              variant='ghost'
              onClick={() => void library.fetchNextPage()}
              disabled={library.isFetchingNextPage}
            >
              {library.isFetchingNextPage ? 'Loading…' : 'More videos'}
            </Button>
          )}
        </div>
      </div>

      <div className='space-y-1.5'>
        <p className='text-[12px] font-medium'>Roles</p>
        <p className='text-[12px] text-muted-foreground'>
          People in these roles get the path on My Work. Required: it joins their required list and
          they are told when it is published.
        </p>
        <div className='flex flex-wrap items-center gap-1.5' data-hv-path-roles>
          {d.roles.map((r) => (
            <span key={r.role_id} className='inline-flex items-center gap-1'>
              <RemovableChip
                removeLabel={`Remove ${roleName(r.role_id)}`}
                onRemove={() => patch({ roles: d.roles.filter((x) => x.role_id !== r.role_id) })}
                data-hv-path-role={r.role_id}
              >
                {roleName(r.role_id)}
                <label className='ml-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground'>
                  <input
                    type='checkbox'
                    checked={r.required}
                    onChange={(e) =>
                      patch({
                        roles: d.roles.map((x) =>
                          x.role_id === r.role_id ? { ...x, required: e.target.checked } : x
                        )
                      })
                    }
                    data-hv-path-role-required={r.role_id}
                  />
                  required
                </label>
              </RemovableChip>
            </span>
          ))}
          <PickerCombo
            ariaLabel='Add a role'
            placeholder='Add a role'
            emptyText={
              roles.isLoading
                ? 'Loading…'
                : roles.isError
                  ? 'Roles could not be loaded.'
                  : 'Nothing matches.'
            }
            options={(roles.data ?? [])
              .filter((r) => !d.roles.some((x) => x.role_id.toUpperCase() === r.id.toUpperCase()))
              .map((r) => ({ value: r.id, label: r.name }))}
            onPick={(v) => patch({ roles: [...d.roles, { role_id: v, required: false }] })}
          />
        </div>
      </div>

      {problem && (
        <p
          role='alert'
          className='text-[12px] text-rose-700 dark:text-rose-300'
          data-hv-path-problem
        >
          {problem}
        </p>
      )}
      <div className='flex flex-wrap items-center gap-2'>
        <Button size='sm' onClick={() => void save()} disabled={busy} data-hv-path-save>
          {busy ? 'Saving…' : path ? 'Save' : 'Create path'}
        </Button>
        <Button size='sm' variant='outline' onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {path && (
          <Button
            size='sm'
            variant='ghost'
            className='ml-auto text-rose-700 hover:text-rose-800 dark:text-rose-300'
            onClick={() => void remove()}
            disabled={busy}
            data-hv-path-delete
          >
            <Trash2 className='h-3.5 w-3.5' /> Delete path
          </Button>
        )}
      </div>
    </section>
  )
}
