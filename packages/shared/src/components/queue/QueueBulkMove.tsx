import { useQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { userErrorMessage } from '../../lib/safe-error'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SimpleSelect } from '../ui/SimpleSelect'

type Transition = {
  id: string
  label: string
  comment_mode?: string | null
  to_state?: string | null
}
type State = { id: string; key?: string; label: string; sort?: number | null }

export interface BulkMoveGroup {
  label: string
  ids: string[]
  noteRequired: boolean
  targets: Map<string, string[]>
}

/** One choice per transition LABEL ("Send Back" is one transition per from-state, so a bulk run
 *  over records in different steps needs all of them); `targets` = the steps it can lead to. */
export function groupTransitions(transitions: Transition[]): BulkMoveGroup[] {
  const byLabel = new Map<string, BulkMoveGroup>()
  for (const t of transitions) {
    const label = t.label?.trim() || 'Move'
    const g: BulkMoveGroup = byLabel.get(label) ?? {
      label,
      ids: [],
      noteRequired: false,
      targets: new Map<string, string[]>()
    }
    g.ids.push(t.id)
    if (t.comment_mode === 'required') g.noteRequired = true
    const to = String(t.to_state ?? '')
    g.targets.set(to, [...(g.targets.get(to) ?? []), t.id])
    byLabel.set(label, g)
  }
  return [...byLabel.values()]
}

/**
 * Queue bulk Move / Send Back — the list bar's flow (pick the move, pick the step it goes to,
 * one note for every record, a dry run that says who can't move and why) for a queue selection.
 * The queue's own "Transition" only offered steps the selected items were already in, so Send
 * Back (to Started, Level 1, …) was never reachable from a queue (2026-11-09).
 * Runs through POST /items/:collection/bulk-transition with transition_ids.
 */
export function QueueBulkMove({
  collection,
  ids,
  disabled,
  onDone
}: {
  /** null when the selection mixes kinds of record — the button explains instead. */
  collection: string | null
  ids: Array<string | number>
  disabled?: boolean
  onDone: () => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [target, setTarget] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const firstIds = ids.slice(0, 50).map(String).join(',')
  const { data: templateId } = useQuery({
    queryKey: ['queue-bulk-move-binding', collection],
    queryFn: () =>
      client
        .request<{ data: { binding?: { template?: string } | null } }>(
          get(`/pipelines/instances/${collection}`, { ids: firstIds })
        )
        .then((r) => r.data?.binding?.template ?? null),
    enabled: open && !!collection && ids.length > 0,
    staleTime: 5 * 60_000,
    retry: false
  })
  const { data: outline } = useQuery({
    queryKey: ['queue-bulk-move-outline', templateId],
    queryFn: () =>
      client
        .request<{ data: { transitions: Transition[]; states?: State[] } }>(
          get(`/pipelines/${templateId}/outline`)
        )
        .then((r) => r.data),
    enabled: open && !!templateId,
    staleTime: 5 * 60_000,
    retry: false
  })
  const groups = useMemo(() => groupTransitions(outline?.transitions ?? []), [outline])
  const states = outline?.states ?? []
  const stateOf = (id: string) =>
    states.find((s) => String(s.id).toUpperCase() === id.toUpperCase())
  const group = groups.find((g) => g.label === label) ?? null
  const targetOptions = group
    ? [...group.targets.keys()]
        .filter(Boolean)
        .sort((a, b) => Number(stateOf(a)?.sort ?? 0) - Number(stateOf(b)?.sort ?? 0))
    : []
  const needsTarget = targetOptions.length > 1
  const chosenIds = !group
    ? []
    : !needsTarget
      ? group.ids
      : target
        ? (group.targets.get(target) ?? [])
        : []

  const previewKey = chosenIds.length ? `${chosenIds.join(',')}|${ids.join(',')}` : ''
  const { data: preview, isFetching: previewing } = useQuery({
    queryKey: ['bulk-transition-preview', collection, previewKey],
    queryFn: () =>
      client.request<{
        succeeded: number
        failed: number
        errors: Array<{ item: string; error: string; label?: string }>
      }>(
        post(`/items/${collection}/bulk-transition?dry_run=1`, {
          ids,
          transition_ids: chosenIds,
          comment: '(preview)'
        })
      ),
    enabled: open && !!collection && chosenIds.length > 0,
    staleTime: 15_000,
    retry: false
  })

  const runMove = async () => {
    if (!collection || !group || chosenIds.length === 0) return
    if (group.noteRequired && !note.trim()) return
    setBusy(true)
    try {
      const res = await client.request<{
        succeeded: number
        failed: number
        errors?: Array<{ item: string; error: string; label?: string }>
      }>(
        post(`/items/${collection}/bulk-transition`, {
          ids,
          transition_ids: chosenIds,
          ...(note.trim() ? { comment: note.trim() } : {})
        })
      )
      if (res.failed > 0)
        toast.warning(
          `${group.label}: ${res.succeeded} done, ${res.failed} not moved — ${(res.errors ?? [])
            .slice(0, 3)
            .map((e) => `${e.label ?? `#${e.item}`}: ${e.error}`)
            .join('; ')}`
        )
      else toast.success(`${group.label}: ${res.succeeded} done`)
      setOpen(false)
      setLabel('')
      setTarget('')
      setNote('')
      onDone()
    } catch (err) {
      toast.error(userErrorMessage(err, `Could not ${group.label.toLowerCase()}`))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={disabled || !collection}
          data-tip={collection ? undefined : 'Select records of one kind to move them together'}
          data-queue-bulk-move
          className='flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-muted'
        >
          Move / Send Back <ArrowRight className='h-3 w-3' />
        </button>
      </PopoverTrigger>
      <PopoverContent side='top' align='center' className='w-[360px] space-y-2 p-3'>
        <p className='text-[12px] font-semibold text-slate-700 dark:text-foreground'>
          Move {ids.length} record{ids.length === 1 ? '' : 's'}
        </p>
        {!outline ? (
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            Loading the moves…
          </p>
        ) : groups.length === 0 ? (
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            You can’t move these records from here.
          </p>
        ) : (
          <form
            className='space-y-2'
            onSubmit={(e) => {
              e.preventDefault()
              void runMove()
            }}
          >
            <SimpleSelect
              value={label}
              onChange={(v) => {
                setLabel(v)
                setTarget('')
              }}
              options={[
                { value: '', label: 'Choose a move…' },
                ...groups.map((g) => ({ value: g.label, label: g.label }))
              ]}
              ariaLabel='Choose a move'
              className='h-8 w-full text-[12.5px]'
            />
            {group && needsTarget && (
              <SimpleSelect
                value={target}
                onChange={setTarget}
                options={[
                  { value: '', label: `${group.label} to…` },
                  ...targetOptions.map((id) => ({
                    value: id,
                    label: stateOf(id)?.label ?? 'another step'
                  }))
                ]}
                ariaLabel={`${group.label} to which step`}
                className='h-8 w-full text-[12.5px]'
              />
            )}
            {group && (
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={
                  group.noteRequired
                    ? 'Note for every record (required)'
                    : 'Note for every record (optional)'
                }
                aria-label='Note for every selected record'
                maxLength={2000}
                rows={2}
                className='w-full rounded-md border border-slate-200 bg-background px-2 py-1 text-[12.5px] outline-none focus:border-nvr-cyan dark:border-border'
              />
            )}
            {chosenIds.length > 0 && (
              <p
                role='status'
                className='text-[12px] text-slate-600 dark:text-muted-foreground'
                data-bulk-transition-preview
              >
                {previewing || !preview ? (
                  'Checking the selected records…'
                ) : preview.failed === 0 ? (
                  `All ${preview.succeeded} can move.`
                ) : (
                  <>
                    <span className='font-medium text-amber-700 dark:text-amber-400'>
                      {preview.succeeded} of {preview.succeeded + preview.failed} can move.{' '}
                      {preview.failed} can’t:
                    </span>{' '}
                    {preview.errors
                      .slice(0, 4)
                      .map((e) => `${e.label ?? `#${e.item}`} — ${e.error}`)
                      .join('; ')}
                    {preview.errors.length > 4 ? `; and ${preview.errors.length - 4} more` : ''}
                  </>
                )}
              </p>
            )}
            <div className='flex justify-end gap-2'>
              <button
                type='button'
                onClick={() => setOpen(false)}
                className='h-8 px-2 text-[12.5px] text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
              >
                Cancel
              </button>
              <button
                type='submit'
                disabled={
                  busy ||
                  !group ||
                  chosenIds.length === 0 ||
                  (preview != null && preview.succeeded === 0) ||
                  (group.noteRequired && !note.trim())
                }
                className='h-8 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold text-white disabled:opacity-50'
              >
                {busy ? 'Moving…' : preview && !previewing ? `Run (${preview.succeeded})` : 'Run'}
              </button>
            </div>
          </form>
        )}
      </PopoverContent>
    </Popover>
  )
}
