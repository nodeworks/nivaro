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
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronDown,
  Copy,
  GripVertical,
  Pencil,
  Plus,
  Route,
  Trash2,
  X
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post, put } from '../../lib/commands'
import { toastError } from '../../lib/error-toast'
import { useUnsavedWork } from '../../lib/unsaved-work'
import { cn } from '../../lib/utils'
import { ErrorNotice } from '../ErrorNotice'
import { RelationCombobox } from '../item-edit/RelationCombobox'
import { ConfirmButton } from '../profile/primitives'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SimpleSelect } from '../ui/SimpleSelect'
import { Switch } from '../ui/switch'
import {
  blankRule,
  clock12,
  hoursWords,
  type RuleNames,
  ruleSentence,
  SOURCE_LABELS,
  STRATEGY_OPTIONS
} from './assign-rules-text'
import { PersonDisc } from './PersonPick'
import type {
  AssignAction,
  AssignCondition,
  AssignField,
  AssignFieldOp,
  AssignHours,
  AssignOptions,
  AssignRule,
  AssignRuleSet,
  AssignSharePerson,
  AssignSource,
  AssignTestResult
} from './types'

interface Labels {
  people: Record<string, string>
  values: Record<string, string>
}

const INPUT =
  'h-8 rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-900 outline-none placeholder:text-slate-400 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-slate-100'
const SELECT =
  'h-8 w-auto min-w-[8rem] gap-1.5 rounded-md border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-800 dark:border-border dark:bg-background dark:text-slate-100'
const QUIET_BTN =
  'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10'
const PRIMARY_BTN =
  'inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-medium text-white hover:brightness-95 disabled:opacity-50'

const KIND_OPTIONS: Array<{ value: AssignCondition['kind']; label: string; description: string }> =
  [
    { value: 'type', label: 'Request type', description: 'The type the person picked.' },
    {
      value: 'about',
      label: 'What it is about',
      description: 'A record of some kind, or General Support.'
    },
    {
      value: 'field',
      label: 'A field on the record',
      description: 'Zone, Region, Project type… read when the request comes in.'
    },
    {
      value: 'step',
      label: 'The record’s step',
      description: 'Where the record is in its pipeline.'
    },
    { value: 'requester', label: 'Who raised it', description: 'Particular people.' },
    { value: 'requester_role', label: 'Requester’s role', description: 'Their role in Nivaro.' },
    { value: 'requester_team', label: 'Requester’s team', description: 'A team they belong to.' },
    { value: 'priority', label: 'Priority', description: 'Low, normal or urgent.' },
    {
      value: 'text',
      label: 'Words in the title or description',
      description: 'Any, all or none of some words.'
    },
    {
      value: 'source',
      label: 'Where it was raised',
      description: 'Get help, a record, an error, Report a problem.'
    },
    { value: 'hours', label: 'When it comes in', description: 'Inside or outside business hours.' }
  ]

const SET_OPS = [
  { value: 'in', label: 'is one of' },
  { value: 'not_in', label: 'is not one of' }
]

function newCondition(
  kind: AssignCondition['kind'],
  opts: AssignOptions | undefined
): AssignCondition {
  switch (kind) {
    case 'type':
      return { kind, op: 'in', values: [] }
    case 'about':
      return { kind, op: 'record_in', collections: [] }
    case 'field':
      return {
        kind,
        collection: opts?.collections[0]?.collection ?? '',
        field: '',
        op: 'in',
        values: []
      }
    case 'step':
      return { kind, op: 'in', states: [] }
    case 'requester':
      return { kind, op: 'in', users: [] }
    case 'requester_role':
      return { kind, op: 'in', roles: [] }
    case 'requester_team':
      return { kind, op: 'in', teams: [] }
    case 'priority':
      return { kind, op: 'in', values: ['urgent'] }
    case 'text':
      return { kind, op: 'any', words: [] }
    case 'source':
      return { kind, op: 'in', values: ['error'] }
    case 'hours':
      return { kind, op: 'outside' }
  }
}

/** A signature of everything that needs a name from the server (people, field values). */
function refsKey(rules: AssignRule[]): string {
  const parts: string[] = []
  for (const r of rules) {
    for (const c of r.conditions) {
      if (c.kind === 'requester') parts.push(...c.users)
      if (c.kind === 'field') parts.push(`${c.collection}.${c.field}:${c.values.join(',')}`)
    }
    if (r.action.kind === 'person') parts.push(r.action.user)
    if (r.action.kind === 'share') parts.push(...r.action.people.map((p) => p.id))
    if (r.fallback.kind === 'person') parts.push(r.fallback.user)
  }
  return [...new Set(parts)].sort().join('|')
}

/**
 * Administrators: who new support requests go to. An ordered list of rules (drag to reorder;
 * the first that fits wins), each read as a sentence, edited inline. Nothing fits → the type's
 * default assignee, else the desk. "Try a request" asks the server which rule wins and why.
 */
export function AssignRulesView() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const stored = useQuery({
    queryKey: ['support-assign-rules'],
    queryFn: () =>
      client.request<{ data: AssignRuleSet; labels: Labels }>(get('/support/assign-rules'))
  })
  const { data: options } = useQuery({
    queryKey: ['support-assign-options'],
    queryFn: () =>
      client
        .request<{ data: AssignOptions }>(get('/support/assign-rules/options'))
        .then((r) => r.data)
  })
  const [draft, setDraft] = useState<AssignRuleSet | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [errors, setErrors] = useState<Array<{ rule: number; message: string }>>([])
  const [hoursOpen, setHoursOpen] = useState(false)
  useEffect(() => {
    if (stored.data && draft == null) setDraft(stored.data.data)
  }, [stored.data, draft])
  const dirty =
    !!draft && !!stored.data && JSON.stringify(draft) !== JSON.stringify(stored.data.data)
  useUnsavedWork(dirty, 'Support assignment rules')

  const refs = draft ? refsKey(draft.rules) : ''
  const { data: draftLabels } = useQuery({
    queryKey: ['support-assign-labels', refs],
    enabled: !!draft && dirty && !!refs,
    staleTime: 60_000,
    queryFn: () =>
      client
        .request<{ data: Labels }>(
          post('/support/assign-rules/labels', { rules: draft?.rules ?? [] })
        )
        .then((r) => r.data)
        .catch(() => null)
  })
  const labels: Labels = {
    people: { ...(stored.data?.labels.people ?? {}), ...(draftLabels?.people ?? {}) },
    values: { ...(stored.data?.labels.values ?? {}), ...(draftLabels?.values ?? {}) }
  }
  const names = useRuleNames(options, labels)

  const save = useMutation({
    mutationFn: (set: AssignRuleSet) =>
      client
        .request<{ data: AssignRuleSet }>(put('/support/assign-rules', set))
        .then((r) => r.data),
    onSuccess: (set) => {
      setErrors([])
      setDraft(set)
      setEditing(null)
      void qc.invalidateQueries({ queryKey: ['support-assign-rules'] })
      toast.success('Assignment rules saved')
    },
    onError: (err) => {
      const body = (err as { response?: { errors?: Array<{ rule: number; message: string }> } })
        .response
      if (body?.errors?.length) {
        setErrors(body.errors)
        const first = body.errors.find((e) => e.rule >= 0)
        if (first && draft) setEditing(draft.rules[first.rule]?.id ?? null)
      } else toastError(err, 'Could not save the rules')
    }
  })

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const onDragEnd = (e: DragEndEvent) => {
    if (!draft || !e.over || e.active.id === e.over.id) return
    const from = draft.rules.findIndex((r) => r.id === e.active.id)
    const to = draft.rules.findIndex((r) => r.id === e.over?.id)
    if (from < 0 || to < 0) return
    setDraft({ ...draft, rules: arrayMove(draft.rules, from, to) })
  }

  if (stored.isLoading || !draft)
    return stored.isError ? (
      <div className='mt-4'>
        <ErrorNotice
          error={stored.error}
          what='the assignment rules'
          onRetry={() => void stored.refetch()}
        />
      </div>
    ) : (
      <div className='mt-4 space-y-2' aria-busy>
        {[0, 1, 2].map((i) => (
          <div key={i} className='h-14 animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]' />
        ))}
      </div>
    )

  const setRule = (id: string, next: AssignRule) =>
    setDraft({ ...draft, rules: draft.rules.map((r) => (r.id === id ? next : r)) })
  const addRule = () => {
    const r = blankRule(draft.rules.length + 1)
    setDraft({ ...draft, rules: [...draft.rules, r] })
    setEditing(r.id)
  }
  const ruleErrors = (i: number) => errors.filter((e) => e.rule === i).map((e) => e.message)
  const setErrors0 = errors.filter((e) => e.rule < 0).map((e) => e.message)

  return (
    <div className='mt-4 space-y-4' data-support-assign-rules>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <p className='max-w-2xl text-[12.5px] text-slate-600 dark:text-muted-foreground'>
          When someone raises a request, the first rule that fits decides who gets it. If none fits,
          the request type’s default assignee takes it, else it waits on the desk. Drag rules to
          change their order.
        </p>
        <button
          type='button'
          onClick={() => setHoursOpen((o) => !o)}
          aria-expanded={hoursOpen}
          data-support-hours-toggle
          className='inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] text-slate-700 hover:border-slate-300 dark:border-border dark:bg-card dark:text-slate-200'
        >
          <span className='text-slate-500 dark:text-muted-foreground'>Business hours</span>
          {hoursWords(draft.hours)}
          <ChevronDown
            className={cn('h-3.5 w-3.5 opacity-60 transition-transform', hoursOpen && 'rotate-180')}
          />
        </button>
      </div>
      {hoursOpen && (
        <HoursEditor hours={draft.hours} onChange={(hours) => setDraft({ ...draft, hours })} />
      )}
      {setErrors0.length > 0 && <ErrorList messages={setErrors0} />}

      {draft.rules.length === 0 ? (
        <EmptyRules onAdd={addRule} />
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext
            items={draft.rules.map((r) => r.id)}
            strategy={verticalListSortingStrategy}
          >
            <ol className='space-y-2' data-support-rule-list>
              {draft.rules.map((r, i) => (
                <RuleCard
                  key={r.id}
                  index={i}
                  rule={r}
                  names={names}
                  options={options}
                  editing={editing === r.id}
                  errors={ruleErrors(i)}
                  onEdit={() => setEditing(editing === r.id ? null : r.id)}
                  onChange={(next) => setRule(r.id, next)}
                  onDuplicate={() => {
                    const copy = {
                      ...structuredClone(r),
                      id: blankRule(0).id,
                      name: `${r.name} (copy)`
                    }
                    const rules = [...draft.rules]
                    rules.splice(i + 1, 0, copy)
                    setDraft({ ...draft, rules })
                    setEditing(copy.id)
                  }}
                  onDelete={() => {
                    setDraft({ ...draft, rules: draft.rules.filter((x) => x.id !== r.id) })
                    if (editing === r.id) setEditing(null)
                  }}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
      {draft.rules.length > 0 && (
        <button
          type='button'
          onClick={addRule}
          className={cn(QUIET_BTN, 'border border-dashed border-slate-300 dark:border-slate-600')}
          data-support-add-rule
        >
          <Plus className='h-3.5 w-3.5' /> Add a rule
        </button>
      )}

      {dirty && (
        <div
          className='sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-[0_-2px_12px_rgba(15,23,42,0.08)] dark:border-border dark:bg-card dark:shadow-[0_-2px_12px_rgba(0,0,0,0.4)]'
          data-support-rules-savebar
        >
          <span className='text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
            Unsaved changes
          </span>
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            New requests keep using the saved rules until you save.
          </span>
          <span className='ml-auto flex items-center gap-1'>
            <button
              type='button'
              className={QUIET_BTN}
              onClick={() => {
                setDraft(stored.data?.data ?? draft)
                setErrors([])
                setEditing(null)
              }}
            >
              Discard
            </button>
            <button
              type='button'
              className={PRIMARY_BTN}
              disabled={save.isPending}
              onClick={() => save.mutate(draft)}
              data-support-rules-save
            >
              {save.isPending ? 'Saving…' : 'Save rules'}
            </button>
          </span>
        </div>
      )}

      <TryRequest draft={draft} options={options} dirty={dirty} />
    </div>
  )
}

function useRuleNames(options: AssignOptions | undefined, labels: Labels): RuleNames {
  const [fieldLabels] = useState(() => new Map<string, string>())
  return useMemo(() => {
    const types = new Map((options?.types ?? []).map((t) => [t.id, t.name]))
    const cols = new Map((options?.collections ?? []).map((c) => [c.collection, c.name]))
    const steps = new Map(
      Object.values(options?.steps ?? {})
        .flat()
        .map((s) => [s.id.toUpperCase(), s.label])
    )
    const roles = new Map((options?.roles ?? []).map((r) => [String(r.id).toUpperCase(), r.name]))
    const teams = new Map((options?.teams ?? []).map((t) => [t.id, t.name]))
    const pretty = (f: string) =>
      fieldLabels.get(f) ??
      f
        .replace(/_id$/, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (m) => m.toUpperCase())
    return {
      type: (id) => types.get(id) ?? `type #${id}`,
      collection: (c) => cols.get(c) ?? c,
      field: (_c, f) => pretty(f),
      value: (c, f, v) => labels.values[`${c}.${f}:${v}`] ?? v,
      step: (id) => steps.get(id.toUpperCase()) ?? 'a step',
      person: (id) => labels.people[id.toUpperCase()] ?? 'someone',
      role: (id) => roles.get(id.toUpperCase()) ?? 'a role',
      team: (id) => teams.get(id) ?? 'a team'
    }
  }, [options, labels.people, labels.values, fieldLabels])
}

function ErrorList({ messages }: { messages: string[] }) {
  return (
    <ul className='space-y-0.5 text-[12px] text-red-700 dark:text-red-300' role='alert'>
      {messages.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  )
}

function EmptyRules({ onAdd }: { onAdd: () => void }) {
  return (
    <div
      className='flex flex-col items-center gap-2 rounded-lg border border-slate-200 bg-white px-6 py-10 text-center dark:border-border dark:bg-card'
      data-support-rules-empty
    >
      <Route className='h-6 w-6 text-slate-300 dark:text-slate-600' />
      <p className='text-[13px] font-medium text-slate-800 dark:text-slate-100'>
        No assignment rules yet
      </p>
      <p className='max-w-md text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        Requests go to their type’s default assignee or wait on the desk. A rule can send them
        straight to the right person — for example, “When the type is Vendor change and the record’s
        Zone is East, share it among Beth and Sam — whoever has the fewest open requests.”
      </p>
      <button
        type='button'
        onClick={onAdd}
        className={cn(PRIMARY_BTN, 'mt-1')}
        data-support-add-rule
      >
        <Plus className='h-3.5 w-3.5' /> Add the first rule
      </button>
    </div>
  )
}

function RuleCard({
  index,
  rule,
  names,
  options,
  editing,
  errors,
  onEdit,
  onChange,
  onDuplicate,
  onDelete
}: {
  index: number
  rule: AssignRule
  names: RuleNames
  options: AssignOptions | undefined
  editing: boolean
  errors: string[]
  onEdit: () => void
  onChange: (r: AssignRule) => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: rule.id
  })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-support-rule={rule.id}
      className={cn(
        'rounded-lg border bg-white dark:bg-card',
        editing
          ? 'border-nvr-cyan/60 shadow-sm'
          : errors.length
            ? 'border-red-300 dark:border-red-500/50'
            : 'border-slate-200 dark:border-border',
        isDragging && 'relative z-10 shadow-lg'
      )}
    >
      {/* Name and controls on one line; the sentence below spans the card (on a phone too). */}
      <div className='grid grid-cols-[20px_24px_minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1 px-2 py-2.5 sm:px-3'>
        <button
          type='button'
          {...attributes}
          {...listeners}
          aria-label={`Move rule ${index + 1}`}
          data-tip='Drag to reorder'
          className='mt-0.5 flex h-6 w-5 shrink-0 cursor-grab items-center justify-center rounded text-slate-400 hover:bg-slate-100 active:cursor-grabbing dark:hover:bg-white/10'
        >
          <GripVertical className='h-4 w-4' />
        </button>
        <span className='mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold tabular-nums text-slate-600 dark:bg-white/10 dark:text-slate-300'>
          {index + 1}
        </span>
        <div className={cn('mt-0.5 min-w-0', !rule.active && 'opacity-60')}>
          <p className='text-[13px] font-medium text-slate-900 dark:text-slate-100'>
            {rule.name || 'Untitled rule'}
            {!rule.active && (
              <span className='ml-2 rounded bg-slate-100 px-1.5 py-px text-[10.5px] font-medium text-slate-500 dark:bg-white/10 dark:text-slate-400'>
                Off
              </span>
            )}
          </p>
        </div>
        <div className='flex shrink-0 items-center gap-0.5'>
          <Switch
            checked={rule.active}
            onCheckedChange={(v) => onChange({ ...rule, active: v })}
            aria-label={rule.active ? 'Rule is on' : 'Rule is off'}
            className='mr-1 scale-90'
          />
          <button
            type='button'
            onClick={onEdit}
            aria-expanded={editing}
            data-tip={editing ? 'Close the editor' : 'Edit'}
            aria-label={editing ? 'Close the editor' : 'Edit'}
            className='inline-flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-white/10 dark:hover:text-slate-100'
          >
            {editing ? <Check className='h-3.5 w-3.5' /> : <Pencil className='h-3.5 w-3.5' />}
          </button>
          <button
            type='button'
            onClick={onDuplicate}
            data-tip='Duplicate'
            aria-label='Duplicate'
            className='hidden h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800 sm:inline-flex dark:hover:bg-white/10 dark:hover:text-slate-100'
          >
            <Copy className='h-3.5 w-3.5' />
          </button>
          <ConfirmButton
            onConfirm={onDelete}
            title='Delete'
            confirmLabel='Delete?'
            className='inline-flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-[11.5px] text-slate-500 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-white/10'
            armedClassName='!bg-red-600 !text-white'
          >
            <Trash2 className='h-3.5 w-3.5' />
          </ConfirmButton>
        </div>
        <div
          className={cn(
            'col-span-4 max-w-[80ch] sm:col-span-2 sm:col-start-3',
            !rule.active && 'opacity-60'
          )}
        >
          <p
            className='text-[12.5px] leading-relaxed text-slate-600 dark:text-slate-300'
            data-support-rule-sentence
          >
            {ruleSentence(rule, names)}
          </p>
          {errors.length > 0 && !editing && <ErrorList messages={errors} />}
        </div>
      </div>
      {editing && (
        <RuleEditor
          rule={rule}
          options={options}
          errors={errors}
          onChange={onChange}
          onDuplicate={onDuplicate}
          onDone={onEdit}
        />
      )}
    </li>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className='space-y-2'>
      <div>
        <h4 className='text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>{title}</h4>
        {hint && <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function RuleEditor({
  rule,
  options,
  errors,
  onChange,
  onDuplicate,
  onDone
}: {
  rule: AssignRule
  options: AssignOptions | undefined
  errors: string[]
  onChange: (r: AssignRule) => void
  onDuplicate: () => void
  onDone: () => void
}) {
  const set = (patch: Partial<AssignRule>) => onChange({ ...rule, ...patch })
  const setCond = (i: number, c: AssignCondition) =>
    set({ conditions: rule.conditions.map((x, j) => (j === i ? c : x)) })
  return (
    <div
      className='space-y-5 border-t border-slate-100 px-3 pb-4 pt-4 sm:px-5 dark:border-border/60'
      data-support-rule-editor
    >
      {errors.length > 0 && <ErrorList messages={errors} />}
      <label className='block max-w-md'>
        <span className='mb-1 block text-[12px] font-medium text-slate-700 dark:text-slate-200'>
          Rule name
        </span>
        <input
          value={rule.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder='e.g. Vendor changes East'
          className={cn(INPUT, 'w-full')}
          data-support-rule-name
        />
        <span className='mt-1 block text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          Shown to the desk in the request’s history. Requesters only see who got it.
        </span>
      </label>

      <Section title='When'>
        <div className='flex flex-wrap items-center gap-2 text-[12.5px] text-slate-700 dark:text-slate-200'>
          A request matches when
          <SimpleSelect
            value={rule.match}
            onChange={(v) => set({ match: v as 'all' | 'any' })}
            options={[
              { value: 'all', label: 'all of these' },
              { value: 'any', label: 'any of these' }
            ]}
            ariaLabel='Match all or any'
            className={SELECT}
          />
          are true{rule.conditions.length === 0 ? ' — with none, every request matches.' : ':'}
        </div>
        <div className='space-y-2'>
          {rule.conditions.map((c, i) => (
            <ConditionRow
              // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no id; order is their identity
              key={i}
              cond={c}
              options={options}
              first={i === 0}
              match={rule.match}
              onChange={(next) => setCond(i, next)}
              onRemove={() => set({ conditions: rule.conditions.filter((_, j) => j !== i) })}
            />
          ))}
        </div>
        <AddCondition
          onAdd={(kind) => set({ conditions: [...rule.conditions, newCondition(kind, options)] })}
        />
      </Section>

      <Section title='Then'>
        <ActionEditor
          action={rule.action}
          options={options}
          onChange={(action) => set({ action })}
        />
      </Section>

      {rule.action.kind !== 'team' && (
        <Section
          title='If nobody on it can take it'
          hint='Everyone is out, at their cap, or the record has no step owner.'
        >
          <div className='flex flex-wrap items-center gap-2'>
            <SimpleSelect
              value={rule.fallback.kind}
              onChange={(v) =>
                set({ fallback: v === 'person' ? { kind: 'person', user: '' } : { kind: 'desk' } })
              }
              options={[
                { value: 'desk', label: 'Leave it on the desk' },
                { value: 'person', label: 'Give it to…' }
              ]}
              ariaLabel='If nobody can take it'
              className={SELECT}
            />
            {rule.fallback.kind === 'person' && (
              <div className='w-64'>
                <RelationCombobox
                  collection='nivaro_users'
                  value={rule.fallback.user || null}
                  onChange={(v) =>
                    set({ fallback: { kind: 'person', user: v ? String(v).toUpperCase() : '' } })
                  }
                  placeholder='Pick a person'
                />
              </div>
            )}
          </div>
        </Section>
      )}

      <label className='flex max-w-xl items-start gap-2 text-[12.5px] text-slate-700 dark:text-slate-200'>
        <input
          type='checkbox'
          checked={rule.on_type_change}
          onChange={(e) => set({ on_type_change: e.target.checked })}
          className='mt-0.5 h-3.5 w-3.5 accent-nvr-navy dark:accent-nvr-cyan'
        />
        <span>
          Also when a request’s type changes
          <span className='block text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            Moves requests someone already has. Off: a type change only assigns requests nobody has.
          </span>
        </span>
      </label>

      <div className='flex items-center gap-2 pt-1'>
        <button type='button' onClick={onDone} className={PRIMARY_BTN}>
          Done
        </button>
        <button type='button' onClick={onDuplicate} className={cn(QUIET_BTN, 'sm:hidden')}>
          <Copy className='h-3.5 w-3.5' /> Duplicate
        </button>
        <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          Changes apply once you save the rules.
        </span>
      </div>
    </div>
  )
}

function AddCondition({ onAdd }: { onAdd: (k: AssignCondition['kind']) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type='button' className={QUIET_BTN} data-support-add-condition>
          <Plus className='h-3.5 w-3.5' /> Add a condition
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-72 p-0'>
        <Command>
          <CommandList className='max-h-80'>
            <CommandGroup>
              {KIND_OPTIONS.map((k) => (
                <CommandItem
                  key={k.value}
                  value={k.label}
                  onSelect={() => {
                    onAdd(k.value)
                    setOpen(false)
                  }}
                  className='flex-col items-start gap-0 py-1.5'
                >
                  <span className='text-[12.5px]'>{k.label}</span>
                  <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {k.description}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ConditionRow({
  cond,
  options,
  first,
  match,
  onChange,
  onRemove
}: {
  cond: AssignCondition
  options: AssignOptions | undefined
  first: boolean
  match: 'all' | 'any'
  onChange: (c: AssignCondition) => void
  onRemove: () => void
}) {
  const kindLabel = KIND_OPTIONS.find((k) => k.value === cond.kind)?.label ?? cond.kind
  return (
    <div
      className='flex flex-wrap items-start gap-2 rounded-md bg-slate-50 px-2.5 py-2 dark:bg-white/[0.03]'
      data-support-condition={cond.kind}
    >
      <span className='mt-1.5 w-9 shrink-0 text-right text-[11.5px] font-medium uppercase tracking-wide text-slate-400 max-sm:w-auto'>
        {first ? 'If' : match === 'all' ? 'and' : 'or'}
      </span>
      <span className='mt-1.5 shrink-0 text-[12.5px] font-medium text-slate-800 max-sm:flex-1 dark:text-slate-100'>
        {kindLabel}
      </span>
      <div className='flex min-w-0 flex-1 flex-wrap items-center gap-2 max-sm:order-last max-sm:basis-full'>
        <ConditionBody cond={cond} options={options} onChange={onChange} />
      </div>
      <button
        type='button'
        onClick={onRemove}
        aria-label='Remove this condition'
        data-tip='Remove'
        className='mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-200/60 hover:text-slate-700 dark:hover:bg-white/10 dark:hover:text-slate-100'
      >
        <X className='h-3.5 w-3.5' />
      </button>
    </div>
  )
}

function ConditionBody({
  cond,
  options,
  onChange
}: {
  cond: AssignCondition
  options: AssignOptions | undefined
  onChange: (c: AssignCondition) => void
}) {
  const setOp = (
    <SimpleSelect
      value={'op' in cond ? cond.op : ''}
      onChange={(v) => onChange({ ...cond, op: v } as AssignCondition)}
      options={SET_OPS}
      ariaLabel='How to compare'
      className={SELECT}
    />
  )
  switch (cond.kind) {
    case 'type':
      return (
        <>
          {setOp}
          <MultiPick
            label='Pick types'
            values={cond.values.map(String)}
            choices={(options?.types ?? []).map((t) => ({ value: String(t.id), label: t.name }))}
            onChange={(v) => onChange({ ...cond, values: v.map(Number) })}
          />
        </>
      )
    case 'about':
      return (
        <>
          <SimpleSelect
            value={cond.op}
            onChange={(v) =>
              onChange({ ...cond, op: v as 'record_in' | 'general', collections: [] })
            }
            options={[
              { value: 'record_in', label: 'is a record in' },
              { value: 'general', label: 'is General Support' }
            ]}
            ariaLabel='What it is about'
            className={SELECT}
          />
          {cond.op === 'record_in' && (
            <MultiPick
              label='Any kind of record'
              values={cond.collections}
              choices={(options?.collections ?? []).map((c) => ({
                value: c.collection,
                label: c.name
              }))}
              onChange={(v) => onChange({ ...cond, collections: v })}
            />
          )}
        </>
      )
    case 'field':
      return <FieldConditionBody cond={cond} options={options} onChange={onChange} />
    case 'step': {
      const groups = Object.entries(options?.steps ?? {}).map(([col, steps]) => ({
        heading: options?.collections.find((c) => c.collection === col)?.name ?? col,
        choices: steps.map((s) => ({ value: s.id, label: s.label }))
      }))
      return (
        <>
          {setOp}
          <MultiPick
            label='Pick steps'
            values={cond.states}
            groups={groups}
            onChange={(v) => onChange({ ...cond, states: v })}
          />
        </>
      )
    }
    case 'requester':
      return (
        <>
          {setOp}
          <PeopleChips users={cond.users} onChange={(users) => onChange({ ...cond, users })} />
        </>
      )
    case 'requester_role':
      return (
        <>
          {setOp}
          <MultiPick
            label='Pick roles'
            values={cond.roles}
            choices={(options?.roles ?? []).map((r) => ({ value: String(r.id), label: r.name }))}
            onChange={(v) => onChange({ ...cond, roles: v })}
          />
        </>
      )
    case 'requester_team':
      return (
        <>
          <SimpleSelect
            value={cond.op}
            onChange={(v) => onChange({ ...cond, op: v as 'in' | 'not_in' })}
            options={[
              { value: 'in', label: 'is in' },
              { value: 'not_in', label: 'is not in' }
            ]}
            ariaLabel='How to compare'
            className={SELECT}
          />
          <MultiPick
            label='Pick teams'
            values={cond.teams.map(String)}
            choices={(options?.teams ?? []).map((t) => ({ value: String(t.id), label: t.name }))}
            onChange={(v) => onChange({ ...cond, teams: v.map(Number) })}
          />
        </>
      )
    case 'priority':
      return (
        <>
          {setOp}
          <MultiPick
            label='Pick priorities'
            values={cond.values}
            choices={[
              { value: 'urgent', label: 'Urgent' },
              { value: 'normal', label: 'Normal' },
              { value: 'low', label: 'Low' }
            ]}
            onChange={(v) => onChange({ ...cond, values: v })}
          />
        </>
      )
    case 'text':
      return (
        <>
          <SimpleSelect
            value={cond.op}
            onChange={(v) => onChange({ ...cond, op: v as 'any' | 'all' | 'none' })}
            options={[
              { value: 'any', label: 'mentions any of' },
              { value: 'all', label: 'mentions all of' },
              { value: 'none', label: 'mentions none of' }
            ]}
            ariaLabel='How to compare'
            className={SELECT}
          />
          <WordsInput words={cond.words} onChange={(words) => onChange({ ...cond, words })} />
        </>
      )
    case 'source':
      return (
        <>
          {setOp}
          <MultiPick
            label='Pick places'
            values={cond.values}
            choices={(Object.keys(SOURCE_LABELS) as AssignSource[]).map((s) => ({
              value: s,
              label: SOURCE_LABELS[s].replace(/^./, (m) => m.toUpperCase())
            }))}
            onChange={(v) => onChange({ ...cond, values: v as AssignSource[] })}
          />
        </>
      )
    case 'hours':
      return (
        <SimpleSelect
          value={cond.op}
          onChange={(v) => onChange({ ...cond, op: v as 'inside' | 'outside' })}
          options={[
            { value: 'inside', label: 'is during business hours' },
            { value: 'outside', label: 'is outside business hours' }
          ]}
          ariaLabel='When it comes in'
          className={SELECT}
        />
      )
  }
}

const NUMERIC = /^(integer|biginteger|float|decimal|date|datetime|timestamp|time)$/i

function opsFor(f: AssignField | undefined): Array<{ value: AssignFieldOp; label: string }> {
  const empty = [
    { value: 'empty' as const, label: 'is empty' },
    { value: 'not_empty' as const, label: 'is filled in' }
  ]
  if (!f) return [{ value: 'in', label: 'is one of' }]
  if (f.related || f.choices)
    return [
      { value: 'in', label: 'is one of' },
      { value: 'not_in', label: 'is not one of' },
      ...empty
    ]
  if (NUMERIC.test(f.type))
    return [
      { value: 'is', label: 'is' },
      { value: 'is_not', label: 'is not' },
      { value: 'gt', label: 'is more than' },
      { value: 'gte', label: 'is at least' },
      { value: 'lt', label: 'is less than' },
      { value: 'lte', label: 'is at most' },
      ...empty
    ]
  if (/^bool/i.test(f.type)) return [{ value: 'is', label: 'is' }, ...empty]
  return [
    { value: 'in', label: 'is one of' },
    { value: 'not_in', label: 'is not one of' },
    { value: 'contains', label: 'contains' },
    { value: 'not_contains', label: 'does not contain' },
    ...empty
  ]
}

function FieldConditionBody({
  cond,
  options,
  onChange
}: {
  cond: Extract<AssignCondition, { kind: 'field' }>
  options: AssignOptions | undefined
  onChange: (c: AssignCondition) => void
}) {
  const client = useNivaroClient()
  const { data: fields = [] } = useQuery({
    queryKey: ['support-assign-fields', cond.collection],
    enabled: !!cond.collection,
    staleTime: 5 * 60_000,
    queryFn: () =>
      client
        .request<{ data: AssignField[] }>(
          get('/support/assign-rules/fields', { collection: cond.collection })
        )
        .then((r) => r.data ?? [])
  })
  const f = fields.find((x) => x.field === cond.field)
  const ops = opsFor(f)
  const noValue = cond.op === 'empty' || cond.op === 'not_empty'
  const single = ['gt', 'gte', 'lt', 'lte', 'is', 'is_not'].includes(cond.op)
  return (
    <>
      <SimpleSelect
        value={cond.collection}
        onChange={(v) => onChange({ ...cond, collection: v, field: '', values: [] })}
        options={(options?.collections ?? []).map((c) => ({ value: c.collection, label: c.name }))}
        ariaLabel='Kind of record'
        className={SELECT}
      />
      <SimpleSelect
        value={cond.field}
        onChange={(v) => {
          const nf = fields.find((x) => x.field === v)
          onChange({ ...cond, field: v, op: opsFor(nf)[0].value, values: [] })
        }}
        options={[
          { value: '', label: 'Pick a field' },
          ...fields.map((x) => ({ value: x.field, label: x.label }))
        ]}
        ariaLabel='Field'
        className={SELECT}
      />
      {cond.field && (
        <SimpleSelect
          value={cond.op}
          onChange={(v) =>
            onChange({
              ...cond,
              op: v as AssignFieldOp,
              values: v === 'empty' || v === 'not_empty' ? [] : cond.values
            })
          }
          options={ops}
          ariaLabel='How to compare'
          className={SELECT}
        />
      )}
      {cond.field && !noValue && f?.related ? (
        <RelatedValues
          collection={f.related}
          values={cond.values}
          onChange={(values) => onChange({ ...cond, values })}
        />
      ) : cond.field && !noValue && f?.choices ? (
        <MultiPick
          label='Pick values'
          values={cond.values}
          choices={f.choices}
          onChange={(values) => onChange({ ...cond, values })}
        />
      ) : cond.field && !noValue && /^bool/i.test(f?.type ?? '') ? (
        <SimpleSelect
          value={cond.values[0] ?? 'true'}
          onChange={(v) => onChange({ ...cond, values: [v] })}
          options={[
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' }
          ]}
          ariaLabel='Value'
          className={SELECT}
        />
      ) : cond.field && !noValue && single ? (
        <input
          value={cond.values[0] ?? ''}
          onChange={(e) => onChange({ ...cond, values: e.target.value ? [e.target.value] : [] })}
          placeholder={/date|time/i.test(f?.type ?? '') ? 'YYYY-MM-DD' : 'Value'}
          aria-label='Value'
          className={cn(INPUT, 'w-36')}
        />
      ) : cond.field && !noValue ? (
        <WordsInput
          words={cond.values}
          onChange={(values) => onChange({ ...cond, values })}
          placeholder='Type a value, Enter'
        />
      ) : null}
      <p className='basis-full text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        Read from the record when the request comes in. Neither the requester nor the history ever
        shows the value through this rule.
      </p>
    </>
  )
}

/** One picker per chosen related record (each shows its own name) plus one to add another. */
function RelatedValues({
  collection,
  values,
  onChange
}: {
  collection: string
  values: string[]
  onChange: (v: string[]) => void
}) {
  return (
    <div className='flex flex-wrap items-center gap-1.5'>
      {values.map((v, i) => (
        <div key={v} className='flex items-center gap-0.5'>
          <div className='w-48'>
            <RelationCombobox
              collection={collection}
              value={v}
              onChange={(nv) => {
                const next = [...values]
                if (nv == null || nv === '') next.splice(i, 1)
                else next[i] = String(nv)
                onChange([...new Set(next)])
              }}
            />
          </div>
          <button
            type='button'
            aria-label='Remove this value'
            onClick={() => onChange(values.filter((x) => x !== v))}
            className='inline-flex h-7 w-6 items-center justify-center rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-100'
          >
            <X className='h-3 w-3' />
          </button>
        </div>
      ))}
      <div className='w-48'>
        <RelationCombobox
          key={values.length}
          collection={collection}
          value={null}
          onChange={(nv) =>
            nv != null && nv !== '' && onChange([...new Set([...values, String(nv)])])
          }
          placeholder={values.length ? 'Add another' : 'Pick a value'}
        />
      </div>
    </div>
  )
}

function MultiPick({
  label,
  values,
  choices,
  groups,
  onChange
}: {
  label: string
  values: string[]
  choices?: Array<{ value: string; label: string }>
  groups?: Array<{ heading: string; choices: Array<{ value: string; label: string }> }>
  onChange: (v: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const all = groups ? groups.flatMap((g) => g.choices) : (choices ?? [])
  const labelOf = (v: string) => all.find((c) => c.value === v)?.label ?? v
  const toggle = (v: string) =>
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v])
  const item = (c: { value: string; label: string }, prefix = '') => (
    <CommandItem
      key={`${prefix}${c.value}`}
      value={`${prefix}${c.label} ${c.value}`}
      onSelect={() => toggle(c.value)}
      className='gap-2 text-[12.5px]'
    >
      <span
        className={cn(
          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
          values.includes(c.value)
            ? 'border-nvr-navy bg-nvr-navy text-white dark:border-nvr-cyan dark:bg-nvr-cyan dark:text-[#0f172a]'
            : 'border-slate-400 dark:border-slate-500'
        )}
      >
        {values.includes(c.value) && <Check className='h-3 w-3' />}
      </span>
      <span className='truncate'>{c.label}</span>
    </CommandItem>
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='inline-flex min-h-8 max-w-full flex-wrap items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-left text-[12.5px] text-slate-800 hover:border-slate-300 dark:border-border dark:bg-background dark:text-slate-100'
        >
          {values.length ? (
            values.map((v) => (
              <span
                key={v}
                className='rounded bg-slate-100 px-1.5 py-px text-[12px] text-slate-700 dark:bg-white/10 dark:text-slate-200'
              >
                {labelOf(v)}
              </span>
            ))
          ) : (
            <span className='px-1 text-slate-400'>{label}</span>
          )}
          <ChevronDown className='ml-0.5 h-3.5 w-3.5 shrink-0 opacity-60' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-72 p-0'>
        <Command>
          <CommandInput placeholder='Search' className='h-9 text-[12.5px]' />
          <CommandList className='max-h-72'>
            <CommandEmpty className='py-4 text-center text-[12px] text-slate-500'>
              Nothing matches
            </CommandEmpty>
            {groups ? (
              groups.map((g) => (
                <CommandGroup key={g.heading} heading={g.heading}>
                  {g.choices.map((c) => item(c, `${g.heading} `))}
                </CommandGroup>
              ))
            ) : (
              <CommandGroup>{all.map((c) => item(c))}</CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function WordsInput({
  words,
  onChange,
  placeholder = 'Type a word, Enter'
}: {
  words: string[]
  onChange: (w: string[]) => void
  placeholder?: string
}) {
  const [text, setText] = useState('')
  const commit = () => {
    const parts = text
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    if (parts.length) onChange([...new Set([...words, ...parts])])
    setText('')
  }
  return (
    <div className='flex min-h-8 min-w-[14rem] flex-1 flex-wrap items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-1 focus-within:border-nvr-cyan dark:border-border dark:bg-background'>
      {words.map((w) => (
        <span
          key={w}
          className='inline-flex items-center gap-0.5 rounded bg-slate-100 py-px pl-1.5 pr-0.5 text-[12px] text-slate-700 dark:bg-white/10 dark:text-slate-200'
        >
          {w}
          <button
            type='button'
            aria-label={`Remove ${w}`}
            onClick={() => onChange(words.filter((x) => x !== w))}
            className='rounded p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-100'
          >
            <X className='h-3 w-3' />
          </button>
        </span>
      ))}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Backspace' && !text && words.length) onChange(words.slice(0, -1))
        }}
        onBlur={commit}
        placeholder={words.length ? '' : placeholder}
        aria-label='Words'
        className='min-w-[6rem] flex-1 bg-transparent px-1 text-[12.5px] text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100'
      />
    </div>
  )
}

/** Requester condition: chosen people as chips plus a picker to add one. */
function PeopleChips({ users, onChange }: { users: string[]; onChange: (u: string[]) => void }) {
  return (
    <div className='flex flex-wrap items-center gap-1.5'>
      {users.map((u) => (
        <span
          key={u}
          className='inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white py-0.5 pl-0.5 pr-1 text-[12px] dark:border-border dark:bg-card'
        >
          <PersonName id={u} />
          <button
            type='button'
            aria-label='Remove'
            onClick={() => onChange(users.filter((x) => x !== u))}
            className='rounded-full p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-100'
          >
            <X className='h-3 w-3' />
          </button>
        </span>
      ))}
      <div className='w-52'>
        <RelationCombobox
          key={users.length}
          collection='nivaro_users'
          value={null}
          onChange={(v) => v && onChange([...new Set([...users, String(v).toUpperCase()])])}
          placeholder='Add a person'
        />
      </div>
    </div>
  )
}

/** A person's disc + name, read from their (batched) card. */
function PersonName({ id }: { id: string }) {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['user-card', id],
    staleTime: 30 * 60_000,
    queryFn: () =>
      client
        .request<{ data: { first_name?: string; last_name?: string; email?: string } | null }>(
          get(`/users/${id}/card`)
        )
        .then((r) => r.data)
        .catch(() => null)
  })
  const name = data
    ? [data.first_name, data.last_name].filter(Boolean).join(' ') || data.email || 'Someone'
    : '…'
  return (
    <span className='inline-flex min-w-0 items-center gap-1.5'>
      <PersonDisc id={id} name={name} size={20} />
      <span className='truncate text-slate-800 dark:text-slate-100'>{name}</span>
    </span>
  )
}

function ActionEditor({
  action,
  options,
  onChange
}: {
  action: AssignAction
  options: AssignOptions | undefined
  onChange: (a: AssignAction) => void
}) {
  return (
    <div className='space-y-3'>
      <SimpleSelect
        value={action.kind}
        onChange={(k) =>
          onChange(
            k === 'person'
              ? { kind: 'person', user: '' }
              : k === 'share'
                ? { kind: 'share', people: [], strategy: 'fewest_open', give_to_cover: true }
                : k === 'step_owner'
                  ? { kind: 'step_owner', pick: 'fewest_open' }
                  : { kind: 'team', team: options?.teams[0]?.id ?? 0 }
          )
        }
        options={[
          {
            value: 'share',
            label: 'Share it among people',
            description: 'Pick one of several people by load, turns or experience.'
          },
          {
            value: 'person',
            label: 'Give it to one person',
            description: 'Their cover takes it while they are out.'
          },
          {
            value: 'step_owner',
            label: 'Give it to the record’s step owner',
            description: 'Whoever owns the record’s current pipeline step.'
          },
          {
            value: 'team',
            label: 'Send it to a team’s desk',
            description: 'Unassigned, for that team to pick up.'
          }
        ]}
        ariaLabel='What the rule does'
        className={cn(SELECT, 'min-w-[16rem]')}
        triggerProps={{ 'data-support-action': action.kind }}
      />
      {action.kind === 'person' && (
        <div className='w-72'>
          <RelationCombobox
            collection='nivaro_users'
            value={action.user || null}
            onChange={(v) => onChange({ kind: 'person', user: v ? String(v).toUpperCase() : '' })}
            placeholder='Pick a person'
          />
        </div>
      )}
      {action.kind === 'team' && (
        <SimpleSelect
          value={String(action.team || '')}
          onChange={(v) => onChange({ kind: 'team', team: Number(v) })}
          options={(options?.teams ?? []).map((t) => ({ value: String(t.id), label: t.name }))}
          ariaLabel='Team'
          className={SELECT}
        />
      )}
      {action.kind === 'step_owner' && (
        <SimpleSelect
          value={action.pick}
          onChange={(v) => onChange({ kind: 'step_owner', pick: v as 'first' | 'fewest_open' })}
          options={[
            { value: 'fewest_open', label: 'The owner with the fewest open requests' },
            { value: 'first', label: 'The first owner' }
          ]}
          ariaLabel='Which owner'
          className={SELECT}
        />
      )}
      {action.kind === 'share' && <ShareEditor action={action} onChange={onChange} />}
    </div>
  )
}

function ShareEditor({
  action,
  onChange
}: {
  action: Extract<AssignAction, { kind: 'share' }>
  onChange: (a: AssignAction) => void
}) {
  const setPerson = (i: number, p: AssignSharePerson) =>
    onChange({ ...action, people: action.people.map((x, j) => (j === i ? p : x)) })
  const strategy = STRATEGY_OPTIONS.find((s) => s.value === action.strategy)
  return (
    <div className='space-y-3' data-support-share-editor>
      <div className='overflow-hidden rounded-md border border-slate-200 dark:border-border'>
        {action.people.length === 0 ? (
          <p className='px-3 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Add the people who share these requests.
          </p>
        ) : (
          <ul className='divide-y divide-slate-100 dark:divide-border/60'>
            {action.people.map((p, i) => (
              <li
                key={p.id}
                className='flex flex-wrap items-center gap-2 bg-white px-2.5 py-1.5 dark:bg-card'
              >
                <span className='min-w-[10rem] flex-1 text-[12.5px]'>
                  <PersonName id={p.id} />
                </span>
                <label className='flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
                  At most
                  <input
                    type='number'
                    min={1}
                    inputMode='numeric'
                    value={p.cap ?? ''}
                    onChange={(e) =>
                      setPerson(i, {
                        ...p,
                        cap: e.target.value ? Math.max(1, Math.floor(Number(e.target.value))) : null
                      })
                    }
                    placeholder='any'
                    aria-label='Most open requests'
                    className={cn(INPUT, 'h-7 w-16 px-2 tabular-nums')}
                  />
                  open
                </label>
                <SimpleSelect
                  value={p.when}
                  onChange={(v) => setPerson(i, { ...p, when: v as AssignSharePerson['when'] })}
                  options={[
                    { value: 'always', label: 'Any time' },
                    { value: 'business_hours', label: 'Business hours only' },
                    { value: 'online', label: 'Only while online' }
                  ]}
                  ariaLabel='When they take requests'
                  className={cn(SELECT, 'h-7 min-w-[9rem]')}
                />
                <button
                  type='button'
                  aria-label='Remove this person'
                  data-tip='Remove'
                  onClick={() =>
                    onChange({ ...action, people: action.people.filter((_, j) => j !== i) })
                  }
                  className='inline-flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10 dark:hover:text-slate-100'
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className='border-t border-slate-100 bg-slate-50 px-2.5 py-1.5 dark:border-border/60 dark:bg-white/[0.03]'>
          <div className='w-64'>
            <RelationCombobox
              key={action.people.length}
              collection='nivaro_users'
              value={null}
              onChange={(v) =>
                v &&
                !action.people.some((p) => p.id === String(v).toUpperCase()) &&
                onChange({
                  ...action,
                  people: [
                    ...action.people,
                    { id: String(v).toUpperCase(), cap: null, when: 'always' }
                  ]
                })
              }
              placeholder='Add a person'
            />
          </div>
        </div>
      </div>
      <div className='flex flex-wrap items-center gap-2 text-[12.5px] text-slate-700 dark:text-slate-200'>
        Choose
        <SimpleSelect
          value={action.strategy}
          onChange={(v) => onChange({ ...action, strategy: v as typeof action.strategy })}
          options={STRATEGY_OPTIONS}
          ariaLabel='How to choose'
          className={cn(SELECT, 'min-w-[15rem]')}
          triggerProps={{ 'data-support-strategy': action.strategy }}
        />
      </div>
      {strategy && (
        <p className='-mt-1 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {strategy.description}
        </p>
      )}
      <label className='flex items-start gap-2 text-[12.5px] text-slate-700 dark:text-slate-200'>
        <input
          type='checkbox'
          checked={action.give_to_cover}
          onChange={(e) => onChange({ ...action, give_to_cover: e.target.checked })}
          className='mt-0.5 h-3.5 w-3.5 accent-nvr-navy dark:accent-nvr-cyan'
        />
        <span>
          Someone out of office hands it to their cover
          <span className='block text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            Off: they are skipped. Suspended people are always skipped.
          </span>
        </span>
      </label>
    </div>
  )
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function HoursEditor({
  hours,
  onChange
}: {
  hours: AssignHours
  onChange: (h: AssignHours) => void
}) {
  return (
    <div
      className='flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 dark:border-border dark:bg-card'
      data-support-hours
    >
      <fieldset className='flex items-center gap-1' aria-label='Business days'>
        {DAYS.map((d, i) => {
          const on = hours.days.includes(i)
          return (
            <button
              key={d}
              type='button'
              aria-pressed={on}
              onClick={() =>
                onChange({
                  ...hours,
                  days: on ? hours.days.filter((x) => x !== i) : [...hours.days, i].sort()
                })
              }
              className={cn(
                'h-7 w-10 rounded-md text-[12px]',
                on
                  ? 'bg-nvr-cyan/15 font-medium text-nvr-navy dark:text-nvr-cyan'
                  : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-white/10'
              )}
            >
              {d}
            </button>
          )
        })}
      </fieldset>
      <label className='flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
        From
        <input
          type='time'
          value={hours.start}
          onChange={(e) => onChange({ ...hours, start: e.target.value })}
          className={cn(INPUT, 'w-28')}
        />
      </label>
      <label className='flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
        to
        <input
          type='time'
          value={hours.end}
          onChange={(e) => onChange({ ...hours, end: e.target.value })}
          className={cn(INPUT, 'w-28')}
        />
      </label>
      <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        Eastern time · {clock12(hours.start)} – {clock12(hours.end)}
      </span>
    </div>
  )
}

interface TryForm {
  category_id: string
  collection: string
  item: string
  requester: string
  priority: string
  title: string
  source: string
  when: 'now' | 'inside' | 'outside'
}

/** A moment inside / outside the business hours, for "Try a request". */
function momentFor(when: TryForm['when'], hours: AssignHours): string | undefined {
  if (when === 'now') return undefined
  // Next business day at mid-window (inside) or 22:00 (outside), Eastern ≈ UTC-5.
  const day = hours.days[0] ?? 1
  const d = new Date()
  const diff = (day - d.getUTCDay() + 7) % 7 || 7
  d.setUTCDate(d.getUTCDate() + diff)
  const [sh] = hours.start.split(':').map(Number)
  const [eh] = hours.end.split(':').map(Number)
  const hourEt = when === 'inside' ? Math.floor((sh + eh) / 2) : 22
  d.setUTCHours(hourEt + 5, 0, 0, 0)
  return d.toISOString()
}

function TryRequest({
  draft,
  options,
  dirty
}: {
  draft: AssignRuleSet
  options: AssignOptions | undefined
  dirty: boolean
}) {
  const client = useNivaroClient()
  const [form, setForm] = useState<TryForm>({
    category_id: '',
    collection: '',
    item: '',
    requester: '',
    priority: 'normal',
    title: '',
    source: '',
    when: 'now'
  })
  const set = (p: Partial<TryForm>) => setForm((f) => ({ ...f, ...p }))
  const test = useMutation({
    mutationFn: () =>
      client
        .request<{ data: AssignTestResult }>(
          post('/support/assign-rules/test', {
            rules: draft.rules,
            hours: draft.hours,
            request: {
              category_id: form.category_id || null,
              collection: form.collection || null,
              item: form.collection ? form.item || null : null,
              requester: form.requester || null,
              priority: form.priority,
              title: form.title,
              source: form.source || null,
              at: momentFor(form.when, draft.hours)
            }
          })
        )
        .then((r) => r.data),
    onError: (err) => toastError(err, 'Could not try that request')
  })
  const field = (label: string, node: ReactNode) => (
    <div className='flex min-w-0 flex-col gap-1'>
      <span className='text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>{label}</span>
      {node}
    </div>
  )
  return (
    <section
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-support-try
    >
      <header className='border-b border-slate-100 px-4 py-3 dark:border-border/60'>
        <h3 className='text-[13px] font-semibold text-slate-900 dark:text-slate-100'>
          Try a request
        </h3>
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          Describe a request to see which rule wins and who would get it
          {dirty ? ' — using your unsaved changes' : ''}. Nothing is created.
        </p>
      </header>
      <div className='grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-2 lg:grid-cols-4'>
        {field(
          'Type',
          <SimpleSelect
            value={form.category_id}
            onChange={(v) => set({ category_id: v })}
            options={[
              { value: '', label: 'No type' },
              ...(options?.types ?? []).map((t) => ({ value: String(t.id), label: t.name }))
            ]}
            ariaLabel='Type'
            className={cn(SELECT, 'w-full')}
          />
        )}
        {field(
          'About',
          <SimpleSelect
            value={form.collection}
            onChange={(v) => set({ collection: v, item: '' })}
            options={[
              { value: '', label: 'General Support' },
              ...(options?.collections ?? [])
                .filter((c) => !c.hidden)
                .map((c) => ({ value: c.collection, label: c.name }))
            ]}
            ariaLabel='About'
            className={cn(SELECT, 'w-full')}
          />
        )}
        {form.collection
          ? field(
              'Record',
              <RelationCombobox
                key={form.collection}
                collection={form.collection}
                value={form.item || null}
                onChange={(v) => set({ item: v == null ? '' : String(v) })}
                placeholder='Pick a record'
              />
            )
          : null}
        {field(
          'Requester',
          <RelationCombobox
            collection='nivaro_users'
            value={form.requester || null}
            onChange={(v) => set({ requester: v ? String(v) : '' })}
            placeholder='Anyone'
          />
        )}
        {field(
          'Priority',
          <SimpleSelect
            value={form.priority}
            onChange={(v) => set({ priority: v })}
            options={[
              { value: 'normal', label: 'Normal' },
              { value: 'urgent', label: 'Urgent' },
              { value: 'low', label: 'Low' }
            ]}
            ariaLabel='Priority'
            className={cn(SELECT, 'w-full')}
          />
        )}
        {field(
          'Raised from',
          <SimpleSelect
            value={form.source}
            onChange={(v) => set({ source: v })}
            options={[
              { value: '', label: 'Worked out from the request' },
              ...(Object.keys(SOURCE_LABELS) as AssignSource[]).map((s) => ({
                value: s,
                label: SOURCE_LABELS[s].replace(/^./, (m) => m.toUpperCase())
              }))
            ]}
            ariaLabel='Raised from'
            className={cn(SELECT, 'w-full')}
          />
        )}
        {field(
          'When',
          <SimpleSelect
            value={form.when}
            onChange={(v) => set({ when: v as TryForm['when'] })}
            options={[
              { value: 'now', label: 'Right now' },
              { value: 'inside', label: 'During business hours' },
              { value: 'outside', label: 'Outside business hours' }
            ]}
            ariaLabel='When'
            className={cn(SELECT, 'w-full')}
          />
        )}
        <div className='sm:col-span-2 lg:col-span-4'>
          {field(
            'Title and description',
            <input
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder='e.g. Please change the vendor on this PO'
              className={cn(INPUT, 'w-full')}
            />
          )}
        </div>
      </div>
      <div className='flex items-center gap-2 border-t border-slate-100 px-4 py-2.5 dark:border-border/60'>
        <button
          type='button'
          className={PRIMARY_BTN}
          onClick={() => test.mutate()}
          disabled={test.isPending}
          data-support-try-run
        >
          {test.isPending ? 'Checking…' : 'Who gets it?'}
        </button>
      </div>
      {test.data && <TryResult result={test.data} />}
    </section>
  )
}

function TryResult({ result }: { result: AssignTestResult }) {
  const o = result.outcome
  const headline =
    o.kind === 'person'
      ? o.user.name
      : o.kind === 'team'
        ? `${o.team.name}’s desk`
        : o.via === 'keep'
          ? 'Stays with whoever has it'
          : 'The desk (unassigned)'
  const via =
    o.kind === 'person' && o.via === 'type_default'
      ? 'the type’s default assignee — no rule fits'
      : o.rule
        ? `rule “${o.rule.name}”${o.via === 'rule_fallback' ? ' — its fallback' : ''}`
        : 'no rule fits'
  return (
    <div
      className='space-y-4 border-t border-slate-100 px-4 py-4 dark:border-border/60'
      data-support-try-result
      role='status'
    >
      <div className='flex items-center gap-3'>
        {o.kind === 'person' ? (
          <PersonDisc id={o.user.id} name={o.user.name} size={32} />
        ) : (
          <span className='flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 dark:bg-white/10'>
            <Route className='h-4 w-4 text-slate-500' />
          </span>
        )}
        <div>
          <p className='text-[14px] font-semibold text-slate-900 dark:text-slate-100'>{headline}</p>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            By {via}. {o.note}
          </p>
        </div>
      </div>
      {result.pick && (result.pick.ranking.length > 0 || result.pick.skipped.length > 0) && (
        <div className='grid gap-4 md:grid-cols-2'>
          {result.pick.ranking.length > 0 && (
            <div>
              <h4 className='mb-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
                Ranking
                {result.pick.used !== undefined
                  ? ` — ${STRATEGY_OPTIONS.find((s) => s.value === result.pick?.used)?.label.toLowerCase()}`
                  : ''}
              </h4>
              <ol className='space-y-1'>
                {result.pick.ranking.map((r, i) => (
                  <li key={r.id} className='flex items-center gap-2 text-[12.5px]'>
                    <span className='w-4 text-right tabular-nums text-slate-400'>{i + 1}</span>
                    <PersonDisc id={r.id} name={r.name} size={18} />
                    <span
                      className={cn(
                        'truncate',
                        i === 0
                          ? 'font-medium text-slate-900 dark:text-slate-100'
                          : 'text-slate-700 dark:text-slate-300'
                      )}
                    >
                      {r.name}
                      {r.for && (
                        <span className='font-normal text-slate-500'> (covering {r.for})</span>
                      )}
                    </span>
                    <span className='ml-auto shrink-0 tabular-nums text-slate-500 dark:text-muted-foreground'>
                      {r.measure}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {result.pick.skipped.length > 0 && (
            <div>
              <h4 className='mb-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
                Skipped
              </h4>
              <ul className='space-y-1'>
                {result.pick.skipped.map((s) => (
                  <li key={s.id} className='flex items-center gap-2 text-[12.5px]'>
                    <PersonDisc id={s.id} name={s.name} size={18} />
                    <span className='truncate text-slate-700 dark:text-slate-300'>{s.name}</span>
                    <span className='ml-auto shrink-0 text-right text-slate-500 dark:text-muted-foreground'>
                      {s.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {result.trace.length > 0 && (
        <div>
          <h4 className='mb-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
            Each rule
          </h4>
          <ol className='space-y-1'>
            {result.trace.map((t, i) => (
              <li key={t.id} className='flex flex-wrap items-baseline gap-x-2 text-[12.5px]'>
                <span className='w-4 text-right tabular-nums text-slate-400'>{i + 1}</span>
                <span
                  className={cn(
                    'rounded px-1.5 py-px text-[11px] font-medium',
                    t.result === 'matched'
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300'
                      : 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300'
                  )}
                >
                  {t.result === 'matched'
                    ? 'Wins'
                    : t.result === 'no_match'
                      ? 'Doesn’t fit'
                      : t.result === 'held'
                        ? 'Held back'
                        : 'Not reached'}
                </span>
                <span className='font-medium text-slate-800 dark:text-slate-100'>{t.name}</span>
                {t.reasons.length > 0 && (
                  <span className='text-slate-500 dark:text-muted-foreground'>
                    — {t.reasons.join('; ')}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
