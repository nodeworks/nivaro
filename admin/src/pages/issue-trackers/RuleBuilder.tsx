import {
  ConfirmButton,
  describeError,
  ErrorNotice,
  toastError,
  useUnsavedWork
} from '@nivaro/shared'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Loader2, TriangleAlert, X } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  fetchGitlabUsers,
  fetchLabels,
  fetchProjects,
  fetchTemplateVars,
  type Role,
  type RuleAction,
  type RuleAppliesTo,
  type RuleDraft,
  type RuleError,
  type RuleGuards,
  type RuleMatch,
  type RuleThreshold,
  ruleErrorsOf,
  SEVERITIES,
  type TemplateSample,
  type TrackerConnection,
  type TrackerRule,
  trackerKeys
} from './api'
import { LabelPicker } from './LabelPicker'
import { RulePreview, useDebounced } from './RulePreview'
import {
  ChoiceButtons,
  CountWindowBox,
  DurationBox,
  FieldRow,
  NumberBox,
  PickList,
  TagInput
} from './rule-fields'
import {
  APPLIES_TO_LABELS,
  appliesToChoices,
  errorsFor,
  ISSUE_SOURCES,
  ISSUE_STATUSES,
  ruleBody,
  type SentencePart,
  sentenceParts,
  TICKET_RULE_PRIORITIES,
  TICKET_STATUSES,
  withActionPatch,
  withAppliesTo,
  withConnection
} from './rule-sentence'
import { Segmented, SwitchRow } from './SyncCards'

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ')
const opts = (list: string[]) => list.map((v) => ({ value: v, label: titleCase(v) }))
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Sets a key, or removes it when the value is empty (the server keeps no empty lists). */
function setKey<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): T {
  const next = { ...obj }
  const empty =
    value === undefined || value === null || (Array.isArray(value) && value.length === 0)
  if (empty) delete next[key]
  else next[key] = value as T[K]
  return next
}

function SectionErrors({ errors }: { errors: RuleError[] }) {
  if (!errors.length) return null
  return (
    <ul
      role='alert'
      className='space-y-0.5 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11.5px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
    >
      {errors.map((e) => (
        <li key={`${e.path}:${e.message}`}>{e.message}</li>
      ))}
    </ul>
  )
}

function Section({
  title,
  hint,
  errors,
  children
}: {
  title: string
  hint?: ReactNode
  errors: RuleError[]
  children: ReactNode
}) {
  return (
    <section className='space-y-3 border-t border-slate-100 pt-4 first:border-t-0 first:pt-0 dark:border-border'>
      <div>
        <h4 className='text-[12px] font-semibold text-slate-900 dark:text-foreground'>{title}</h4>
        {hint && (
          <p className='mt-0.5 max-w-[64ch] text-[11px] text-slate-500 dark:text-muted-foreground'>
            {hint}
          </p>
        )}
      </div>
      <SectionErrors errors={errors} />
      {children}
    </section>
  )
}

// ── Editors shared by the sentence popovers and the sections ────────────────

type MatchProps = { draft: RuleDraft; onMatch: (m: RuleMatch) => void }

function SubjectEditor({
  draft,
  onMatch,
  categories
}: MatchProps & { categories: Array<{ id: number; name: string }> }) {
  const m = draft.match
  if (draft.applies_to === 'ticket')
    return (
      <div className='space-y-3'>
        <FieldRow label='Priority' hint='None picked = any priority.'>
          <ChoiceButtons
            ariaLabel='Ticket priority'
            value={m.priorities ?? []}
            options={opts(TICKET_RULE_PRIORITIES)}
            onChange={(v) => onMatch(setKey(m, 'priorities', v))}
          />
        </FieldRow>
        <FieldRow label='Request type' hint='None picked = any type.'>
          <PickList
            multi
            ariaLabel='Request types'
            placeholder='Any request type'
            value={m.categories ?? []}
            options={categories.map((c) => ({ value: c.id, label: c.name }))}
            onChange={(v) => onMatch(setKey(m, 'categories', v))}
          />
        </FieldRow>
      </div>
    )
  const sources = m.sources ?? []
  const known = [...new Set([...ISSUE_SOURCES, ...sources])]
  return (
    <FieldRow
      label='Where it came from'
      hint='None picked = any source. Type another source name below to add it.'
    >
      <ChoiceButtons
        ariaLabel='Issue sources'
        value={sources}
        options={opts(known)}
        onChange={(v) => onMatch(setKey(m, 'sources', v))}
      />
      <TagInput
        ariaLabel='Other source'
        placeholder='Other source…'
        value={[]}
        onChange={(v) => {
          const next = [...sources]
          for (const x of v)
            if (!next.some((y) => y.toLowerCase() === x.toLowerCase())) next.push(x.toLowerCase())
          if (next.length !== sources.length) onMatch(setKey(m, 'sources', next))
        }}
      />
    </FieldRow>
  )
}

function SeverityEditor({ draft, onMatch }: MatchProps) {
  return (
    <FieldRow label='Severity at least'>
      <ChoiceButtons
        single
        ariaLabel='Severity at least'
        value={[draft.match.severity_min ?? 'any']}
        options={[{ value: 'any', label: 'Any' }, ...opts([...SEVERITIES])]}
        onChange={(v) =>
          onMatch(
            setKey(
              draft.match,
              'severity_min',
              v[0] === 'any' ? undefined : (v[0] as RuleMatch['severity_min'])
            )
          )
        }
      />
    </FieldRow>
  )
}

function ThresholdEditor({
  draft,
  onThreshold
}: {
  draft: RuleDraft
  onThreshold: (t: RuleThreshold) => void
}) {
  const t = draft.threshold
  const ticket = draft.applies_to === 'ticket'
  return (
    <div className='space-y-2.5'>
      {!ticket && (
        <>
          <CountWindowBox
            ariaLabel='Seen'
            noun='times'
            value={t.hits}
            onChange={(v) => onThreshold(setKey(t, 'hits', v))}
          />
          <CountWindowBox
            ariaLabel='Seen by'
            noun='people'
            value={t.people}
            onChange={(v) => onThreshold(setKey(t, 'people', v))}
          />
        </>
      )}
      <div className='flex flex-wrap items-center gap-2 text-[12px] text-slate-700 dark:text-slate-200'>
        <span>Still open after</span>
        {t.open_minutes ? (
          <>
            <DurationBox
              ariaLabel='Still open after'
              minutes={t.open_minutes}
              onChange={(m) => onThreshold({ ...t, open_minutes: m })}
            />
            <Button
              type='button'
              variant='ghost'
              size='sm'
              className='h-7 px-2 text-[11.5px]'
              onClick={() => onThreshold(setKey(t, 'open_minutes', undefined))}
            >
              Clear
            </Button>
          </>
        ) : (
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='h-7 px-2 text-[11.5px]'
            onClick={() => onThreshold({ ...t, open_minutes: 240 })}
          >
            Set a time
          </Button>
        )}
      </div>
      {!ticket && (
        <div className='flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-slate-700 dark:text-slate-200'>
          <span className='inline-flex items-center gap-2'>
            Came back
            <NumberBox
              optional
              min={1}
              ariaLabel='Came back at least (times)'
              placeholder='–'
              value={t.recurrences}
              onChange={(n) => onThreshold(setKey(t, 'recurrences', n))}
            />
            times
          </span>
          <span className='inline-flex items-center gap-2'>
            Seen
            <NumberBox
              optional
              min={1}
              ariaLabel='Seen in all (times)'
              placeholder='–'
              value={t.total_hits}
              onChange={(n) => onThreshold(setKey(t, 'total_hits', n))}
            />
            times in all
          </span>
        </div>
      )}
      <p className='text-[11px] text-slate-500 dark:text-muted-foreground'>
        {ticket
          ? 'With no time set, the rule acts as soon as a ticket is raised.'
          : 'Every count that is set must be reached. With none, the rule acts on the first sighting.'}
      </p>
    </div>
  )
}

function ModeEditor({
  draft,
  onAction,
  onMode
}: ActionProps & { onMode: (m: RuleDraft['mode']) => void }) {
  return (
    <div className='space-y-3'>
      <FieldRow
        label='What it does'
        hint={
          draft.mode === 'create'
            ? 'Opens the GitLab issue on its own.'
            : 'Marks it for a person to send — nothing goes to GitLab until they do.'
        }
      >
        <Segmented
          ariaLabel='What the rule does'
          value={draft.mode}
          options={[
            { value: 'suggest', label: 'Suggest' },
            { value: 'create', label: 'Create' }
          ]}
          onChange={onMode}
        />
      </FieldRow>
      <FieldRow label='GitLab issue type'>
        <Segmented
          ariaLabel='GitLab issue type'
          value={draft.action.issue_type}
          options={[
            { value: 'issue', label: 'Issue' },
            { value: 'incident', label: 'Incident' }
          ]}
          onChange={(v) => onAction({ issue_type: v })}
        />
      </FieldRow>
    </div>
  )
}

type ActionProps = { draft: RuleDraft; onAction: (a: Partial<RuleAction>) => void }

function ProjectEditor({
  draft,
  onAction,
  connection,
  paths,
  onPath
}: ActionProps & {
  connection: TrackerConnection
  paths: Map<number, string>
  onPath: (id: number, path: string) => void
}) {
  const [search, setSearch] = useState('')
  const q = useDebounced(search, 250)
  const projects = useQuery({
    queryKey: trackerKeys.projects(connection.id, q),
    queryFn: () => fetchProjects(connection.id, q),
    enabled: connection.token_set,
    placeholderData: keepPreviousData,
    staleTime: 60_000
  })
  const options = [
    {
      value: 0,
      label: connection.default_project_path
        ? `Default project (${connection.default_project_path})`
        : 'Default project'
    },
    ...(projects.data ?? []).map((p) => ({ value: p.id, label: p.path_with_namespace }))
  ]
  const id = draft.action.project_id
  if (id && !options.some((o) => o.value === id))
    options.push({ value: id, label: paths.get(id) ?? `Project ${id}` })
  return (
    <FieldRow
      label='GitLab project'
      hint={connection.token_set ? undefined : 'Save a token on the connection to search projects.'}
    >
      <PickList
        ariaLabel='GitLab project'
        placeholder='Default project'
        value={[id ?? 0]}
        options={options}
        onSearch={setSearch}
        loading={projects.isFetching}
        emptyText='No project matches.'
        onChange={(v) => {
          const next = v[0] || undefined
          if (next) {
            const p = projects.data?.find((x) => x.id === next)
            if (p) onPath(p.id, p.path_with_namespace)
          }
          onAction({ project_id: next })
        }}
      />
    </FieldRow>
  )
}

// ── Templates ───────────────────────────────────────────────────────────────

interface SampleSource {
  id: number
  title: string
}

async function fetchSampleSources(kind: RuleAppliesTo, q: string): Promise<SampleSource[]> {
  if (kind === 'ticket') {
    const r = await api.get<{ data: Array<{ id: number; title: string }> }>('/support/tickets', {
      params: { scope: 'desk', sort: 'newest', limit: 20, q: q || undefined }
    })
    return r.data.data.map((t) => ({ id: t.id, title: t.title }))
  }
  const r = await api.get<{ data: Array<{ id: number; title: string }> }>('/issues', {
    params: { sort: 'last_seen', limit: 20, q: q || undefined }
  })
  return r.data.data.map((i) => ({ id: i.id, title: i.title }))
}

function TemplatesEditor({ draft, onAction }: ActionProps) {
  const kind = draft.applies_to
  const vars = useQuery({
    queryKey: trackerKeys.templateVars(kind),
    queryFn: () => fetchTemplateVars(kind),
    staleTime: Number.POSITIVE_INFINITY
  })
  const lastField = useRef<'title_template' | 'body_template'>('body_template')
  // the field last focused, for "Insert a value" (taken from focus: the inputs pass no ref)
  const lastEl = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  const insert = (name: string) => {
    const key = lastField.current
    const el = lastEl.current
    const cur = draft.action[key]
    const token = `{{ ${name} }}`
    const at = el?.selectionStart ?? cur.length
    const end = el?.selectionEnd ?? at
    onAction({ [key]: cur.slice(0, at) + token + cur.slice(end) })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + token.length, at + token.length)
    })
  }

  const [search, setSearch] = useState('')
  const q = useDebounced(search, 250)
  const sources = useQuery({
    queryKey: trackerKeys.samples(kind, q),
    queryFn: () => fetchSampleSources(kind, q),
    placeholderData: keepPreviousData,
    staleTime: 60_000
  })
  const [sampleId, setSampleId] = useState<number | null>(null)
  // a sample of the other kind means nothing once the rule changes kind
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on kind change on purpose
  useEffect(() => setSampleId(null), [kind])
  const sampleBody = useDebounced(
    JSON.stringify({
      applies_to: kind,
      source_id: sampleId,
      title_template: draft.action.title_template,
      body_template: draft.action.body_template,
      labels: draft.action.labels,
      include_details: draft.action.include_details
    }),
    400
  )
  const sample = useQuery({
    queryKey: trackerKeys.sample(sampleBody),
    queryFn: () =>
      api
        .post<{ data: TemplateSample }>('/trackers/rules/sample', JSON.parse(sampleBody))
        .then((r) => r.data.data),
    enabled:
      sampleId != null && (JSON.parse(sampleBody) as { source_id: unknown }).source_id != null,
    placeholderData: keepPreviousData,
    retry: false
  })
  const thing = kind === 'ticket' ? 'support ticket' : 'issue'

  return (
    <div className='grid gap-4 lg:grid-cols-2'>
      <div className='space-y-3'>
        <FieldRow label='Title' htmlFor='tracker-rule-title' hint='Empty = the default title.'>
          <Input
            id='tracker-rule-title'
            value={draft.action.title_template}
            placeholder={kind === 'ticket' ? '{{ title }}' : '[{{ severity }}] {{ title }}'}
            onFocus={(e) => {
              lastField.current = 'title_template'
              lastEl.current = e.currentTarget
            }}
            onChange={(e) => onAction({ title_template: e.target.value })}
            className='h-8 font-mono text-[12px]'
          />
        </FieldRow>
        <FieldRow
          label='Description'
          htmlFor='tracker-rule-body'
          hint='Empty = the default description. Liquid: {% if %}, filters.'
        >
          <Textarea
            id='tracker-rule-body'
            value={draft.action.body_template}
            rows={8}
            placeholder='Empty = the default description'
            onFocus={(e) => {
              lastField.current = 'body_template'
              lastEl.current = e.currentTarget
            }}
            onChange={(e) => onAction({ body_template: e.target.value })}
            className='font-mono text-[12px]'
          />
        </FieldRow>
        <div className='space-y-1'>
          <p className='text-[11.5px] font-medium text-slate-700 dark:text-slate-200'>
            Insert a value
          </p>
          <div className='flex flex-wrap gap-1'>
            {(vars.data ?? []).map((v) => (
              <button
                key={v.name}
                type='button'
                data-tip={v.description}
                aria-label={`Insert ${v.name}: ${v.description}`}
                onClick={() => insert(v.name)}
                className='rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[11px] text-slate-700 hover:border-nvr-cyan/50 hover:bg-nvr-cyan/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-border dark:bg-card dark:text-slate-200 dark:hover:bg-nvr-cyan/10'
              >
                {v.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className='space-y-2'>
        <FieldRow label={`Sample with a recent ${thing}`}>
          <PickList
            ariaLabel={`Recent ${thing} for the sample`}
            placeholder={`Pick a ${thing}…`}
            value={sampleId == null ? [] : [sampleId]}
            options={(sources.data ?? []).map((s) => ({
              value: s.id,
              label: s.title || `#${s.id}`,
              hint: `#${s.id}`
            }))}
            onSearch={setSearch}
            loading={sources.isFetching}
            onChange={(v) => setSampleId(v[0] ?? null)}
          />
        </FieldRow>
        {sampleId == null ? (
          <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            Pick one to see the GitLab issue these templates would write for it.
          </p>
        ) : sample.isError ? (
          <ErrorNotice error={sample.error} what='the sample' />
        ) : sample.data ? (
          <div
            aria-live='polite'
            className={cn(
              'space-y-2 rounded-md border border-slate-200 bg-slate-50 p-2.5 dark:border-border dark:bg-muted/30',
              sample.isFetching && 'opacity-70'
            )}
          >
            <p className='text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
              {sample.data.title || 'Untitled'}
            </p>
            {sample.data.labels.length > 0 && (
              <div className='flex flex-wrap gap-1'>
                {sample.data.labels.map((l) => (
                  <span
                    key={l}
                    className='rounded bg-slate-200/70 px-1.5 py-px text-[11px] text-slate-700 dark:bg-muted dark:text-slate-200'
                  >
                    {l}
                  </span>
                ))}
              </div>
            )}
            <pre className='max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-slate-700 dark:text-slate-200'>
              {sample.data.body}
            </pre>
          </div>
        ) : (
          <p className='inline-flex items-center gap-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            <Loader2 className='h-3 w-3 animate-spin' /> Rendering…
          </p>
        )}
      </div>
    </div>
  )
}

// ── The builder ─────────────────────────────────────────────────────────────

function SentenceBit({
  text,
  label,
  children
}: {
  text: string
  label: string
  children: ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={`${label}: ${text}`}
          className='rounded-sm font-semibold text-slate-900 underline decoration-slate-300 decoration-dotted underline-offset-4 hover:decoration-nvr-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-foreground dark:decoration-slate-600'
        >
          {text}
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[min(26rem,calc(100vw-2rem))] space-y-3 p-3'>
        <p className='text-[11.5px] font-semibold text-slate-700 dark:text-slate-200'>{label}</p>
        {children}
      </PopoverContent>
    </Popover>
  )
}

const PART_LABELS: Record<SentencePart, string> = {
  subject: 'Which ones',
  severity: 'Severity',
  threshold: 'How often',
  action: 'What it does',
  project: 'GitLab project',
  labels: 'Labels'
}

/** A two-press "Discard changes?" while armed. */
export const DISCARD_ARMED =
  'bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/15'

export function RuleBuilder({
  rule,
  initial,
  connections,
  roles,
  onDone,
  onDirtyChange
}: {
  /** The stored rule being edited, or null for a new one. */
  rule: TrackerRule | null
  initial: RuleDraft
  connections: TrackerConnection[]
  roles: Role[]
  onDone: (saved: TrackerRule | null) => void
  /** Unsaved edits here (the list asks before it opens another rule over them). */
  onDirtyChange?: (dirty: boolean) => void
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<RuleDraft>(initial)
  const [errors, setErrors] = useState<RuleError[] | null>(
    rule && !rule.valid ? (rule.errors ?? null) : null
  )
  const [paths, setPaths] = useState<Map<number, string>>(() => new Map())
  // The list's on/off switch changes the stored rule (and so `initial`) while this is open:
  // follow it, unless the switch here was changed and not saved yet (that edit wins).
  const listEnabled = useRef(initial.enabled)
  useEffect(() => {
    const before = listEnabled.current
    listEnabled.current = initial.enabled
    if (before === initial.enabled) return
    setDraft((d) => (d.enabled === before ? { ...d, enabled: initial.enabled } : d))
  }, [initial.enabled])
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  useUnsavedWork(dirty, 'GitLab rule')
  const onDirtyRef = useRef(onDirtyChange)
  onDirtyRef.current = onDirtyChange
  useEffect(() => onDirtyRef.current?.(dirty), [dirty])

  // The builder opens below the list, often out of view: bring it up and put the cursor in the
  // name (without a second jump). The list hands focus back to the rule's row on close.
  const sectionRef = useRef<HTMLElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    sectionRef.current?.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
    nameRef.current?.focus({ preventScroll: true })
  }, [])

  const connection =
    connections.find((c) => c.id === draft.action.connection) ?? connections[0] ?? null
  const kinds = appliesToChoices(connection?.sync.sources)
  const kindOff = !kinds.includes(draft.applies_to)

  const canList = !!connection?.token_set && connection.default_project_id != null
  const labels = useQuery({
    queryKey: trackerKeys.labels(connection?.id ?? 0, connection?.default_project_id ?? null),
    queryFn: () => fetchLabels(connection?.id ?? 0),
    enabled: canList,
    staleTime: 5 * 60_000
  })
  const labelsUnavailable = !canList
    ? 'Pick a default project on the connection to list its labels. You can still type one.'
    : labels.isError
      ? `${describeError(labels.error, 'Could not list the labels').title} You can still type one.`
      : null
  const categories = useQuery({
    queryKey: ['trackers', 'support-categories'],
    queryFn: () =>
      api
        .get<{ data: Array<{ id: number; name: string }> }>('/support/categories', {
          params: { any: 1 }
        })
        .then((r) => r.data.data),
    enabled: draft.applies_to === 'ticket',
    staleTime: 5 * 60_000
  })
  const assigneeProject = draft.action.project_id ?? connection?.default_project_id ?? null
  const [userSearch, setUserSearch] = useState('')
  const userQ = useDebounced(userSearch, 250)
  const users = useQuery({
    queryKey: trackerKeys.users(connection?.id ?? 0, assigneeProject ?? 0, userQ),
    queryFn: () => fetchGitlabUsers(connection?.id ?? 0, assigneeProject ?? 0, userQ),
    enabled: !!connection?.token_set && assigneeProject != null,
    placeholderData: keepPreviousData,
    staleTime: 60_000
  })
  const [userNames, setUserNames] = useState<Map<number, string>>(() => new Map())
  useEffect(() => {
    if (!users.data?.length) return
    setUserNames((m) => {
      const next = new Map(m)
      for (const u of users.data) next.set(u.id, `${u.name} (@${u.username})`)
      return next
    })
  }, [users.data])

  const onMatch = (match: RuleMatch) => setDraft((d) => ({ ...d, match }))
  const onThreshold = (threshold: RuleThreshold) => setDraft((d) => ({ ...d, threshold }))
  const onGuards = (g: Partial<RuleGuards>) =>
    setDraft((d) => ({ ...d, guards: { ...d.guards, ...g } }))
  const onAction = (a: Partial<RuleAction>) =>
    setDraft((d) => ({ ...d, action: withActionPatch(d.action, a) }))
  const onMode = (mode: RuleDraft['mode']) => setDraft((d) => ({ ...d, mode }))

  const projectPath = draft.action.project_id
    ? (paths.get(draft.action.project_id) ?? null)
    : (connection?.default_project_path ?? null)
  const parts = sentenceParts(draft, { projectPath })
  const issueKind = draft.applies_to === 'issue'

  const save = useMutation({
    mutationFn: () => {
      const body = ruleBodyOf(draft)
      return rule
        ? api
            .patch<{ data: TrackerRule }>(`/trackers/rules/${rule.id}`, body)
            .then((r) => r.data.data)
        : api.post<{ data: TrackerRule }>('/trackers/rules', body).then((r) => r.data.data)
    },
    onSuccess: (saved) => {
      setErrors(null)
      void qc.invalidateQueries({ queryKey: trackerKeys.rules() })
      toast.success(rule ? 'Rule saved' : 'Rule added')
      onDone(saved)
    },
    onError: (err) => {
      const errs = ruleErrorsOf(err)
      if (errs) {
        setErrors(errs)
        toast.error('The rule needs a few fixes — they are marked below.')
      } else toastError(err, 'Could not save the rule')
    }
  })
  const remove = useMutation({
    mutationFn: () => api.delete(`/trackers/rules/${rule?.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: trackerKeys.rules() })
      toast.success('Rule deleted')
      onDone(null)
    },
    onError: (err) => toastError(err, 'Could not delete the rule')
  })
  const [confirmDelete, setConfirmDelete] = useState(false)

  const editorFor = (part: SentencePart) => {
    switch (part) {
      case 'subject':
        return <SubjectEditor draft={draft} onMatch={onMatch} categories={categories.data ?? []} />
      case 'severity':
        return <SeverityEditor draft={draft} onMatch={onMatch} />
      case 'threshold':
        return <ThresholdEditor draft={draft} onThreshold={onThreshold} />
      case 'action':
        return <ModeEditor draft={draft} onAction={onAction} onMode={onMode} />
      case 'project':
        return connection ? (
          <ProjectEditor
            draft={draft}
            onAction={onAction}
            connection={connection}
            paths={paths}
            onPath={(id, p) => setPaths((m) => new Map(m).set(id, p))}
          />
        ) : null
      case 'labels':
        return (
          <LabelPicker
            multi
            ariaLabel='Labels on the GitLab issue'
            labels={labels.data}
            unavailable={labelsUnavailable}
            value={draft.action.labels}
            onChange={(v) => onAction({ labels: v })}
          />
        )
    }
  }

  const m = draft.match
  const g = draft.guards
  const statusList = issueKind ? ISSUE_STATUSES : TICKET_STATUSES
  const roleOptions = roles.map((r) => ({ value: r.id, label: r.name }))
  const tz = useMemo(() => {
    try {
      return (
        (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
          'timeZone'
        ) ?? []
      )
    } catch {
      return []
    }
  }, [])

  return (
    <section
      ref={sectionRef}
      aria-label={rule ? `Edit rule ${rule.name}` : 'New rule'}
      className='scroll-mt-4 rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      {/* Head: name, on/off, close */}
      <div className='flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3 dark:border-border'>
        <Label htmlFor='tracker-rule-name' className='sr-only'>
          Rule name
        </Label>
        <Input
          ref={nameRef}
          id='tracker-rule-name'
          value={draft.name}
          maxLength={200}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          className='h-8 min-w-0 flex-1 basis-[220px] text-[13px] font-semibold'
        />
        <div className='flex items-center gap-2'>
          <Switch
            id='tracker-rule-enabled'
            checked={draft.enabled}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
          />
          <Label htmlFor='tracker-rule-enabled' className='cursor-pointer text-[12px]'>
            {draft.enabled ? 'On' : 'Off'}
          </Label>
        </div>
        {dirty ? (
          <ConfirmButton
            title='Close the rule'
            confirmLabel='Discard changes?'
            className='inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-[12px] text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-slate-300 dark:hover:bg-muted'
            armedClassName={DISCARD_ARMED}
            onConfirm={() => onDone(null)}
          >
            <X className='h-4 w-4' />
          </ConfirmButton>
        ) : (
          <Button
            type='button'
            variant='ghost'
            size='sm'
            aria-label='Close the rule'
            className='h-8 w-8 p-0'
            onClick={() => onDone(null)}
          >
            <X className='h-4 w-4' />
          </Button>
        )}
      </div>

      <div className='space-y-4 p-4'>
        {/* Applies to + connection */}
        <div className='flex flex-wrap items-end gap-x-6 gap-y-3'>
          {connections.length > 1 && (
            <FieldRow label='Connection' className='w-64'>
              <PickList
                ariaLabel='GitLab connection'
                placeholder='Pick a connection'
                value={[draft.action.connection]}
                options={connections.map((c) => ({ value: c.id, label: c.name }))}
                onChange={(v) => v[0] && setDraft((d) => withConnection(d, v[0]))}
              />
            </FieldRow>
          )}
          <FieldRow label='Applies to'>
            {kinds.length > 1 || kindOff ? (
              <Segmented
                ariaLabel='Applies to'
                value={draft.applies_to}
                options={(kindOff ? [...kinds, draft.applies_to] : kinds).map((k) => ({
                  value: k,
                  label: APPLIES_TO_LABELS[k]
                }))}
                onChange={(k) => setDraft((d) => withAppliesTo(d, k))}
              />
            ) : (
              <p className='h-8 text-[12px] leading-8 text-slate-700 dark:text-slate-200'>
                {APPLIES_TO_LABELS[draft.applies_to]}
              </p>
            )}
          </FieldRow>
        </div>
        {kindOff && (
          <p className='inline-flex items-start gap-1.5 text-[11.5px] text-amber-800 dark:text-amber-300'>
            <TriangleAlert className='mt-px h-3.5 w-3.5 shrink-0' aria-hidden />
            {APPLIES_TO_LABELS[draft.applies_to]} are switched off on this connection, so this rule
            never runs. Switch them on under What syncs, or pick another kind.
          </p>
        )}

        {/* The sentence */}
        <p className='rounded-md bg-slate-50 px-3 py-2.5 text-[13.5px] leading-7 text-slate-700 dark:bg-muted/30 dark:text-slate-200'>
          {parts.map((b, i) =>
            b.part ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the sentence is rebuilt whole each render
              <SentenceBit key={i} text={b.text} label={PART_LABELS[b.part]}>
                {editorFor(b.part)}
              </SentenceBit>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: as above
              <span key={i}>{b.text}</span>
            )
          )}
          .
        </p>

        <div className='grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]'>
          <div className='space-y-4'>
            <Section
              title='Match'
              hint='Which ones the rule looks at. Everything set must match.'
              errors={errorsFor(errors, 'match').concat(errorsFor(errors, 'applies_to'))}
            >
              <SubjectEditor draft={draft} onMatch={onMatch} categories={categories.data ?? []} />
              {issueKind && <SeverityEditor draft={draft} onMatch={onMatch} />}
              <FieldRow label='Status' hint='None picked = any status.'>
                <ChoiceButtons
                  ariaLabel='Status'
                  value={m.statuses ?? []}
                  options={opts(statusList)}
                  onChange={(v) => onMatch(setKey(m, 'statuses', v))}
                />
              </FieldRow>
              <FieldRow label='Text' hint='Words to look for. Use * as a wildcard.'>
                <div className='flex flex-wrap items-center gap-2'>
                  <Segmented
                    ariaLabel='Text match'
                    value={m.text?.op ?? 'any'}
                    options={[
                      { value: 'any', label: 'Any of' },
                      { value: 'all', label: 'All of' },
                      { value: 'none', label: 'None of' }
                    ]}
                    onChange={(op) =>
                      onMatch({
                        ...m,
                        text: { terms: [], in: ['title', 'details'], ...m.text, op }
                      })
                    }
                  />
                  <ChoiceButtons
                    ariaLabel='Look in'
                    value={m.text?.in ?? ['title', 'details']}
                    options={[
                      { value: 'title', label: issueKind ? 'Title' : 'Summary' },
                      { value: 'details', label: issueKind ? 'Details' : 'Description' }
                    ]}
                    onChange={(v) =>
                      v.length &&
                      onMatch({
                        ...m,
                        text: {
                          op: 'any',
                          terms: [],
                          ...m.text,
                          in: v as Array<'title' | 'details'>
                        }
                      })
                    }
                  />
                </div>
                <TagInput
                  ariaLabel='Text to look for'
                  placeholder='timeout'
                  value={m.text?.terms ?? []}
                  onChange={(terms) =>
                    onMatch(
                      setKey(
                        m,
                        'text',
                        terms.length
                          ? { op: 'any', in: ['title', 'details'], ...m.text, terms }
                          : undefined
                      )
                    )
                  }
                />
              </FieldRow>
              <details className='group space-y-3'>
                <summary className='inline-flex cursor-pointer list-none items-center gap-1 text-[11.5px] font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-foreground [&::-webkit-details-marker]:hidden'>
                  <ChevronRight className='h-3.5 w-3.5 transition-transform group-open:rotate-90' />
                  More conditions
                </summary>
                <div className='grid gap-3 pt-1 md:grid-cols-2'>
                  {issueKind && (
                    <>
                      <FieldRow label='Routes or screens'>
                        <TagInput
                          ariaLabel='Routes'
                          placeholder='/checkout'
                          value={m.routes ?? []}
                          onChange={(v) => onMatch(setKey(m, 'routes', v))}
                        />
                      </FieldRow>
                      <FieldRow label='Collections'>
                        <TagInput
                          ariaLabel='Collections'
                          value={m.collections ?? []}
                          onChange={(v) => onMatch(setKey(m, 'collections', v))}
                        />
                      </FieldRow>
                      <FieldRow label='Environments'>
                        <TagInput
                          ariaLabel='Environments'
                          placeholder='production'
                          value={m.environments ?? []}
                          onChange={(v) => onMatch(setKey(m, 'environments', v))}
                        />
                      </FieldRow>
                      <FieldRow label='Fingerprints'>
                        <TagInput
                          ariaLabel='Fingerprints'
                          value={m.fingerprints ?? []}
                          onChange={(v) => onMatch(setKey(m, 'fingerprints', v))}
                        />
                      </FieldRow>
                      <FieldRow
                        label='Build'
                        hint='Seen in this build, or first seen in the current one.'
                      >
                        <div className='flex flex-wrap items-center gap-2'>
                          <Input
                            aria-label='Build'
                            value={m.release?.equals ?? ''}
                            placeholder='Any build'
                            onChange={(e) =>
                              onMatch(
                                setKey(
                                  m,
                                  'release',
                                  e.target.value || m.release?.new_in_current
                                    ? { ...m.release, equals: e.target.value || undefined }
                                    : undefined
                                )
                              )
                            }
                            className='h-8 w-40 text-[12px]'
                          />
                          <span className='inline-flex items-center gap-1.5 text-[11.5px] text-slate-600 dark:text-slate-300'>
                            <Switch
                              aria-label='New in the current build'
                              checked={!!m.release?.new_in_current}
                              onCheckedChange={(v) =>
                                onMatch(
                                  setKey(
                                    m,
                                    'release',
                                    v || m.release?.equals
                                      ? { ...m.release, new_in_current: v || undefined }
                                      : undefined
                                  )
                                )
                              }
                            />
                            New in the current build
                          </span>
                        </div>
                      </FieldRow>
                      <FieldRow label='Has a screenshot'>
                        <TriState
                          ariaLabel='Has a screenshot'
                          value={m.has_screenshot}
                          onChange={(v) => onMatch(setKey(m, 'has_screenshot', v))}
                        />
                      </FieldRow>
                      <FieldRow label='Has a replay'>
                        <TriState
                          ariaLabel='Has a replay'
                          value={m.has_replay}
                          onChange={(v) => onMatch(setKey(m, 'has_replay', v))}
                        />
                      </FieldRow>
                    </>
                  )}
                  <FieldRow label='Raised by someone in'>
                    <PickList
                      multi
                      ariaLabel='Raised by role'
                      placeholder='Any role'
                      value={m.raised_by_roles ?? []}
                      options={roleOptions}
                      onChange={(v) => onMatch(setKey(m, 'raised_by_roles', v))}
                    />
                  </FieldRow>
                  <FieldRow label='Assigned in Nivaro'>
                    <ChoiceButtons
                      single
                      ariaLabel='Assigned in Nivaro'
                      value={[m.assigned ?? 'any']}
                      options={[
                        { value: 'any', label: 'Either' },
                        { value: 'assigned', label: 'Assigned' },
                        { value: 'unassigned', label: 'Unassigned' }
                      ]}
                      onChange={(v) =>
                        onMatch(
                          setKey(
                            m,
                            'assigned',
                            v[0] === 'any' ? undefined : (v[0] as RuleMatch['assigned'])
                          )
                        )
                      }
                    />
                  </FieldRow>
                  <FieldRow label='Age in minutes' hint='How long since it was first raised.'>
                    <div className='flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300'>
                      <span>at least</span>
                      <NumberBox
                        optional
                        ariaLabel='At least (minutes old)'
                        placeholder='–'
                        value={m.min_age_minutes}
                        onChange={(n) => onMatch(setKey(m, 'min_age_minutes', n))}
                      />
                      <span>at most</span>
                      <NumberBox
                        optional
                        ariaLabel='At most (minutes old)'
                        placeholder='–'
                        value={m.max_age_minutes}
                        onChange={(n) => onMatch(setKey(m, 'max_age_minutes', n))}
                      />
                    </div>
                  </FieldRow>
                </div>
              </details>
            </Section>

            <Section
              title='Threshold'
              hint='How much it must happen before the rule acts.'
              errors={errorsFor(errors, 'threshold')}
            >
              <ThresholdEditor draft={draft} onThreshold={onThreshold} />
            </Section>

            <Section
              title='Guards'
              hint='Limits that keep a noisy day from filling GitLab.'
              errors={errorsFor(errors, 'guards').concat(errorsFor(errors, 'continue_after'))}
            >
              <div className='flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-slate-700 dark:text-slate-200'>
                <span className='inline-flex items-center gap-2'>
                  At most
                  <NumberBox
                    min={1}
                    max={1000}
                    ariaLabel='At most per hour'
                    value={g.per_hour}
                    onChange={(n) => n !== undefined && onGuards({ per_hour: n })}
                  />
                  an hour
                </span>
                <span className='inline-flex items-center gap-2'>
                  and
                  <NumberBox
                    min={1}
                    max={1000}
                    ariaLabel='At most per day'
                    value={g.per_day}
                    onChange={(n) => n !== undefined && onGuards({ per_day: n })}
                  />
                  a day
                </span>
              </div>
              {issueKind && (
                <SwitchRow
                  label='One GitLab issue per group'
                  hint='Issues grouped as the same problem share one GitLab issue.'
                  checked={g.group}
                  onChange={(v) => onGuards({ group: v })}
                />
              )}
              <FieldRow label='Skip when the status is'>
                <ChoiceButtons
                  ariaLabel='Skip statuses'
                  value={g.skip_statuses}
                  options={opts(statusList)}
                  onChange={(v) => onGuards({ skip_statuses: v })}
                />
              </FieldRow>
              <div className='space-y-2'>
                <SwitchRow
                  label='Quiet hours'
                  hint='Held until the quiet hours end, then sent.'
                  checked={!!g.quiet}
                  onChange={(v) =>
                    onGuards({
                      quiet: v
                        ? {
                            from: '22:00',
                            to: '07:00',
                            days: [0, 1, 2, 3, 4, 5, 6],
                            tz: 'America/New_York'
                          }
                        : undefined
                    })
                  }
                />
                {g.quiet && (
                  <div className='flex flex-wrap items-center gap-2 text-[12px] text-slate-700 dark:text-slate-200'>
                    <span>From</span>
                    <Input
                      type='time'
                      aria-label='Quiet from'
                      value={g.quiet.from}
                      onChange={(e) =>
                        g.quiet && onGuards({ quiet: { ...g.quiet, from: e.target.value } })
                      }
                      className='h-8 w-28 text-[12px] tabular-nums'
                    />
                    <span>to</span>
                    <Input
                      type='time'
                      aria-label='Quiet to'
                      value={g.quiet.to}
                      onChange={(e) =>
                        g.quiet && onGuards({ quiet: { ...g.quiet, to: e.target.value } })
                      }
                      className='h-8 w-28 text-[12px] tabular-nums'
                    />
                    <ChoiceButtons
                      ariaLabel='Quiet days'
                      value={g.quiet.days.map(String)}
                      options={DAYS.map((d, i) => ({ value: String(i), label: d }))}
                      onChange={(v) =>
                        g.quiet &&
                        onGuards({
                          quiet: { ...g.quiet, days: v.map(Number).sort((a, b) => a - b) }
                        })
                      }
                    />
                    <div className='w-56'>
                      <PickList
                        ariaLabel='Time zone'
                        placeholder='Time zone'
                        value={[g.quiet.tz]}
                        options={(tz.includes(g.quiet.tz) ? tz : [g.quiet.tz, ...tz]).map((z) => ({
                          value: z,
                          label: z
                        }))}
                        onChange={(v) =>
                          v[0] && g.quiet && onGuards({ quiet: { ...g.quiet, tz: v[0] } })
                        }
                      />
                    </div>
                  </div>
                )}
              </div>
              <SwitchRow
                label='Let later rules run too'
                hint='Off: once this rule acts, the rules below it are skipped for that one.'
                checked={draft.continue_after}
                onChange={(v) => setDraft((d) => ({ ...d, continue_after: v }))}
              />
            </Section>

            <Section
              title='Action'
              hint='The GitLab issue it opens or suggests.'
              errors={errorsFor(errors, 'action').concat(errorsFor(errors, 'name'))}
            >
              <div className='grid gap-4 md:grid-cols-2'>
                <ModeEditor draft={draft} onAction={onAction} onMode={onMode} />
                <div className='space-y-3'>
                  {connection && (
                    <ProjectEditor
                      draft={draft}
                      onAction={onAction}
                      connection={connection}
                      paths={paths}
                      onPath={(id, p) => setPaths((mp) => new Map(mp).set(id, p))}
                    />
                  )}
                  <FieldRow
                    label='Labels'
                    hint='Added to the connection’s own labels. Values like {{ severity }} work.'
                  >
                    <LabelPicker
                      multi
                      ariaLabel='Labels on the GitLab issue'
                      labels={labels.data}
                      unavailable={labelsUnavailable}
                      value={draft.action.labels}
                      onChange={(v) => onAction({ labels: v })}
                    />
                  </FieldRow>
                </div>
              </div>
              <div className='grid gap-3 md:grid-cols-2'>
                <FieldRow
                  label='Assign in GitLab'
                  hint={assigneeProject == null ? 'Pick a project to list its people.' : undefined}
                >
                  <PickList
                    multi
                    ariaLabel='GitLab assignees'
                    placeholder='Nobody'
                    value={draft.action.assignee_ids}
                    options={[
                      ...(users.data ?? []).map((u) => ({
                        value: u.id,
                        label: u.name,
                        hint: `@${u.username}`
                      })),
                      ...draft.action.assignee_ids
                        .filter((id) => !users.data?.some((u) => u.id === id))
                        .map((id) => ({
                          value: id,
                          label: userNames.get(id) ?? `GitLab user ${id}`
                        }))
                    ]}
                    onSearch={setUserSearch}
                    loading={users.isFetching}
                    onChange={(v) => onAction({ assignee_ids: v })}
                  />
                </FieldRow>
                <div className='flex flex-wrap items-end gap-3 text-[12px]'>
                  <FieldRow label='Milestone id'>
                    <NumberBox
                      optional
                      min={1}
                      ariaLabel='Milestone id'
                      placeholder='–'
                      value={draft.action.milestone_id}
                      onChange={(n) => onAction({ milestone_id: n })}
                      className='w-24'
                    />
                  </FieldRow>
                  <FieldRow label='Due in days'>
                    <NumberBox
                      optional
                      max={3650}
                      ariaLabel='Due in days'
                      placeholder='–'
                      value={draft.action.due_in_days}
                      onChange={(n) => onAction({ due_in_days: n })}
                    />
                  </FieldRow>
                  <FieldRow label='Weight'>
                    <NumberBox
                      optional
                      ariaLabel='Weight'
                      placeholder='–'
                      value={draft.action.weight}
                      onChange={(n) => onAction({ weight: n })}
                    />
                  </FieldRow>
                </div>
              </div>
              <div className='grid gap-x-6 gap-y-2.5 md:grid-cols-2'>
                <SwitchRow
                  label='Assign people by email'
                  hint='The Nivaro assignee, if GitLab has someone with the same email.'
                  checked={draft.action.map_assignee_by_email}
                  onChange={(v) => onAction({ map_assignee_by_email: v })}
                />
                <SwitchRow
                  label='Confidential'
                  checked={draft.action.confidential}
                  onChange={(v) => onAction({ confidential: v })}
                />
                {issueKind && (
                  <>
                    <SwitchRow
                      label='Include the details'
                      hint='The stack or details text, as {{ details }}.'
                      checked={draft.action.include_details}
                      onChange={(v) => onAction({ include_details: v })}
                    />
                    <SwitchRow
                      label='Attach the screenshot'
                      checked={draft.action.attach_screenshot}
                      onChange={(v) => onAction({ attach_screenshot: v })}
                    />
                    <SwitchRow
                      label='Link the replay'
                      checked={draft.action.attach_replay_link}
                      onChange={(v) => onAction({ attach_replay_link: v })}
                    />
                  </>
                )}
              </div>
              <TemplatesEditor draft={draft} onAction={onAction} />
            </Section>
          </div>

          <aside className='rounded-md border border-slate-200 bg-slate-50 p-3 xl:sticky xl:top-4 dark:border-border dark:bg-muted/20'>
            <RulePreview draft={draft} />
          </aside>
        </div>
      </div>

      {/* Footer */}
      {/* pr-16: the floating report-a-problem button sits over the bottom-right corner. */}
      <div className='sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-b-lg border-t border-slate-200 bg-white/95 py-2.5 pl-4 pr-16 backdrop-blur-sm dark:border-border dark:bg-card/95'>
        {rule &&
          (confirmDelete ? (
            <span className='inline-flex items-center gap-2'>
              <span className='text-[11.5px] text-slate-600 dark:text-slate-300'>
                Delete it and its decision log?
              </span>
              <Button
                type='button'
                size='sm'
                variant='destructive'
                className='h-8 text-[12px]'
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {remove.isPending && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
                Delete rule
              </Button>
              <Button
                type='button'
                size='sm'
                variant='ghost'
                className='h-8 text-[12px]'
                onClick={() => setConfirmDelete(false)}
              >
                Keep it
              </Button>
            </span>
          ) : (
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-8 text-[12px] text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-500/10'
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          ))}
        <span className='ml-auto text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {errors?.length
            ? `${errors.length} thing${errors.length === 1 ? '' : 's'} to fix`
            : dirty
              ? 'Unsaved changes'
              : ''}
        </span>
        {dirty ? (
          <ConfirmButton
            title='Cancel'
            confirmLabel='Discard changes?'
            className='inline-flex h-8 items-center rounded-md px-3 text-[12px] font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-slate-200 dark:hover:bg-muted'
            armedClassName={DISCARD_ARMED}
            onConfirm={() => onDone(null)}
          >
            Cancel
          </ConfirmButton>
        ) : (
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='h-8 text-[12px]'
            onClick={() => onDone(null)}
          >
            Cancel
          </Button>
        )}
        <Button
          type='button'
          size='sm'
          className='h-8 gap-1.5 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/90'
          disabled={save.isPending || (!!rule && !dirty)}
          onClick={() => save.mutate()}
        >
          {save.isPending && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
          {rule ? 'Save rule' : 'Add rule'}
        </Button>
      </div>
    </section>
  )
}

function TriState({
  value,
  onChange,
  ariaLabel
}: {
  value: boolean | undefined
  onChange: (v: boolean | undefined) => void
  ariaLabel: string
}) {
  return (
    <ChoiceButtons
      single
      ariaLabel={ariaLabel}
      value={[value === undefined ? 'either' : value ? 'yes' : 'no']}
      options={[
        { value: 'either', label: 'Either' },
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' }
      ]}
      onChange={(v) => onChange(v[0] === 'either' ? undefined : v[0] === 'yes')}
    />
  )
}

/** The save body: empty templates stay empty so the server fills in the kind's default. */
function ruleBodyOf(draft: RuleDraft): Record<string, unknown> {
  return { ...ruleBody(draft), name: draft.name.trim() }
}
