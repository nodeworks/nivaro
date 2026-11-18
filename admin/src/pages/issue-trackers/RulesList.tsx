import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ErrorNotice, toastError } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, GripVertical, Plus, Workflow } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'
import {
  fetchRules,
  type Role,
  type RuleDraft,
  type TrackerConnection,
  type TrackerRule,
  trackerKeys
} from './api'
import { RuleBuilder } from './RuleBuilder'
import {
  APPLIES_TO_LABELS,
  appliesToChoices,
  draftOf,
  moveRule,
  newRule,
  ruleSentence
} from './rule-sentence'
import { SettingsCard } from './SyncCards'

type Editing = { kind: 'new'; draft: RuleDraft } | { kind: 'rule'; id: number } | null

function ModeChip({ mode }: { mode: string }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-px text-[10.5px] font-medium',
        mode === 'create'
          ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
          : 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-slate-300'
      )}
    >
      {mode === 'create' ? 'Create' : 'Suggest'}
    </span>
  )
}

function RuleRow({
  rule,
  connectionName,
  projectPath,
  selected,
  onOpen,
  onToggle,
  toggling
}: {
  rule: TrackerRule
  connectionName: string | null
  projectPath: string | null
  selected: boolean
  onOpen: () => void
  onToggle: (on: boolean) => void
  toggling: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: rule.id
  })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex items-start gap-2 border-b border-slate-100 px-2 py-2.5 last:border-b-0 dark:border-border',
        selected ? 'bg-nvr-cyan/5' : 'bg-white dark:bg-card',
        isDragging && 'relative z-10 opacity-80 shadow-md'
      )}
    >
      <button
        type='button'
        aria-label={`Move ${rule.name}`}
        {...attributes}
        {...listeners}
        className='mt-0.5 cursor-grab touch-none rounded p-0.5 text-slate-300 transition-colors hover:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-slate-600 dark:hover:text-slate-400'
      >
        <GripVertical className='h-3.5 w-3.5' />
      </button>
      <Switch
        checked={rule.enabled}
        disabled={toggling || (!rule.valid && !rule.enabled)}
        aria-label={`${rule.enabled ? 'Turn off' : 'Turn on'} ${rule.name}`}
        onCheckedChange={onToggle}
        className='mt-0.5'
      />
      <div className='min-w-0 flex-1'>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
          <button
            type='button'
            onClick={onOpen}
            aria-expanded={selected}
            className='min-w-0 truncate text-left text-[12.5px] font-semibold text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-foreground'
          >
            {rule.name}
          </button>
          <ModeChip mode={rule.mode} />
          {rule.applies_to === 'ticket' && (
            <span className='rounded bg-violet-50 px-1.5 py-px text-[10.5px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'>
              {APPLIES_TO_LABELS.ticket}
            </span>
          )}
          {connectionName && (
            <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
              {connectionName}
            </span>
          )}
        </div>
        <p className='mt-0.5 line-clamp-2 text-[11.5px] text-slate-600 dark:text-slate-300'>
          {ruleSentence(rule, { projectPath })}
        </p>
        <p className='mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
          <span>
            {rule.last_fired_at
              ? `Last fired ${formatRelative(rule.last_fired_at)}`
              : 'Never fired'}
          </span>
          <span className='tabular-nums'>
            {rule.fired_count} fired · {rule.suppressed_count} held back
          </span>
        </p>
        {!rule.valid ? (
          <p className='mt-1 inline-flex items-start gap-1.5 text-[11.5px] text-red-700 dark:text-red-400'>
            <CircleAlert className='mt-px h-3.5 w-3.5 shrink-0' aria-hidden />
            This rule no longer checks out and does not run.{' '}
            {rule.errors?.[0]?.message ?? 'Open it to fix it.'}
          </p>
        ) : (
          rule.paused_reason && (
            <p className='mt-1 inline-flex items-start gap-1.5 text-[11.5px] text-amber-800 dark:text-amber-300'>
              <CircleAlert className='mt-px h-3.5 w-3.5 shrink-0' aria-hidden />
              Paused: {rule.paused_reason}
            </p>
          )
        )}
      </div>
    </li>
  )
}

/**
 * The rules: checked top to bottom (drag to reorder), each switched on or off
 * here, opened into the builder below the list.
 */
export function RulesSection({
  connections,
  current,
  roles
}: {
  connections: TrackerConnection[]
  /** The connection the page shows: new rules start on it. */
  current: TrackerConnection
  roles: Role[]
}) {
  const qc = useQueryClient()
  const rules = useQuery({ queryKey: trackerKeys.rules(), queryFn: fetchRules })
  const [order, setOrder] = useState<number[]>([])
  const [editing, setEditing] = useState<Editing>(null)
  useEffect(() => setOrder((rules.data ?? []).map((r) => r.id)), [rules.data])
  const byId = useMemo(() => new Map((rules.data ?? []).map((r) => [r.id, r])), [rules.data])
  const list = order.map((id) => byId.get(id)).filter((r): r is TrackerRule => !!r)
  const connById = useMemo(() => new Map(connections.map((c) => [c.id, c])), [connections])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const reorder = useMutation({
    mutationFn: (ids: number[]) =>
      api
        .post<{ data: TrackerRule[] }>('/trackers/rules/reorder', { ids })
        .then((r) => r.data.data),
    onSuccess: (next) => qc.setQueryData(trackerKeys.rules(), next),
    onError: (err) => {
      setOrder((rules.data ?? []).map((r) => r.id))
      toastError(err, 'Could not change the order')
    }
  })

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      api
        .patch<{ data: TrackerRule }>(`/trackers/rules/${id}`, { enabled })
        .then((r) => r.data.data),
    onSuccess: (next) => {
      qc.setQueryData<TrackerRule[]>(trackerKeys.rules(), (prev) =>
        prev?.map((r) => (r.id === next.id ? next : r))
      )
      toast.success(next.enabled ? `${next.name} is on` : `${next.name} is off`)
    },
    onError: (err) => toastError(err, 'Could not switch the rule')
  })

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over) return
    const next = moveRule(order, Number(e.active.id), Number(e.over.id))
    if (!next) return
    setOrder(next)
    reorder.mutate(next)
  }

  const kinds = appliesToChoices(current.sync.sources)
  const startNew = () =>
    setEditing({ kind: 'new', draft: newRule(current.id, kinds[0] ?? 'issue') })

  const editingRule = editing?.kind === 'rule' ? (byId.get(editing.id) ?? null) : null
  const projectPathOf = (r: TrackerRule) => {
    const c = connById.get(r.connection)
    return r.action.project_id && r.action.project_id !== c?.default_project_id
      ? null
      : (c?.default_project_path ?? null)
  }

  return (
    <div className='space-y-4'>
      <SettingsCard
        title='Rules'
        hint='Rules open or suggest GitLab issues on their own. They are checked top to bottom; drag to change the order.'
      >
        <div className='-mt-1 flex justify-end'>
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='h-8 gap-1.5 text-[12px]'
            disabled={editing?.kind === 'new' || kinds.length === 0}
            onClick={startNew}
          >
            <Plus className='h-3.5 w-3.5' />
            New rule
          </Button>
        </div>
        {rules.isLoading ? (
          <div className='space-y-2'>
            <Skeleton className='h-14' />
            <Skeleton className='h-14' />
          </div>
        ) : rules.isError ? (
          <ErrorNotice error={rules.error} what='the rules' onRetry={() => void rules.refetch()} />
        ) : list.length === 0 ? (
          <div className='flex flex-col items-start gap-1.5 rounded-md border border-dashed border-slate-300 px-4 py-5 dark:border-border'>
            <Workflow className='h-5 w-5 text-slate-400' aria-hidden />
            <p className='text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
              No rules yet
            </p>
            <p className='max-w-[62ch] text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              Without rules nothing goes to GitLab unless someone sends it. A new rule starts off
              and only suggests, so you can watch the preview before it opens anything.
            </p>
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={order} strategy={verticalListSortingStrategy}>
              <ol
                aria-label='Rules, in the order they are checked'
                className='overflow-hidden rounded-md border border-slate-200 dark:border-border'
              >
                {list.map((r) => (
                  <RuleRow
                    key={r.id}
                    rule={r}
                    connectionName={
                      connections.length > 1 ? (connById.get(r.connection)?.name ?? null) : null
                    }
                    projectPath={projectPathOf(r)}
                    selected={editing?.kind === 'rule' && editing.id === r.id}
                    onOpen={() =>
                      setEditing((e) =>
                        e?.kind === 'rule' && e.id === r.id ? null : { kind: 'rule', id: r.id }
                      )
                    }
                    toggling={toggle.isPending && toggle.variables?.id === r.id}
                    onToggle={(enabled) => toggle.mutate({ id: r.id, enabled })}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        )}
        {kinds.length === 0 && (
          <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            Switch on the issue log or support tickets under What syncs to add rules for this
            connection.
          </p>
        )}
      </SettingsCard>

      {editing?.kind === 'new' && (
        <RuleBuilder
          key='new'
          rule={null}
          initial={editing.draft}
          connections={connections}
          roles={roles}
          onDone={() => setEditing(null)}
        />
      )}
      {editingRule && (
        <RuleBuilder
          key={editingRule.id}
          rule={editingRule}
          initial={draftOf(editingRule)}
          connections={connections}
          roles={roles}
          onDone={() => setEditing(null)}
        />
      )}
    </div>
  )
}
